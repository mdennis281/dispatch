/**
 * The Claude Code harness.
 *
 * Thin by design: the Agent SDK already owns the process, the auth, and the
 * model catalogue, so this mostly declares capabilities and hands sessions to
 * {@link ClaudeSession}.
 *
 * SELF-CONTAINED on purpose: nothing in this directory imports the host
 * (`services/`, `config`, the broker). It is on its way out into a provider
 * plugin (#422), and a plugin can only reach `@dispatch/shared`. Everything
 * Claude-specific the host used to do by name — the OAuth usage poll, the
 * `claude auth status` probe, the runtime and model catalogue — lives here and
 * is reached through the `Harness` interface.
 *
 * Limits come two ways: polled from the OAuth usage endpoint
 * ({@link ClaudeUsage}, behind `readLimits`), and the English sentence a turn
 * fails with, parsed onto the turn-end by the stream decoder
 * ({@link parseClaudeLimitHit}).
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  HarnessAccount,
  Harness,
  HarnessCapabilities,
  HarnessLimitReadOpts,
  HarnessLimits,
  HarnessRuntimeInfo,
  HarnessSession,
  HarnessSessionSpec,
  HarnessTextRequest,
  ModelOption,
  RuntimeLoginStatus,
} from "@dispatch/shared";
import { cachedContextWindow, listAvailableModels, listContextWindows } from "./models.js";
import { claudeExecutable, claudeExecutableOption, claudeRuntime } from "./runtime.js";
import { envWithAccount, transferClaudeSession } from "./account.js";
import { probeClaudeLogin, type RunLoginProbe } from "./login.js";
import { ClaudeUsage } from "./usage.js";
import { ClaudeSession, type QueryFn } from "./session.js";

export { parseClaudeLimitHit } from "./limit-hit.js";

/** Claude Code's capability profile. */
export const CLAUDE_CAPABILITIES: HarnessCapabilities = {
  toolPermissions: true,
  questions: true,
  subagents: true,
  skills: true,
  compaction: true,
  // `/compact` and `/clear` are slash commands the CLI answers like a message.
  controlTurns: true,
  fork: true,
  // The OAuth usage endpoint, polled through `readLimits` (see `usage.ts`).
  usageLimits: true,
  liveModelSwitch: true,
  // Its own trigger reads contextTokenLimit, fixed at spawn.
  nativeContextLimit: true,
  livePermissionSwitch: true,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  preToolGuard: true,
  // PreToolUse reports the real tool name, `mcp__server__tool` included.
  guardsMcpToolNames: true,
  managerTransport: "in-process",
};

export interface ClaudeHarnessOpts {
  /** Injectable SDK `query` (tests, and the E2E fake). */
  query?: QueryFn;
  genId?: () => string;
  /** Injectable usage pollers (tests; the E2E instance must not reach Anthropic). */
  usage?: ClaudeUsage;
  /** Injectable `claude auth status` runner (tests). */
  runLoginProbe?: RunLoginProbe;
}

/** Titles and commit messages never justify spending a full-size Claude model. */
const CLAUDE_TEXT_MODEL = "claude-haiku-4-5";

export class ClaudeHarness implements Harness {
  readonly kind = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly opts: ClaudeHarnessOpts;
  private readonly genId: () => string;
  private readonly usage: ClaudeUsage;

  constructor(opts: ClaudeHarnessOpts = {}) {
    this.opts = opts;
    this.genId = opts.genId ?? (() => Math.random().toString(36).slice(2, 11));
    this.usage = opts.usage ?? new ClaudeUsage();
  }

  runtime(): HarnessRuntimeInfo {
    const rt = claudeRuntime();
    return {
      kind: "claude",
      // The file a spawn runs, the SDK's bundled binary included — so the login
      // probe asks the binary every chat will use without the host having to
      // know where the SDK keeps it.
      path: claudeExecutable(),
      version: rt.version,
      source: rt.source,
      // The SDK ships its own runtime, so Claude is always runnable.
      available: true,
    };
  }

  probeLogin(exe: string, env: Readonly<Record<string, string | undefined>>): Promise<RuntimeLoginStatus> {
    return probeClaudeLogin(exe, env, this.opts.runLoginProbe);
  }

  listModels(opts: { refresh?: boolean; account?: HarnessAccount } = {}): Promise<ModelOption[]> {
    return listAvailableModels({ refresh: opts.refresh, account: opts.account });
  }

  contextWindows(opts: { refresh?: boolean; account?: HarnessAccount } = {}): Promise<Record<string, number>> {
    return listContextWindows({ refresh: opts.refresh, account: opts.account });
  }

  /**
   * The window from the per-model probe's CACHE only, never a fresh probe: the
   * broker awaits this at session start, and a cold probe is a step per model
   * (tens of seconds). A miss is fine — the session reads the real window from
   * the CLI the moment it is live and reports it as a `usage` event.
   */
  async contextWindow(opts: { model?: string; account?: HarnessAccount } = {}): Promise<number | undefined> {
    return opts.model ? cachedContextWindow(opts.model, opts.account) : undefined;
  }

  transferSession(sessionId: string, from: HarnessAccount, to: HarnessAccount): Promise<boolean> {
    return transferClaudeSession(sessionId, from.configDir, to.configDir);
  }

  async readLimits(account?: HarnessAccount, opts: HarnessLimitReadOpts = {}): Promise<HarnessLimits | null> {
    const poller = this.usage.for(account);
    return opts.fresh ? poller.fresh() : poller.cached();
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
          model: CLAUDE_TEXT_MODEL,
          settingSources: [],
          maxTurns: 1,
          abortController: abort,
          ...claudeExecutableOption(),
          ...(envWithAccount(request.account) ? { env: envWithAccount(request.account) } : {}),
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
