/**
 * The Claude Code harness.
 *
 * Thin by design: the Agent SDK already owns the process, the auth, and the
 * model catalogue, so this mostly declares capabilities and hands sessions to
 * {@link ClaudeSession}.
 *
 * `readLimits` returns null on purpose. Claude Code has no account-usage API we
 * can reach on subscription auth — the ONLY signal is an English sentence at
 * the moment a turn fails, which is parsed per-turn by
 * {@link parseClaudeLimitHit} rather than polled. That asymmetry with Codex is
 * declared via `capabilities.usageLimits: false` so the UI shows a "paused
 * until…" card for Claude and a live meter for Codex, instead of an empty meter
 * for both.
 */
import { listAvailableModels } from "../../services/models.js";
import { claudeRuntime } from "../../services/runtime.js";
import { parseSessionLimit, type ModelOption } from "@dispatch/shared";
import type {
  Harness,
  HarnessCapabilities,
  HarnessLimitHit,
  HarnessLimits,
  HarnessRuntimeInfo,
  HarnessSession,
  HarnessSessionSpec,
} from "../types.js";
import { ClaudeSession, type QueryFn } from "./session.js";

/** Claude Code's capability profile. */
export const CLAUDE_CAPABILITIES: HarnessCapabilities = {
  toolPermissions: true,
  questions: true,
  subagents: true,
  skills: true,
  compaction: true,
  fork: true,
  // No pollable account API on subscription auth — see the module header.
  usageLimits: false,
  liveModelSwitch: true,
  livePermissionSwitch: true,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  preToolGuard: true,
  managerTransport: "in-process",
};

export interface ClaudeHarnessOpts {
  /** Injectable SDK `query` (tests, and the E2E fake). */
  query?: QueryFn;
  genId?: () => string;
}

export class ClaudeHarness implements Harness {
  readonly kind = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly opts: ClaudeHarnessOpts;
  private readonly genId: () => string;

  constructor(opts: ClaudeHarnessOpts = {}) {
    this.opts = opts;
    this.genId = opts.genId ?? (() => Math.random().toString(36).slice(2, 11));
  }

  runtime(): HarnessRuntimeInfo {
    const rt = claudeRuntime;
    return {
      kind: "claude",
      path: rt.path,
      version: rt.version,
      source: rt.source,
      // The SDK ships its own runtime, so Claude is always runnable.
      available: true,
    };
  }

  listModels(opts: { refresh?: boolean } = {}): Promise<ModelOption[]> {
    return listAvailableModels({ refresh: opts.refresh });
  }

  async readLimits(): Promise<HarnessLimits | null> {
    return null;
  }

  createSession(spec: HarnessSessionSpec): HarnessSession {
    return new ClaudeSession({ spec, query: this.opts.query, genId: this.genId });
  }
}

/**
 * Did this turn fail because the subscription window ran out, and when does it
 * reopen?
 *
 * The counterpart of Codex's `usageLimitExceeded` error code — except the only
 * evidence is prose, so it goes through the shared sentence parser. Returns
 * undefined for an ordinary error, which is the signal to render the row as a
 * plain failure rather than a scheduled pause.
 */
export function parseClaudeLimitHit(
  text: string | undefined,
  now: number,
): HarnessLimitHit | undefined {
  const limit = parseSessionLimit(text, now);
  if (!limit) return undefined;
  return { resetsAt: limit.resetsAt, reason: text ?? "Usage limit reached." };
}
