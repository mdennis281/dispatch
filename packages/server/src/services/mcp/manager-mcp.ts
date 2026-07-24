/**
 * manager-mcp — the in-process "manager" SDK MCP server.
 *
 * Registered on EVERY live session (see `SessionBroker.buildOptions` →
 * `Options.mcpServers.manager`), so its tools appear to the agent as
 * `mcp__manager__<tool>`. It lets a chat pace ITSELF against the manager's own
 * state:
 *
 *   - `mcp__manager__wait({ seconds, reason? })` — sleep for up to
 *     {@link WAIT_CAP_SECONDS}. While parked it publishes a `chat-status`
 *     "waiting Ns: <reason>" activity so the UI shows the self-imposed pause
 *     (reusing the working/typing header mechanism).
 *   - `mcp__manager__wait_for_chat({ chatId, timeoutSeconds? })` — block until
 *     ANOTHER chat's broker state reaches a terminal state (idle/done/error),
 *     or the timeout fires. Returns the final state. An unknown chatId yields an
 *     informative (error-flagged) result rather than throwing.
 *   - `mcp__manager__watch_pr({ number, repo?, timeoutSeconds? })` — watch a
 *     GitHub PR (via {@link ManagerMcpGitHub}, reusing GitHubService's `gh`) and
 *     RETURN THE INSTANT it needs attention: a CI check fails, a new review
 *     thread/comment appears, or it merges/closes. Per-session dedup state means
 *     each new signal is reported exactly once, so an agent calling it in a loop
 *     (fix → watch again) never misses a later round of review comments and never
 *     hand-rolls a `gh pr view` / `gh pr checks` sleep loop or a background watcher.
 *
 * Every handler awaits a REAL promise (a `setTimeout`, a poll `setInterval`,
 * and/or a `chat-status` bus subscription) and unwinds cleanly the instant the
 * owning session aborts
 * (stop/fork) — every timer + listener is cleared on the first settle. This is
 * the reusable in-process-MCP pattern the later Batch-6 features build on: a
 * per-session factory closed over `{ chatId, bus, broker, signal }`.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import {
  MemoryTypeSchema,
  type ChatStatus,
  type CheckRun,
  type ContextUsage,
  type ProjectMemory,
  type ReviewThread,
} from "@cm/shared";
import type { EventBus } from "../../bus.js";
import { clampBody } from "../memory.js";

/** Hard ceiling on a single `wait` (also the default `wait_for_chat` timeout). */
export const WAIT_CAP_SECONDS = 3600;

/** How often `watch_pr` re-polls a PR's checks / review threads / merge state. */
export const PR_POLL_INTERVAL_MS = 20_000;

/**
 * Default per-call `watch_pr` timeout (30 min); still capped at
 * {@link WAIT_CAP_SECONDS}. The agent re-calls after each returned batch, so the
 * effective watch is unbounded — this only bounds a single quiet poll window.
 */
export const WATCH_PR_DEFAULT_TIMEOUT_SECONDS = 1800;

/**
 * Check conclusions that count as a FAILING check for `watch_pr` — the ones an
 * agent must react to (a red build, a required check it must satisfy). `neutral`,
 * `skipped`, and `success` are not actionable.
 */
const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "action_required",
  "cancelled",
  "stale",
]);

/** Broker states that end `wait_for_chat` (the target turn/session is at rest). */
const TERMINAL_STATES: ReadonlySet<ChatStatus> = new Set<ChatStatus>([
  "idle",
  "done",
  "error",
]);

/** The narrow broker surface the manager MCP needs (kept decoupled for tests). */
export interface ManagerMcpBroker {
  /** Is a live session registered for this chat? */
  has(chatId: string): boolean;
  /** Current broker state of a chat's session, if any. */
  getStatus(chatId: string): ChatStatus | undefined;
  /** Live context-window breakdown for a chat (null when not live / unsupported). */
  getContextUsage(chatId: string): Promise<ContextUsage | null>;
  /** Compact a chat's context in place (native SDK `/compact`). */
  compact(chatId: string): void;
  /** Flag that a `watch_pr` on this chat hit a terminal PR state (drives the green "PR done" dot). */
  markPrWatched(chatId: string): void;
}

/**
 * The narrow terminal surface the manager MCP needs — a single `run` that
 * executes a command in a named PERSISTENT shell (cwd/env survive across calls),
 * already bound to this session's chat + default cwd by the broker.
 */
export interface ManagerMcpTerminals {
  run(args: {
    name: string;
    command: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{
    output: string;
    exitCode: number | null;
    cwd: string;
    error?: string;
    timedOut?: boolean;
  }>;
}

/**
 * The narrow project-memory surface the manager MCP needs — already bound to the
 * session's project by the broker, so the agent just names the fact. Omitted when
 * the session has no project (then the `remember` / `recall` / `forget` tools
 * aren't offered).
 */
export interface ManagerMcpMemory {
  remember(input: {
    name: string;
    description: string;
    type: "user" | "feedback" | "project" | "reference";
    body: string;
  }): Promise<ProjectMemory>;
  recall(
    query?: string,
    opts?: { type?: "user" | "feedback" | "project" | "reference" },
  ): Promise<{ index: string; matches: ProjectMemory[] }>;
  forget(name: string): Promise<boolean>;
  /**
   * Pre-existing memories that closely resemble a `remember` candidate — powers
   * the dedup nudge (consolidate instead of accumulating a second copy). Bound to
   * the session's project by the broker. Best-effort; may be omitted on older
   * wiring, so callers must treat it as optional.
   */
  findSimilar?(candidate: {
    name: string;
    description?: string;
    body?: string;
  }): Promise<Array<{ name: string; description: string; similarity: number }>>;
}

/** Merge/close-state view of a PR the `watch_pr` tool polls on. */
export interface PrPollResult {
  number: number;
  state: "open" | "closed" | "merged";
  merged: boolean;
  mergedAt?: string;
}

/**
 * The narrow GitHub surface the manager MCP needs to watch a PR — its merge/close
 * state, its CI checks, and its review threads — already bound to this session's
 * default repo (its worktree cwd, else the project root) by the broker. `repo` is
 * an optional `owner/name` override.
 *
 * `prMergeState` null = the PR/repo couldn't be resolved (unknown PR / gh error)
 * and ENDS the watch as an error. `prChecks`/`reviewThreads` null = that signal
 * couldn't be read THIS poll (a transient gh hiccup); the watch treats it as "no
 * new activity of that kind" and keeps going rather than aborting. Omitted from
 * the ctx → the `watch_pr` tool isn't offered.
 */
export interface ManagerMcpGitHub {
  prMergeState(prNumber: number, repo?: string): Promise<PrPollResult | null>;
  prChecks(prNumber: number, repo?: string): Promise<CheckRun[] | null>;
  reviewThreads(prNumber: number, repo?: string): Promise<ReviewThread[] | null>;
}

/** A launched subApp runner, as surfaced to the agent. */
export interface ManagerMcpRunnerState {
  subAppId: string;
  status: string;
  url?: string;
  branch?: string;
  port?: number;
}

/** SubApp launcher for this session's project (omitted → no `run_subapp` tool). */
export interface ManagerMcpRunner {
  /** SubApps, live runners, and branches for this session's project. */
  overview(chatId: string): Promise<{
    subApps: { id: string; name: string; ports?: number[] }[];
    running: ManagerMcpRunnerState[];
    branches: { name: string; current: boolean; hasWorktree: boolean }[];
  }>;
  /** Launch a subApp on a branch (default: the project's current branch). */
  launch(input: {
    chatId: string;
    subAppId: string;
    branch?: string;
  }): Promise<ManagerMcpRunnerState>;
  /** Stop a subApp's running instance (optionally scoped to a branch). */
  stop(input: { chatId: string; subAppId: string; branch?: string }): Promise<boolean>;
}

/** Per-session context the factory closes over. */
export interface ManagerMcpContext {
  /** The chat this session drives (for the waiting status label). */
  chatId: string;
  bus: EventBus;
  broker: ManagerMcpBroker;
  /** Persistent-terminal runner for this session (omitted → no `terminal` tool). */
  terminals?: ManagerMcpTerminals;
  /** Project-memory runner for this session (omitted → no memory tools). */
  memory?: ManagerMcpMemory;
  /** GitHub PR watcher for this session (omitted → no `watch_pr` tool). */
  github?: ManagerMcpGitHub;
  /** SubApp launcher for this session (omitted → no `run_subapp` tool). */
  runner?: ManagerMcpRunner;
  /** The session's abort signal — cancels in-flight waits on stop/fork. */
  signal?: AbortSignal;
  now?: () => number;
}

/* ------------------------------------------------------------------ helpers */

function clampSeconds(value: unknown, cap: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.min(Math.max(n, 0), cap);
}

/** Pull an AbortSignal out of the MCP handler's `extra` arg, if present. */
function extraSignal(extra: unknown): AbortSignal | undefined {
  const sig = (extra as { signal?: unknown } | undefined)?.signal;
  return sig instanceof AbortSignal ? sig : undefined;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

/**
 * Sleep `ms`, resolving `"elapsed"` on completion or `"aborted"` if any of the
 * supplied signals fires first. Every timer/listener is torn down on settle, so
 * an aborting session never strands a timer.
 */
function sleep(
  ms: number,
  signals: (AbortSignal | undefined)[],
): Promise<"elapsed" | "aborted"> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanups: (() => void)[] = [];
    const finish = (r: "elapsed" | "aborted"): void => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      resolve(r);
    };
    const timer = setTimeout(() => finish("elapsed"), ms);
    cleanups.push(() => clearTimeout(timer));
    for (const sig of signals) {
      if (!sig) continue;
      if (sig.aborted) {
        finish("aborted");
        return;
      }
      const onAbort = (): void => finish("aborted");
      sig.addEventListener("abort", onAbort);
      cleanups.push(() => sig.removeEventListener("abort", onAbort));
    }
  });
}

interface WaitForChatOutcome {
  finalState: ChatStatus | "unknown";
  timedOut: boolean;
  aborted: boolean;
}

/**
 * Resolve when `chatId` reaches a terminal broker state, its timeout fires, or a
 * signal aborts. Subscribes to `chat-status` BEFORE reading the current status
 * so a transition that lands between the two can't be missed.
 */
function waitForChatState(
  ctx: ManagerMcpContext,
  chatId: string,
  timeoutMs: number,
  signals: (AbortSignal | undefined)[],
): Promise<WaitForChatOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanups: (() => void)[] = [];
    const finish = (r: WaitForChatOutcome): void => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      resolve(r);
    };

    const off = ctx.bus.on("chat-status", (e) => {
      if (e.chatId !== chatId) return;
      if (TERMINAL_STATES.has(e.status)) {
        finish({ finalState: e.status, timedOut: false, aborted: false });
      }
    });
    cleanups.push(off);

    const timer = setTimeout(() => {
      finish({
        finalState: ctx.broker.getStatus(chatId) ?? "unknown",
        timedOut: true,
        aborted: false,
      });
    }, timeoutMs);
    cleanups.push(() => clearTimeout(timer));

    for (const sig of signals) {
      if (!sig) continue;
      if (sig.aborted) {
        finish({ finalState: "unknown", timedOut: false, aborted: true });
        return;
      }
      const onAbort = (): void =>
        finish({ finalState: "unknown", timedOut: false, aborted: true });
      sig.addEventListener("abort", onAbort);
      cleanups.push(() => sig.removeEventListener("abort", onAbort));
    }

    // Already at rest? Resolve now (subscribe-first guarantees no missed edge).
    const cur = ctx.broker.getStatus(chatId);
    if (cur && TERMINAL_STATES.has(cur)) {
      finish({ finalState: cur, timedOut: false, aborted: false });
    }
  });
}

/** One reportable change `watch_pr` surfaces to the agent. */
export type WatchPrEvent =
  | { type: "ci-failed"; name: string; conclusion?: string; url?: string }
  | {
      type: "review-comment";
      threadId: string;
      path?: string;
      line?: number | null;
      author?: string;
      body?: string;
    };

/**
 * Per-(session, PR) dedup memory so each failing check and each review thread is
 * reported to the agent exactly ONCE. `checks` maps a check name → the last
 * conclusion/status we reported for it (so a red build fires once, and a
 * pass→fail flip re-fires); `threads` holds the ids of review threads already
 * surfaced. Held in the session-scoped factory closure, it survives across the
 * agent's repeated `watch_pr` calls — which is exactly what stops the "fixed the
 * comments, then went silent on the next round" failure mode.
 */
export interface WatchPrState {
  checks: Map<string, string>;
  threads: Set<string>;
}

type WatchPrOutcome =
  | { kind: "activity"; state: PrPollResult; events: WatchPrEvent[] }
  | { kind: "terminal"; state: PrPollResult }
  | { kind: "timeout"; state: PrPollResult }
  | { kind: "aborted" }
  | { kind: "error"; error: string };

/**
 * Poll a PR every `intervalMs` and RESOLVE the instant it needs the agent: a new
 * failing check, a new unresolved review thread, or a merge/close. Polls
 * immediately first (so a PR already carrying unaddressed activity returns with
 * zero wait), dedups against `st` so nothing already-handled re-fires, and quits
 * on abort or `timeoutMs`. A null merge-state read ends the watch as an error; a
 * transient null checks/threads read is treated as "nothing new this poll" so one
 * flaky `gh` call never aborts a long watch.
 */
async function watchForPrActivity(
  gh: ManagerMcpGitHub,
  number: number,
  repo: string | undefined,
  st: WatchPrState,
  opts: {
    intervalMs: number;
    timeoutMs: number;
    signals: (AbortSignal | undefined)[];
    now: () => number;
  },
): Promise<WatchPrOutcome> {
  const deadline = opts.now() + opts.timeoutMs;
  const aborted = (): boolean => opts.signals.some((s) => s?.aborted);

  for (;;) {
    if (aborted()) return { kind: "aborted" };

    let merge: PrPollResult | null;
    try {
      merge = await gh.prMergeState(number, repo);
    } catch (err) {
      return { kind: "error", error: err instanceof Error ? err.message : String(err) };
    }
    if (aborted()) return { kind: "aborted" };
    if (merge === null) {
      return {
        kind: "error",
        error: "PR not found (unknown number or the repo could not be resolved)",
      };
    }
    if (merge.state === "merged" || merge.state === "closed") {
      return { kind: "terminal", state: merge };
    }

    // Checks + threads are best-effort: a transient gh failure on either yields
    // null, which we treat as "no new activity of that kind" (not fatal).
    const [checks, threads] = await Promise.all([
      gh.prChecks(number, repo).catch(() => null),
      gh.reviewThreads(number, repo).catch(() => null),
    ]);

    const events: WatchPrEvent[] = [];
    for (const c of checks ?? []) {
      const conclusion = c.conclusion ?? undefined;
      const fingerprint = conclusion ?? c.status;
      const failing = conclusion !== undefined && FAILING_CONCLUSIONS.has(conclusion);
      if (failing && st.checks.get(c.name) !== fingerprint) {
        events.push({ type: "ci-failed", name: c.name, conclusion, url: c.url });
      }
      st.checks.set(c.name, fingerprint);
    }
    for (const t of threads ?? []) {
      if (!t.isResolved && !st.threads.has(t.id)) {
        events.push({
          type: "review-comment",
          threadId: t.id,
          path: t.path,
          line: t.line ?? null,
          author: t.author,
          body: t.body,
        });
        st.threads.add(t.id);
      }
    }
    if (events.length) return { kind: "activity", state: merge, events };

    const remaining = deadline - opts.now();
    if (remaining <= 0) return { kind: "timeout", state: merge };
    if ((await sleep(Math.min(opts.intervalMs, remaining), opts.signals)) === "aborted") {
      return { kind: "aborted" };
    }
  }
}

/** One-line, length-bounded rendering of a review comment body for the summary. */
function firstLine(body: string | undefined, max = 200): string {
  const line = (body ?? "").split("\n").find((l) => l.trim()) ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/* -------------------------------------------------------------------- tools */

/** The manager tool definitions, closed over one session's context. */
export function createManagerTools(ctx: ManagerMcpContext) {
  // Per-session dedup memory for watch_pr, keyed `${repo}#${number}`. Lives for
  // the life of this session's MCP server, so it survives the agent's repeated
  // watch_pr calls and never re-reports a check/comment it already handed over.
  const watchState = new Map<string, WatchPrState>();

  const wait = tool(
    "wait",
    "Pause yourself for a fixed duration before continuing. Use to self-pace " +
      "(e.g. let a build/CI settle, or space out polling). Caps at " +
      `${WAIT_CAP_SECONDS}s.`,
    {
      seconds: z.number().describe(`How long to wait (0–${WAIT_CAP_SECONDS}s).`),
      reason: z
        .string()
        .optional()
        .describe("Shown in the UI while paused, e.g. 'CI to finish'."),
    },
    async (args, extra): Promise<CallToolResult> => {
      const seconds = clampSeconds(args.seconds, WAIT_CAP_SECONDS);
      const reason = typeof args.reason === "string" ? args.reason.trim() : "";

      // Surface the self-imposed pause via the working/typing status header.
      ctx.bus.publish({
        type: "chat-status",
        chatId: ctx.chatId,
        status: "running",
        activity: {
          state: "tool",
          label: `waiting ${seconds}s${reason ? `: ${reason}` : ""}`,
          toolName: "wait",
        },
      });

      const outcome = await sleep(seconds * 1000, [ctx.signal, extraSignal(extra)]);
      if (outcome === "aborted") {
        return textResult(`Wait cancelled after being interrupted (was ${seconds}s).`);
      }
      return textResult(
        `Waited ${seconds}s${reason ? ` for: ${reason}` : ""}. Continuing.`,
      );
    },
  );

  const waitForChat = tool(
    "wait_for_chat",
    "Block until ANOTHER manager chat/session goes idle, done, or errors (or " +
      "until a timeout). Use to sequence work behind a subagent/sibling chat. " +
      "Returns that chat's final state.",
    {
      chatId: z.string().describe("The id of the chat/session to wait on."),
      timeoutSeconds: z
        .number()
        .optional()
        .describe(`Give up after this long (default/cap ${WAIT_CAP_SECONDS}s).`),
    },
    async (args, extra): Promise<CallToolResult> => {
      const chatId = typeof args.chatId === "string" ? args.chatId.trim() : "";
      if (!chatId) {
        return textResult("wait_for_chat requires a non-empty chatId.", true);
      }
      if (!ctx.broker.has(chatId)) {
        return textResult(
          `Unknown chatId "${chatId}" — no such session is registered with ` +
            "the manager, so there is nothing to wait on.",
          true,
        );
      }

      const timeoutMs =
        clampSeconds(args.timeoutSeconds ?? WAIT_CAP_SECONDS, WAIT_CAP_SECONDS) *
        1000;

      // Advertise the wait in the UI header (reuses the working-status surface).
      ctx.bus.publish({
        type: "chat-status",
        chatId: ctx.chatId,
        status: "running",
        activity: {
          state: "tool",
          label: `waiting for chat ${chatId}`,
          toolName: "wait_for_chat",
        },
      });

      const outcome = await waitForChatState(ctx, chatId, timeoutMs, [
        ctx.signal,
        extraSignal(extra),
      ]);
      if (outcome.aborted) {
        return textResult(
          `Wait for chat ${chatId} was cancelled after being interrupted.`,
        );
      }
      const summary = outcome.timedOut
        ? `Timed out waiting for chat ${chatId} (last state: ${outcome.finalState}).`
        : `Chat ${chatId} reached state "${outcome.finalState}".`;
      return textResult(
        `${summary}\n${JSON.stringify({
          chatId,
          finalState: outcome.finalState,
          timedOut: outcome.timedOut,
        })}`,
      );
    },
  );

  const contextUsage = tool(
    "context_usage",
    "Report how full YOUR OWN context window is — total tokens used, the model's " +
      "window size, percent filled, and a per-category breakdown (system prompt, " +
      "tools, MCP tools, memory files, messages). Use it to decide whether to " +
      "compact before you run low. Prefer this over guessing from message counts.",
    {},
    async (): Promise<CallToolResult> => {
      const usage = await ctx.broker.getContextUsage(ctx.chatId);
      if (!usage) {
        return textResult(
          "Context usage is unavailable for this session right now (the " +
            "subprocess must be live to report it). Try again after a turn runs.",
          true,
        );
      }
      const pct = Math.round(usage.percentage);
      const cats = usage.categories
        .filter((c) => c.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens)
        .map((c) => `  ${c.name}: ${c.tokens.toLocaleString()}`)
        .join("\n");
      const summary =
        `Context: ${usage.totalTokens.toLocaleString()} / ` +
        `${usage.maxTokens.toLocaleString()} tokens (${pct}% full)` +
        (usage.model ? ` — ${usage.model}` : "");
      return textResult(
        `${summary}\n${cats ? `${cats}\n` : ""}${JSON.stringify({
          totalTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          percentage: usage.percentage,
          model: usage.model,
        })}`,
      );
    },
  );

  const compactContext = tool(
    "compact_context",
    "Compact YOUR OWN context in place — summarize the conversation so far and " +
      "continue with a much smaller window, keeping the session. Use when " +
      "`context_usage` shows the window filling up (e.g. past ~80%) and you have " +
      "more work to do. Compaction runs right after the current turn ends.",
    {},
    async (): Promise<CallToolResult> => {
      ctx.broker.compact(ctx.chatId);
      return textResult(
        "Compaction requested — it will run after this turn ends. Your next turn " +
          "starts from a summarized, much smaller context.",
      );
    },
  );

  const watchPr = tool(
    "watch_pr",
    "Watch a GitHub pull request and RETURN THE INSTANT it needs you — a CI check " +
      "fails, a new review comment/thread appears, or the PR is merged/closed. This " +
      "is the ONE correct way to wait on or react to a PR: do NOT hand-roll a `gh " +
      "pr view` / `gh pr checks` sleep loop, and do NOT launch a background Bash or " +
      "Monitor task to watch it. Call it in a LOOP — it blocks until something is " +
      "actionable, then returns the failing checks and new comments to address " +
      "(done:false); fix them and call watch_pr AGAIN. Each check/comment is " +
      "reported only once, so repeated calls surface each NEW round of review " +
      "comments instead of going silent. It returns done:true only when the PR " +
      "merges or closes — keep calling until then and you'll never miss a late " +
      "review round.",
    {
      number: z.number().describe("The PR number to watch."),
      repo: z
        .string()
        .optional()
        .describe("Optional 'owner/name' override; defaults to the chat's repo."),
      timeoutSeconds: z
        .number()
        .optional()
        .describe(
          `Max quiet window before returning with no new activity (default ` +
            `${WATCH_PR_DEFAULT_TIMEOUT_SECONDS}s, cap ${WAIT_CAP_SECONDS}s). On a quiet ` +
            `timeout you get done:false/timedOut:true — just call watch_pr again to resume.`,
        ),
    },
    async (args, extra): Promise<CallToolResult> => {
      if (!ctx.github) {
        return textResult("The watch_pr tool is not available in this session.", true);
      }
      const number =
        typeof args.number === "number" && Number.isInteger(args.number) ? args.number : NaN;
      if (!Number.isFinite(number) || number <= 0) {
        return textResult("watch_pr requires a positive integer PR number.", true);
      }
      const repo =
        typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : undefined;
      const timeoutSeconds = clampSeconds(
        args.timeoutSeconds ?? WATCH_PR_DEFAULT_TIMEOUT_SECONDS,
        WAIT_CAP_SECONDS,
      );

      const key = `${repo ?? ""}#${number}`;
      let st = watchState.get(key);
      if (!st) {
        st = { checks: new Map(), threads: new Set() };
        watchState.set(key, st);
      }

      // Advertise the watch in the UI header (reuses the working-status surface).
      ctx.bus.publish({
        type: "chat-status",
        chatId: ctx.chatId,
        status: "running",
        activity: {
          state: "tool",
          label: `watching PR #${number}${repo ? ` (${repo})` : ""}`,
          toolName: "watch_pr",
        },
      });

      const outcome = await watchForPrActivity(ctx.github, number, repo, st, {
        intervalMs: PR_POLL_INTERVAL_MS,
        timeoutMs: timeoutSeconds * 1000,
        signals: [ctx.signal, extraSignal(extra)],
        now: ctx.now ?? (() => Date.now()),
      });

      if (outcome.kind === "aborted") {
        return textResult(`Watch on PR #${number} was cancelled after being interrupted.`);
      }
      if (outcome.kind === "error") {
        return textResult(
          `Could not watch PR #${number}: ${outcome.error}. Check the number and, ` +
            "if the repo can't be auto-detected here, pass `repo` as 'owner/name'.",
          true,
        );
      }
      if (outcome.kind === "terminal") {
        const s = outcome.state;
        // The PR settled (merged/closed) — mark the chat so its dot reads green
        // ("PR done") once the agent finishes and returns to idle.
        ctx.broker.markPrWatched(ctx.chatId);
        return textResult(
          `PR #${s.number} reached terminal state "${s.state}"${s.merged ? " (merged)" : ""}. ` +
            `Watch complete — no need to call watch_pr again.\n` +
            JSON.stringify({
              number: s.number,
              state: s.state,
              merged: s.merged,
              done: true,
              ...(s.mergedAt ? { mergedAt: s.mergedAt } : {}),
            }),
        );
      }
      if (outcome.kind === "timeout") {
        const s = outcome.state;
        return textResult(
          `No new activity on PR #${number} in the last ${timeoutSeconds}s (still ` +
            `${s.state}). Call watch_pr again to keep watching until it merges.\n` +
            JSON.stringify({ number, state: s.state, done: false, timedOut: true, events: [] }),
        );
      }

      // activity — one or more new checks/comments to act on, then re-watch.
      const { state: s, events } = outcome;
      const failing = events.filter((e) => e.type === "ci-failed");
      const comments = events.filter((e) => e.type === "review-comment");
      const parts: string[] = [];
      if (failing.length) parts.push(`${failing.length} failing check(s)`);
      if (comments.length) parts.push(`${comments.length} new review comment(s)`);
      const lines = events.map((e) =>
        e.type === "ci-failed"
          ? `  ✗ check "${e.name}" ${e.conclusion ?? "failing"}${e.url ? ` — ${e.url}` : ""}`
          : `  💬 ${e.author ?? "reviewer"} on ${e.path ?? "the PR"}${
              e.line ? `:${e.line}` : ""
            } — ${firstLine(e.body) || "(see thread)"}`,
      );
      return textResult(
        `PR #${number} needs attention: ${parts.join(" and ")}.\n${lines.join("\n")}\n\n` +
          `Address these, then call watch_pr again — it keeps watching (reporting only ` +
          `NEW activity) until the PR merges.\n` +
          JSON.stringify({ number, state: s.state, done: false, events }),
      );
    },
  );

  const terminal = tool(
    "terminal",
    "Run a shell command in a NAMED, PERSISTENT terminal whose working directory " +
      "and environment SURVIVE between calls (unlike Bash, which resets each time). " +
      "Reuse the same `name` to keep a cwd (e.g. `cd` once, then run builds from " +
      "there) or an env var across commands. Returns the command output, its exit " +
      "code, and the terminal's current working directory.",
    {
      name: z
        .string()
        .describe("Terminal name to run in (created on first use, e.g. 'build')."),
      command: z.string().describe("The shell command to execute."),
      timeoutMs: z
        .number()
        .optional()
        .describe("Give up waiting after this long (the command keeps running)."),
    },
    async (args, extra): Promise<CallToolResult> => {
      if (!ctx.terminals) {
        return textResult("The terminal tool is not available in this session.", true);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      const command = typeof args.command === "string" ? args.command : "";
      if (!name) return textResult("terminal requires a non-empty name.", true);
      if (!command.trim()) return textResult("terminal requires a command.", true);

      const res = await ctx.terminals.run({
        name,
        command,
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        signal: extraSignal(extra) ?? ctx.signal,
      });

      const header = `[${name}] cwd=${res.cwd} exit=${res.exitCode ?? "n/a"}`;
      const body = res.output ? `\n${res.output}` : "";
      const note = res.error ? `\n(${res.error})` : "";
      return textResult(`${header}${body}${note}`, !!res.error && !res.timedOut);
    },
  );

  const remember = tool(
    "remember",
    "Record a DURABLE fact about THIS project that should survive across chats — a " +
      "user preference, a correction/lesson, an architecture decision, or a pointer " +
      "to reference material. Reach for this WHENEVER you learn something you'd want " +
      "a future session to know without being re-told: it's saved to the project's " +
      "shared memory, listed in its index, and the relevant ones are auto-surfaced " +
      "in later turns. Keep each memory ONE focused fact. Reuse the same `name` to " +
      "UPDATE (it overwrites). Keep `description` to one line; put detail in `body`.",
    {
      name: z
        .string()
        .describe("Short kebab-case identity, e.g. 'deploy-runbook'. Reusing it overwrites."),
      description: z
        .string()
        .describe(
          "One-line summary — this is the retrieval signal shown in the index and " +
            "matched against future turns, so make it specific and searchable.",
        ),
      type: MemoryTypeSchema.describe(
        "user = a durable preference; feedback = a correction/lesson; project = a " +
          "codebase/architecture fact; reference = a pointer to docs/material.",
      ),
      body: z
        .string()
        .describe(
          "The full fact, in markdown. For feedback/project, follow it with a **Why:** " +
            "line so the rationale survives. Link related memories with [[their-name]].",
        ),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.memory) {
        return textResult("Project memory is not available in this session.", true);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return textResult("remember requires a non-empty name.", true);
      try {
        const description = typeof args.description === "string" ? args.description : "";
        const body = typeof args.body === "string" ? args.body : "";
        const memory = await ctx.memory.remember({ name, description, type: args.type, body });

        // Dedup nudge: if this closely resembles an existing (differently-named)
        // memory, the fact was likely already recorded — steer toward consolidating
        // rather than accumulating a near-duplicate. Best-effort; never blocks the
        // save that already succeeded.
        let nudge = "";
        try {
          const similar =
            (await ctx.memory.findSimilar?.({ name: memory.name, description, body })) ?? [];
          if (similar.length) {
            const list = similar
              .map((s) => `\`${s.name}\` (${Math.round(s.similarity * 100)}% similar)`)
              .join(", ");
            nudge =
              `\n\n⚠️ This looks like it may duplicate existing memory: ${list}. ` +
              "If it's the SAME fact, consolidate to keep memory lean — fold the detail " +
              `into one and \`forget\` the other (reuse a name to overwrite). If "${memory.name}" ` +
              "is genuinely distinct, ignore this.";
          }
        } catch {
          /* dedup hint is best-effort — a lookup failure never fails the remember */
        }

        return textResult(
          `Remembered "${memory.name}" (${memory.type}). It's saved to project memory ` +
            "and will be injected into future sessions. Use recall to read it back." +
            nudge,
        );
      } catch (err) {
        return textResult(
          `Could not record that memory: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const recall = tool(
    "recall",
    "Look up this project's durable memory. With no query you get the index (one " +
      "line per memory); with a query you get the FULL body of the most RELEVANT " +
      "memories, ranked (plus any they `[[link]]` to) — use it to pull a fact on " +
      "demand. The most relevant memories are already surfaced automatically as you " +
      "work; call this to dig deeper or when you need a fact that wasn't surfaced.",
    {
      query: z
        .string()
        .optional()
        .describe("Optional search term; omit to just list the memory index."),
      type: MemoryTypeSchema.optional().describe(
        "Optionally restrict to one kind: user | feedback | project | reference.",
      ),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.memory) {
        return textResult("Project memory is not available in this session.", true);
      }
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const type = args.type;
      try {
        const { index, matches } = await ctx.memory.recall(query || undefined, { type });
        if (!query) return textResult(index);
        if (!matches.length) {
          return textResult(`No memories matched "${query}".\n\n${index}`);
        }
        // Render within a total char budget so a broad query over a large memory
        // store can never exceed the MCP tool-result token cap. Bodies are clamped
        // individually; once the budget runs out the rest are listed by name only.
        const MAX_TOTAL = 24000;
        const MAX_BODY = 5000;
        const sections: string[] = [];
        const omitted: string[] = [];
        let budget = MAX_TOTAL;
        for (const m of matches) {
          const linked = (m as { linked?: boolean }).linked ? " — linked" : "";
          const head = `### ${m.name} (${m.type})${linked}\n${m.description}`;
          const section = `${head}\n\n${clampBody(m.body, MAX_BODY)}`;
          if (section.length <= budget) {
            sections.push(section);
            budget -= section.length;
          } else {
            omitted.push(m.name);
          }
        }
        const tail = omitted.length
          ? `\n\n---\n\n_${omitted.length} more match(es) omitted to stay within the size limit: ` +
            `${omitted.join(", ")}. Narrow your query or recall by name/type._`
          : "";
        return textResult(
          `${matches.length} match(es) for "${query}":\n\n${sections.join("\n\n---\n\n")}${tail}`,
        );
      } catch (err) {
        return textResult(
          `Could not recall memory: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const forget = tool(
    "forget",
    "Delete a durable project memory by name. Use when a recorded fact is wrong or " +
      "no longer relevant so it stops being injected into future sessions.",
    {
      name: z.string().describe("The memory's name (as shown by recall)."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.memory) {
        return textResult("Project memory is not available in this session.", true);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return textResult("forget requires a non-empty name.", true);
      try {
        const removed = await ctx.memory.forget(name);
        return removed
          ? textResult(`Forgot memory "${name}".`)
          : textResult(`No memory named "${name}" to forget.`, true);
      } catch (err) {
        return textResult(
          `Could not forget that memory: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  const runSubapp = tool(
    "run_subapp",
    "Launch one of THIS project's apps and get back a live localhost URL so you can " +
      "actually SEE your change running — preview a UI tweak, verify a fix end-to-end, " +
      "or hand the user a working link. STRONGLY prefer this over telling the user to " +
      "start the app themselves; running the real thing is the fastest way to confirm " +
      "your work. Call with NO args to list the apps, their run state, and the branches " +
      "available. Pass `subApp` (and optionally `branch`) to start it — each branch runs " +
      "isolated in its own worktree, created automatically if needed. Pass `stop: true` " +
      "to stop it.",
    {
      subApp: z
        .string()
        .optional()
        .describe("SubApp id to start/stop (e.g. 'game'). Omit to just list."),
      branch: z
        .string()
        .optional()
        .describe("Branch to run on. Defaults to the project's current branch."),
      stop: z.boolean().optional().describe("Stop the running instance instead of starting."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.runner) {
        return textResult("The run_subapp tool is not available in this session.", true);
      }
      const subApp = typeof args.subApp === "string" ? args.subApp.trim() : "";
      const branch = typeof args.branch === "string" ? args.branch.trim() : undefined;

      // No subApp → list what's available + what's running.
      if (!subApp) {
        try {
          const ov = await ctx.runner.overview(ctx.chatId);
          const apps = ov.subApps.length
            ? ov.subApps.map((a) => `  • ${a.id} (${a.name})`).join("\n")
            : "  (none configured)";
          const running = ov.running.length
            ? ov.running
                .map(
                  (r) =>
                    `  • ${r.subAppId} — ${r.status}${r.branch ? ` on ${r.branch}` : ""}${
                      r.url ? ` → ${r.url}` : ""
                    }`,
                )
                .join("\n")
            : "  (nothing running)";
          const branches = ov.branches
            .slice(0, 12)
            .map(
              (b) =>
                `  • ${b.name}${b.current ? " (current)" : ""}${b.hasWorktree ? " [worktree]" : ""}`,
            )
            .join("\n");
          return textResult(
            `Apps:\n${apps}\n\nRunning:\n${running}\n\nBranches:\n${branches}\n\n` +
              `Start one with run_subapp({ subApp: "<id>", branch?: "<branch>" }).`,
          );
        } catch (err) {
          return textResult(
            `Could not read subApps: ${err instanceof Error ? err.message : String(err)}`,
            true,
          );
        }
      }

      try {
        if (args.stop) {
          const stopped = await ctx.runner.stop({ chatId: ctx.chatId, subAppId: subApp, branch });
          return stopped
            ? textResult(`Stopped ${subApp}${branch ? ` on ${branch}` : ""}.`)
            : textResult(`No running ${subApp}${branch ? ` on ${branch}` : ""} to stop.`, true);
        }
        const r = await ctx.runner.launch({ chatId: ctx.chatId, subAppId: subApp, branch });
        const where = r.branch ? ` on ${r.branch}` : "";
        return textResult(
          r.url
            ? `Started ${r.subAppId}${where} — ${r.status}. Open it at ${r.url}`
            : `Started ${r.subAppId}${where} — ${r.status} (no URL yet; give it a moment and list again).`,
        );
      } catch (err) {
        return textResult(
          `Could not launch ${subApp}: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  return {
    wait,
    waitForChat,
    contextUsage,
    compactContext,
    watchPr,
    terminal,
    remember,
    recall,
    forget,
    runSubapp,
  };
}

/* ------------------------------------------------------------- catalog */

/**
 * Which session binding gates a manager tool being OFFERED to the agent (see the
 * `createManagerMcpServer` tools array). `null` = always offered. The catalog
 * view reads this to mark each tool `available` for a given session's bindings.
 */
const MANAGER_TOOL_GATE: Record<
  string,
  "github" | "terminals" | "memory" | "runner" | null
> = {
  wait: null,
  wait_for_chat: null,
  context_usage: null,
  compact_context: null,
  watch_pr: "github",
  terminal: "terminals",
  remember: "memory",
  recall: "memory",
  forget: "memory",
  run_subapp: "runner",
};

/** A catalog descriptor for one manager tool (no live session needed). */
export interface ManagerToolDescriptor {
  /** Bare tool name, e.g. "wait". */
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12) of the tool's input parameters. */
  inputSchema: Record<string, unknown>;
  /** Whether the tool is offered given the supplied session bindings. */
  available: boolean;
}

/** No-op bus/broker for descriptor extraction — the tool factory only READS the
 *  static metadata (name/description/schema) at build time; no handler runs, so
 *  these are never actually invoked. */
const NOOP_DESCRIPTOR_CTX = {
  chatId: "",
  bus: { publish() {}, subscribe: () => () => {}, on: () => () => {} } as unknown as EventBus,
  broker: {
    has: () => false,
    getStatus: () => undefined,
    getContextUsage: async () => null,
    compact: () => {},
    markPrWatched: () => {},
  } as ManagerMcpBroker,
} satisfies ManagerMcpContext;

/**
 * Enumerate every manager tool as a catalog descriptor — the SINGLE SOURCE the
 * MCP catalog endpoint consumes, derived from the very same {@link createManagerTools}
 * definitions the SDK registration uses (name/description/`inputSchema` come off
 * each `tool(...)` result, so the two can never drift). `createManagerTools`
 * always builds every definition regardless of ctx — the ctx bindings only
 * decide which are REGISTERED — so a no-op ctx yields every tool's static shape.
 * `bindings` reflects which backing services the session has, so gated tools
 * (watch_pr/terminal/remember/recall/forget/run_subapp) report the right `available`.
 */
export function managerToolDescriptors(
  bindings: { github?: boolean; terminals?: boolean; memory?: boolean; runner?: boolean } = {},
): ManagerToolDescriptor[] {
  const tools = createManagerTools(NOOP_DESCRIPTOR_CTX);
  return Object.values(tools).map((t) => {
    const gate = MANAGER_TOOL_GATE[t.name] ?? null;
    const available = gate === null ? true : Boolean(bindings[gate]);
    return {
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(z.object(t.inputSchema as z.ZodRawShape)) as Record<
        string,
        unknown
      >,
      available,
    };
  });
}

/**
 * Build the in-process "manager" MCP server for one session. Drop the result
 * into `Options.mcpServers.manager` — the SDK exposes its tools to the agent as
 * `mcp__manager__wait` / `mcp__manager__wait_for_chat`.
 */
export function createManagerMcpServer(
  ctx: ManagerMcpContext,
): McpSdkServerConfigWithInstance {
  const {
    wait,
    waitForChat,
    contextUsage,
    compactContext,
    watchPr,
    terminal,
    remember,
    recall,
    forget,
    runSubapp,
  } = createManagerTools(ctx);
  // Each tool is only meaningful when its backing service is wired in; omit the
  // dead ones so the agent isn't offered a tool it can't use.
  const tools = [
    wait,
    waitForChat,
    contextUsage,
    compactContext,
    ...(ctx.github ? [watchPr] : []),
    ...(ctx.terminals ? [terminal] : []),
    ...(ctx.memory ? [remember, recall, forget] : []),
    ...(ctx.runner ? [runSubapp] : []),
  ];
  return createSdkMcpServer({
    name: "manager",
    version: "1.0.0",
    tools,
  });
}
