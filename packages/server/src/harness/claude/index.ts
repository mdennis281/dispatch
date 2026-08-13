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
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { listAvailableModels } from "../../services/models.js";
import { claudeExecutableOption, claudeRuntime } from "../../services/runtime.js";
import { parseSessionLimit, type ModelOption } from "@dispatch/shared";
import type {
  Harness,
  HarnessCapabilities,
  HarnessLimitHit,
  HarnessLimits,
  HarnessRuntimeInfo,
  HarnessSession,
  HarnessSessionSpec,
  HarnessTextRequest,
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

/** Titles never justify spending a full-size Claude model. */
const CLAUDE_TITLE_MODEL = "claude-haiku-4-5";

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

  async generateText(request: HarnessTextRequest): Promise<string> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), request.timeoutMs ?? 60_000);
    const query = this.opts.query ?? sdkQuery;
    let text = "";
    let result = "";
    try {
      const stream = query({
        prompt: request.prompt,
        options: {
          model: CLAUDE_TITLE_MODEL,
          settingSources: [],
          maxTurns: 1,
          abortController: abort,
          ...claudeExecutableOption(),
        },
      });
      for await (const raw of stream) {
        const msg = raw as SDKMessage & Record<string, unknown>;
        if (msg.type === "assistant") {
          const content = (msg as unknown as { message?: { content?: unknown } }).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
                text += String((block as { text?: unknown }).text ?? "");
              }
            }
          }
        } else if (msg.type === "result" && typeof msg.result === "string") {
          result = msg.result;
        }
      }
    } catch (err) {
      const partial = text.trim() || result.trim();
      if (partial) return partial;
      if (abort.signal.aborted) {
        throw new Error(`timed out after ${Math.round((request.timeoutMs ?? 60_000) / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return text.trim() || result.trim();
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
