/**
 * The Codex harness.
 *
 * Owns everything runtime-specific about driving `codex app-server`: finding
 * the binary, the shared connection, the model catalogue, account rate limits,
 * and session creation. The broker sees only {@link Harness}.
 *
 * MODELS AND LIMITS ARE FIRST-CLASS HERE, not bolted on. Codex reports both
 * over the same connection that runs sessions, which is strictly better than
 * the Claude side: the model list is auth-aware with per-model effort support,
 * and rate limits arrive as live percentages with exact reset timestamps rather
 * than an English sentence at the moment of failure.
 */
import {
  fallbackModels,
  type Effort,
  type ModelOption,
} from "@dispatch/shared";
import type {
  Harness,
  HarnessCapabilities,
  HarnessLimits,
  HarnessRuntimeInfo,
  HarnessSession,
  HarnessSessionSpec,
} from "../types.js";
import { codexRuntime } from "./runtime.js";
import { acquireCodexConnection, type CodexConnection } from "./rpc.js";
import { CodexSession } from "./session.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
/** Cap on catalogue/limit probes so a wedged app server can't pin a request. */
const PROBE_TIMEOUT_MS = 25_000;

/** Codex's capability profile. See {@link HarnessCapabilities} for each field. */
export const CODEX_CAPABILITIES: HarnessCapabilities = {
  // Codex asks about commands, file changes and permission escalations — not
  // about every individual tool the way `canUseTool` does.
  toolPermissions: false,
  questions: true,
  // Codex has multi-agent collaboration, but not Dispatch-authored agent
  // definitions with their own prompt/model/effort.
  subagents: false,
  skills: true,
  compaction: true,
  fork: true,
  usageLimits: true,
  liveModelSwitch: true,
  livePermissionSwitch: true,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  // No host-side pre-tool callback; see CodexSession's module header for what
  // the workflow guard degrades to.
  preToolGuard: false,
  // Codex only reaches MCP servers over stdio or streamable HTTP, so Dispatch's
  // own tools are served from services/mcp/manager-http.ts rather than passed
  // in-process the way the Agent SDK accepts them.
  managerTransport: "http",
};

export interface CodexHarnessOpts {
  /** Injectable runtime resolution (tests). */
  runtime?: HarnessRuntimeInfo;
  /** Injectable connection factory (tests). */
  acquire?: typeof acquireCodexConnection;
  genId?: () => string;
  now?: () => number;
  /** Extra thread config merged into every `thread/start`. */
  threadConfig?: Record<string, unknown>;
  onStderr?: (line: string) => void;
}

export class CodexHarness implements Harness {
  readonly kind = "codex" as const;
  readonly capabilities = CODEX_CAPABILITIES;

  private readonly opts: CodexHarnessOpts;
  private readonly acquire: typeof acquireCodexConnection;
  private readonly genId: () => string;
  private readonly now: () => number;

  private modelCache?: { at: number; models: ModelOption[] };
  private modelProbe?: Promise<ModelOption[] | null>;
  /** Per-model effort support, learned from the catalogue. */
  private efforts = new Map<string, string[]>();
  private limitsCache?: HarnessLimits | null;

  constructor(opts: CodexHarnessOpts = {}) {
    this.opts = opts;
    this.acquire = opts.acquire ?? acquireCodexConnection;
    this.genId = opts.genId ?? (() => Math.random().toString(36).slice(2, 11));
    this.now = opts.now ?? (() => Date.now());
  }

  runtime(): HarnessRuntimeInfo {
    return this.opts.runtime ?? codexRuntime();
  }

  /** Borrow the shared connection, or throw when Codex isn't installed. */
  private connect(): { conn: CodexConnection; release: () => void } {
    const rt = this.runtime();
    if (!rt.available || !rt.path) {
      throw new Error(
        "Codex is not installed. Install the Codex CLI, or set DISPATCH_CODEX_PATH to its binary.",
      );
    }
    return this.acquire({ exePath: rt.path, onStderr: this.opts.onStderr });
  }

  /** Reject once `ms` elapses so an unresponsive runtime can't pin a request. */
  private withTimeout<T>(p: Promise<T>, ms = PROBE_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("codex probe timed out")), ms);
      (timer as unknown as { unref?: () => void }).unref?.();
      p.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  async listModels(opts: { refresh?: boolean } = {}): Promise<ModelOption[]> {
    if (!opts.refresh && this.modelCache && this.now() - this.modelCache.at < CACHE_TTL_MS) {
      return this.modelCache.models;
    }
    this.modelProbe ??= this.probeModels().finally(() => {
      this.modelProbe = undefined;
    });
    const models = await this.modelProbe;
    // Never throw: a picker with a stale list beats a picker that errored.
    if (!models) return this.modelCache?.models ?? fallbackModels("codex");
    this.modelCache = { at: this.now(), models };
    return models;
  }

  private async probeModels(): Promise<ModelOption[] | null> {
    let held: { conn: CodexConnection; release: () => void } | undefined;
    try {
      held = this.connect();
      const res = await this.withTimeout(
        held.conn.call<{ data?: CodexModel[] }>("model/list", { limit: 100 }),
      );
      const data = res.data ?? [];
      if (!data.length) return null;
      this.efforts = new Map(
        data.map((m) => [
          m.id,
          (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).filter(Boolean),
        ]),
      );
      return data.filter((m) => !m.hidden).map((m) => toModelOption(m));
    } catch {
      return null;
    } finally {
      held?.release();
    }
  }

  /** Efforts a model accepts, for clamping at turn start. */
  supportedEfforts(model: string | undefined): string[] {
    if (!model) return [];
    return this.efforts.get(model) ?? [];
  }

  async readLimits(): Promise<HarnessLimits | null> {
    let held: { conn: CodexConnection; release: () => void } | undefined;
    try {
      held = this.connect();
      const res = await this.withTimeout(
        held.conn.call<{ rateLimits?: CodexRateLimitSnapshot }>("account/rateLimits/read", undefined),
      );
      this.limitsCache = res.rateLimits ? toHarnessLimits(res.rateLimits) : null;
      return this.limitsCache;
    } catch {
      return this.limitsCache ?? null;
    } finally {
      held?.release();
    }
  }

  createSession(spec: HarnessSessionSpec): HarnessSession {
    const held = this.connect();
    // Keep the account snapshot warm so a usage-limit turn end can carry an
    // exact reset time without a blocking round trip at the worst moment.
    held.conn.onGlobal((frame) => {
      if (frame.method !== "account/rateLimits/updated") return;
      const snap = (frame.params as { rateLimits?: CodexRateLimitSnapshot } | undefined)?.rateLimits;
      if (snap) this.limitsCache = toHarnessLimits(snap);
    });
    return new CodexSession({
      spec,
      conn: held.conn,
      release: held.release,
      genId: this.genId,
      supportedEfforts: (m) => this.supportedEfforts(m),
      limitsSnapshot: () => this.limitsCache ?? null,
      threadConfig: this.opts.threadConfig,
    });
  }
}

/* ------------------------------------------------------------ projections */

interface CodexModel {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
}

interface CodexRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface CodexRateLimitSnapshot {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
  spendControlReached?: boolean | null;
}

/**
 * Codex `Model` → the picker's row.
 *
 * Codex has no "default" alias the way Claude Code does — it flags one row
 * `isDefault` instead — so the hint is synthesized rather than special-cased on
 * a magic id.
 */
export function toModelOption(m: CodexModel): ModelOption {
  return {
    value: m.id,
    label: m.displayName || m.id,
    hint: m.isDefault ? "recommended" : undefined,
    resolvedModel: m.model && m.model !== m.id ? m.model : undefined,
    description: m.description || undefined,
  };
}

/** Codex `RateLimitSnapshot` → the neutral shape. */
export function toHarnessLimits(s: CodexRateLimitSnapshot): HarnessLimits {
  const win = (w: CodexRateLimitWindow | null | undefined) =>
    w
      ? {
          usedPercent: typeof w.usedPercent === "number" ? w.usedPercent : undefined,
          windowMinutes: typeof w.windowDurationMins === "number" ? w.windowDurationMins : undefined,
          // Codex reports seconds; the rest of Dispatch works in epoch ms.
          resetsAt: typeof w.resetsAt === "number" ? w.resetsAt * 1000 : undefined,
        }
      : undefined;
  return {
    primary: win(s.primary),
    secondary: win(s.secondary),
    planType: s.planType ?? undefined,
    reached: Boolean(s.rateLimitReachedType) || Boolean(s.spendControlReached),
    reachedType: s.rateLimitReachedType ?? undefined,
  };
}

/** The effort ladder Codex accepts, for the composer. */
export const CODEX_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
