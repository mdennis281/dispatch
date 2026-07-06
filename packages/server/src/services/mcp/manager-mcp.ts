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
 *   - `mcp__manager__wait_for_pr({ number, repo?, timeoutSeconds? })` — poll a
 *     GitHub PR (via {@link ManagerMcpGitHub}, reusing GitHubService's `gh`) until
 *     it is merged/closed or the timeout fires, so an agent told to "wait for PR
 *     #N to merge" never hand-rolls an expensive `gh pr view` sleep loop. Returns
 *     the final state as JSON; an unknown PR / gh error is an informative error.
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
import { MemoryTypeSchema, type ChatStatus, type ProjectMemory } from "@cm/shared";
import type { EventBus } from "../../bus.js";

/** Hard ceiling on a single `wait` (also the default `wait_for_chat` timeout). */
export const WAIT_CAP_SECONDS = 3600;

/** How often `wait_for_pr` re-polls a PR's merge/close state. */
export const PR_POLL_INTERVAL_MS = 20_000;

/** Default `wait_for_pr` timeout (30 min); still capped at {@link WAIT_CAP_SECONDS}. */
export const WAIT_FOR_PR_DEFAULT_TIMEOUT_SECONDS = 1800;

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
  recall(query?: string): Promise<{ index: string; matches: ProjectMemory[] }>;
  forget(name: string): Promise<boolean>;
}

/** Terminal-state view of a PR the `wait_for_pr` tool polls on. */
export interface PrPollResult {
  number: number;
  state: "open" | "closed" | "merged";
  merged: boolean;
  mergedAt?: string;
}

/**
 * The narrow GitHub surface the manager MCP needs — a single PR merge/close-state
 * poll, already bound to this session's default repo (its worktree cwd, else the
 * project root) by the broker. `repo` is an optional `owner/name` override. A null
 * result means the PR/repo couldn't be resolved (unknown PR / gh error). Omitted
 * from the ctx → the `wait_for_pr` tool isn't offered.
 */
export interface ManagerMcpGitHub {
  prMergeState(prNumber: number, repo?: string): Promise<PrPollResult | null>;
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
  /** GitHub PR poller for this session (omitted → no `wait_for_pr` tool). */
  github?: ManagerMcpGitHub;
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

interface WaitForPrOutcome {
  kind: "terminal" | "timeout" | "aborted" | "error";
  /** The terminal state (kind==="terminal") or the last non-terminal read seen. */
  state?: PrPollResult;
  /** Set only when kind==="error". */
  error?: string;
}

/**
 * Poll `poll()` every `intervalMs` until the PR reaches a terminal state (merged
 * or closed), a signal aborts, or `timeoutMs` elapses. Polls IMMEDIATELY first,
 * so an already-terminal PR resolves with zero waiting. A null poll (unknown PR /
 * unresolvable repo) or a thrown gh error settles as `error`. Mirrors the
 * `sleep`/`waitForChatState` cancel-on-abort discipline: the interval, the
 * timeout timer, and every abort listener are torn down on the FIRST settle, so a
 * stopped/forked session never strands a poll loop.
 */
function waitForPrState(
  poll: () => Promise<PrPollResult | null>,
  opts: {
    intervalMs: number;
    timeoutMs: number;
    signals: (AbortSignal | undefined)[];
  },
): Promise<WaitForPrOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let inFlight = false;
    let lastState: PrPollResult | undefined;
    const cleanups: (() => void)[] = [];
    const finish = (r: WaitForPrOutcome): void => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      resolve(r);
    };

    const doPoll = async (): Promise<void> => {
      // Guard against overlapping polls (a slow gh) and post-settle stragglers.
      if (settled || inFlight) return;
      inFlight = true;
      let result: PrPollResult | null;
      try {
        result = await poll();
      } catch (err) {
        finish({
          kind: "error",
          error: err instanceof Error ? err.message : String(err),
          state: lastState,
        });
        return;
      } finally {
        inFlight = false;
      }
      if (settled) return;
      if (result === null) {
        finish({
          kind: "error",
          error: "PR not found (unknown number or the repo could not be resolved)",
          state: lastState,
        });
        return;
      }
      lastState = result;
      if (result.state === "merged" || result.state === "closed") {
        finish({ kind: "terminal", state: result });
      }
    };

    const timer = setTimeout(
      () => finish({ kind: "timeout", state: lastState }),
      opts.timeoutMs,
    );
    cleanups.push(() => clearTimeout(timer));

    for (const sig of opts.signals) {
      if (!sig) continue;
      if (sig.aborted) {
        finish({ kind: "aborted", state: lastState });
        return;
      }
      const onAbort = (): void => finish({ kind: "aborted", state: lastState });
      sig.addEventListener("abort", onAbort);
      cleanups.push(() => sig.removeEventListener("abort", onAbort));
    }

    const interval = setInterval(() => void doPoll(), opts.intervalMs);
    cleanups.push(() => clearInterval(interval));

    // Poll now so an already-terminal PR resolves without a first-interval wait.
    void doPoll();
  });
}

/* -------------------------------------------------------------------- tools */

/** The manager tool definitions, closed over one session's context. */
export function createManagerTools(ctx: ManagerMcpContext) {
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

  const waitForPr = tool(
    "wait_for_pr",
    "Block until a GitHub pull request reaches a TERMINAL state (merged or " +
      "closed), or until a timeout. Use this the moment you're told to 'wait for " +
      "PR #N to merge' — do NOT hand-roll a `gh pr view` / sleep polling loop. " +
      "Returns the PR's final state as JSON.",
    {
      number: z.number().describe("The PR number to wait on."),
      repo: z
        .string()
        .optional()
        .describe("Optional 'owner/name' override; defaults to the chat's repo."),
      timeoutSeconds: z
        .number()
        .optional()
        .describe(
          `Give up after this long (default ${WAIT_FOR_PR_DEFAULT_TIMEOUT_SECONDS}s, ` +
            `cap ${WAIT_CAP_SECONDS}s). On timeout you get the last-known state with timedOut:true.`,
        ),
    },
    async (args, extra): Promise<CallToolResult> => {
      if (!ctx.github) {
        return textResult("The wait_for_pr tool is not available in this session.", true);
      }
      const number =
        typeof args.number === "number" && Number.isInteger(args.number) ? args.number : NaN;
      if (!Number.isFinite(number) || number <= 0) {
        return textResult("wait_for_pr requires a positive integer PR number.", true);
      }
      const repo =
        typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : undefined;
      const timeoutMs =
        clampSeconds(
          args.timeoutSeconds ?? WAIT_FOR_PR_DEFAULT_TIMEOUT_SECONDS,
          WAIT_CAP_SECONDS,
        ) * 1000;

      // Advertise the wait in the UI header (reuses the working-status surface).
      ctx.bus.publish({
        type: "chat-status",
        chatId: ctx.chatId,
        status: "running",
        activity: {
          state: "tool",
          label: `waiting on PR #${number}${repo ? ` (${repo})` : ""}`,
          toolName: "wait_for_pr",
        },
      });

      const github = ctx.github;
      const outcome = await waitForPrState(() => github.prMergeState(number, repo), {
        intervalMs: PR_POLL_INTERVAL_MS,
        timeoutMs,
        signals: [ctx.signal, extraSignal(extra)],
      });

      if (outcome.kind === "aborted") {
        return textResult(`Wait for PR #${number} was cancelled after being interrupted.`);
      }
      if (outcome.kind === "error") {
        return textResult(
          `Could not wait on PR #${number}: ${outcome.error}. Check the number and, ` +
            "if the repo can't be auto-detected here, pass `repo` as 'owner/name'.",
          true,
        );
      }
      if (outcome.kind === "timeout") {
        const last = outcome.state;
        return textResult(
          `Timed out waiting for PR #${number} to merge/close (last state: ` +
            `${last?.state ?? "unknown"}).\n${JSON.stringify({
              number,
              state: last?.state ?? "unknown",
              merged: last?.merged ?? false,
              timedOut: true,
            })}`,
        );
      }
      // terminal
      const s = outcome.state!;
      return textResult(
        `PR #${s.number} reached terminal state "${s.state}"${s.merged ? " (merged)" : ""}.\n` +
          JSON.stringify({
            number: s.number,
            state: s.state,
            merged: s.merged,
            ...(s.mergedAt ? { mergedAt: s.mergedAt } : {}),
          }),
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
    "Record a DURABLE fact about THIS project that should survive across chats " +
      "(a preference, a piece of feedback, an architecture fact, or a pointer to " +
      "reference material). It is saved to the project's shared memory and injected " +
      "into every future session at start. Reuse the same `name` to UPDATE an " +
      "existing memory. Keep `description` to one line; put the detail in `body`.",
    {
      name: z
        .string()
        .describe("Short kebab-case identity, e.g. 'deploy-runbook'. Reusing it overwrites."),
      description: z
        .string()
        .describe("One-line summary shown in the index + injected into future prompts."),
      type: MemoryTypeSchema.describe(
        "user = a durable preference; feedback = a correction/lesson; project = a " +
          "codebase/architecture fact; reference = a pointer to docs/material.",
      ),
      body: z.string().describe("The full fact, in markdown."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.memory) {
        return textResult("Project memory is not available in this session.", true);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return textResult("remember requires a non-empty name.", true);
      try {
        const memory = await ctx.memory.remember({
          name,
          description: typeof args.description === "string" ? args.description : "",
          type: args.type,
          body: typeof args.body === "string" ? args.body : "",
        });
        return textResult(
          `Remembered "${memory.name}" (${memory.type}). It's saved to project memory ` +
            "and will be injected into future sessions. Use recall to read it back.",
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
      "line per memory); with a query you also get the FULL body of every memory " +
      "whose name/description/body matches — use it to pull a fact on demand.",
    {
      query: z
        .string()
        .optional()
        .describe("Optional search term; omit to just list the memory index."),
    },
    async (args): Promise<CallToolResult> => {
      if (!ctx.memory) {
        return textResult("Project memory is not available in this session.", true);
      }
      const query = typeof args.query === "string" ? args.query.trim() : "";
      try {
        const { index, matches } = await ctx.memory.recall(query || undefined);
        if (!query) return textResult(index);
        if (!matches.length) {
          return textResult(`No memories matched "${query}".\n\n${index}`);
        }
        const bodies = matches
          .map((m) => `### ${m.name} (${m.type})\n${m.description}\n\n${m.body}`)
          .join("\n\n---\n\n");
        return textResult(`${matches.length} match(es) for "${query}":\n\n${bodies}`);
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

  return { wait, waitForChat, waitForPr, terminal, remember, recall, forget };
}

/**
 * Build the in-process "manager" MCP server for one session. Drop the result
 * into `Options.mcpServers.manager` — the SDK exposes its tools to the agent as
 * `mcp__manager__wait` / `mcp__manager__wait_for_chat`.
 */
export function createManagerMcpServer(
  ctx: ManagerMcpContext,
): McpSdkServerConfigWithInstance {
  const { wait, waitForChat, waitForPr, terminal, remember, recall, forget } =
    createManagerTools(ctx);
  // Each tool is only meaningful when its backing service is wired in; omit the
  // dead ones so the agent isn't offered a tool it can't use.
  const tools = [
    wait,
    waitForChat,
    ...(ctx.github ? [waitForPr] : []),
    ...(ctx.terminals ? [terminal] : []),
    ...(ctx.memory ? [remember, recall, forget] : []),
  ];
  return createSdkMcpServer({
    name: "manager",
    version: "1.0.0",
    tools,
  });
}
