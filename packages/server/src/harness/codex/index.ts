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
  HarnessAccount,
  HarnessCapabilities,
  HarnessLimits,
  HarnessRuntimeInfo,
  HarnessSession,
  HarnessSessionSpec,
  HarnessTextRequest,
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

  /** Keyed by account (see `accountKey`) — a plan decides which models a login gets. */
  private modelCache = new Map<string, { at: number; models: ModelOption[] }>();
  private modelProbe = new Map<string, Promise<ModelOption[] | null>>();
  /** Per-model effort support, learned from the catalogue. */
  private efforts = new Map<string, string[]>();
  /** Keyed by account: limits belong to a login, not to the provider. */
  private limitsCache = new Map<string, HarnessLimits | null>();

  constructor(opts: CodexHarnessOpts = {}) {
    this.opts = opts;
    this.acquire = opts.acquire ?? acquireCodexConnection;
    this.genId = opts.genId ?? (() => Math.random().toString(36).slice(2, 11));
    this.now = opts.now ?? (() => Date.now());
  }

  runtime(): HarnessRuntimeInfo {
    return this.opts.runtime ?? codexRuntime();
  }

  /** Borrow the shared connection for an account, or throw when Codex isn't installed. */
  private connect(account?: HarnessAccount): { conn: CodexConnection; release: () => void } {
    const rt = this.runtime();
    if (!rt.available || !rt.path) {
      throw new Error(
        "Codex is not installed. Install the Codex CLI, or set DISPATCH_CODEX_PATH to its binary.",
      );
    }
    return this.acquire({
      exePath: rt.path,
      onStderr: this.opts.onStderr,
      ...(account && Object.keys(account.env).length ? { env: account.env } : {}),
    });
  }

  /** Reject once `ms` elapses so an unresponsive runtime can't pin a request. */
  private withTimeout<T>(p: Promise<T>, ms = PROBE_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("codex probe timed out")), ms);
      (timer as unknown as { unref?: () => void }).unref?.();
      p.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  async listModels(
    opts: { refresh?: boolean; account?: HarnessAccount } = {},
  ): Promise<ModelOption[]> {
    const key = accountKey(opts.account);
    const hit = this.modelCache.get(key);
    if (!opts.refresh && hit && this.now() - hit.at < CACHE_TTL_MS) return hit.models;
    let probe = this.modelProbe.get(key);
    if (!probe) {
      probe = this.probeModels(opts.account).finally(() => this.modelProbe.delete(key));
      this.modelProbe.set(key, probe);
    }
    const models = await probe;
    // Never throw: a picker with a stale list beats a picker that errored.
    if (!models) return this.modelCache.get(key)?.models ?? fallbackModels("codex");
    this.modelCache.set(key, { at: this.now(), models });
    return models;
  }

  private async probeModels(account?: HarnessAccount): Promise<ModelOption[] | null> {
    let held: { conn: CodexConnection; release: () => void } | undefined;
    try {
      held = this.connect(account);
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

  async readLimits(account?: HarnessAccount): Promise<HarnessLimits | null> {
    const key = accountKey(account);
    let held: { conn: CodexConnection; release: () => void } | undefined;
    try {
      held = this.connect(account);
      const res = await this.withTimeout(
        held.conn.call<{ rateLimits?: CodexRateLimitSnapshot }>("account/rateLimits/read", undefined),
      );
      const limits = res.rateLimits ? toHarnessLimits(res.rateLimits) : null;
      this.limitsCache.set(key, limits);
      return limits;
    } catch {
      return this.limitsCache.get(key) ?? null;
    } finally {
      held?.release();
    }
  }

  async generateText(request: HarnessTextRequest): Promise<string> {
    // Provider-owned model choice is the point of this seam: TitleService does
    // not need to know that Codex has concrete ids while Claude has aliases.
    const models = await this.listModels({ account: request.account });
    const model = models.find((m) => m.hint === "fast")?.value;
    const held = this.connect(request.account);
    let threadId: string | undefined;
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const opened = await held.conn.call<{ thread?: { id?: string } }>("thread/start", {
        model,
        approvalPolicy: "never",
        sandbox: "read-only",
        // A title must not appear in the user's Codex history or inherit a
        // project's agent instructions. It is a completion, not a chat.
        ephemeral: true,
        environments: [],
        dynamicTools: [],
        baseInstructions:
          "Return only the requested text. Do not use tools, inspect files, or explain your answer.",
      });
      threadId = opened.thread?.id;
      if (!threadId) throw new Error("codex returned a title thread with no id");

      let text = "";
      const completed = new Promise<string>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${Math.round((request.timeoutMs ?? 60_000) / 1000)}s`)),
          request.timeoutMs ?? 60_000,
        );
        off = held.conn.onThread(threadId!, (frame) => {
          const params = (frame.params ?? {}) as Record<string, unknown>;
          if (frame.method === "item/completed") {
            const item = params.item as Record<string, unknown> | undefined;
            if (item?.type === "agentMessage" && typeof item.text === "string") text += item.text;
          } else if (frame.method === "turn/completed") {
            const turn = params.turn as Record<string, unknown> | undefined;
            const status = String(turn?.status ?? "completed");
            if (status === "completed") resolve(text.trim());
            else {
              const error = turn?.error as { message?: unknown } | undefined;
              reject(new Error(typeof error?.message === "string" ? error.message : status));
            }
          } else if (frame.method === "error" && !params.willRetry) {
            const error = params.error as { message?: unknown } | undefined;
            reject(new Error(typeof error?.message === "string" ? error.message : "Codex error"));
          }
        });
      });

      await held.conn.call("turn/start", {
        threadId,
        input: [{ type: "text", text: request.prompt, text_elements: [] }],
        model,
        effort: "low",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
        environments: [],
      });
      return await completed;
    } finally {
      if (timer) clearTimeout(timer);
      off?.();
      if (threadId) {
        await held.conn.call("thread/unsubscribe", { threadId }).catch(() => {});
      }
      held.release();
    }
  }

  createSession(spec: HarnessSessionSpec): HarnessSession {
    const key = accountKey(spec.account);
    const held = this.connect(spec.account);
    // Keep the account snapshot warm so a usage-limit turn end can carry an
    // exact reset time without a blocking round trip at the worst moment.
    held.conn.onGlobal((frame) => {
      if (frame.method !== "account/rateLimits/updated") return;
      const snap = (frame.params as { rateLimits?: CodexRateLimitSnapshot } | undefined)?.rateLimits;
      if (snap) this.limitsCache.set(key, toHarnessLimits(snap));
    });
    return new CodexSession({
      spec,
      conn: held.conn,
      release: held.release,
      genId: this.genId,
      supportedEfforts: (m) => this.supportedEfforts(m),
      limitsSnapshot: () => this.limitsCache.get(key) ?? null,
      threadConfig: this.opts.threadConfig,
    });
  }
}

/** The cache key for an account: "" for the default, so both spellings share. */
function accountKey(account: HarnessAccount | undefined): string {
  return account?.env.CODEX_HOME ?? "";
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
