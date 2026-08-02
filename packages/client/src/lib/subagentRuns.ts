/**
 * Fold a transcript into SUBAGENT RUNS — the model behind the Agents rail, the
 * in-chat run card, and the run inspector.
 *
 * A subagent has no entity of its own on the wire: it exists only as a `Task`
 * tool_use row plus every row tagged with that row's `toolUseId` as its
 * `parentToolUseId` (see server/services/session-broker.ts). This module turns
 * that flat tagging into a run with identity, status, timing and a step list, so
 * the UI never has to re-derive it three different ways.
 *
 * Pure and cheap — safe to call from a `useMemo` on every new message.
 */
import type {
  AssistantMessageRow,
  ChatMessage,
  TaskStatusRow,
  ToolResultRow,
  ToolUseRow,
} from "@cm/shared";

export type RunStatus = "running" | "done" | "failed" | "stopped";

/** One step in a run's timeline: a tool call, an assistant turn, or a nested run. */
export type RunStep =
  | {
      kind: "tool";
      id: string;
      ts: number;
      use: ToolUseRow;
      result?: ToolResultRow;
      /** No result yet — this is the step the subagent is on right now. */
      pending: boolean;
      durationMs?: number;
    }
  | {
      kind: "message";
      id: string;
      ts: number;
      row: AssistantMessageRow;
    }
  | {
      kind: "subagent";
      id: string;
      ts: number;
      /** The nested run's id (its own Task `toolUseId`). */
      runId: string;
      use: ToolUseRow;
      result?: ToolResultRow;
      pending: boolean;
    };

export interface SubagentRun {
  /** The spawning Task row's `toolUseId` — stable identity for this run. */
  id: string;
  chatId: string;
  /** The `Task` tool_use row that started it. */
  use: ToolUseRow;
  /** The spawner's own result — present once the subagent reports back. */
  result?: ToolResultRow;
  /** Agent type ("claude", "Explore", "general-purpose", …). */
  agentType: string;
  /** One-line task description from the Task input. */
  description?: string;
  /** The full prompt the subagent was given. */
  prompt?: string;
  /** Model the subagent's rows reported (first one wins). */
  model?: string;
  /** Every row this subagent produced, in transcript order. */
  rows: ChatMessage[];
  /** Timeline steps (tool calls, assistant turns, nested runs). */
  steps: RunStep[];
  /** Ordered ids of subagents THIS run spawned (nesting, one level per hop). */
  childRunIds: string[];
  /** Parent run id when this run was itself spawned by a subagent. */
  parentRunId?: string;
  status: RunStatus;
  /** Tool calls made (excludes nested Task spawns). */
  toolCount: number;
  /** Completed turns inside the subagent (its own `result` rows). */
  turnCount: number;
  startedAt: number;
  /** Wall-clock end — only set once the run finished. */
  endedAt?: number;
  /**
   * Elapsed time. Fixed once finished; for a live run this is the time up to the
   * newest row, NOT "now" — the caller ticks a clock for the live case so this
   * stays a pure function.
   */
  durationMs: number;
  /** The subagent's report back to the main agent (its spawner's result). */
  report?: string;
  /** The last thing it did — the live "what's happening" line. */
  latest?: string;
  /**
   * The spawner returned a LAUNCH ACK rather than a report — the async `Agent`
   * pattern, where the tool result lands milliseconds after the spawn and the
   * subagent keeps working in the background. Detected structurally: rows
   * arrived AFTER the result. Such a run's completion can't be read off its
   * result, and its report is the subagent's own final message.
   */
  async: boolean;
  /**
   * The SDK's own settle verdict for this run, when one arrived. Present ⇒ the
   * status below is this run's OWN, not an inference from the parent turn.
   */
  settled?: TaskStatusRow;
}

/**
 * Index the `task_status` rows in a transcript for correlation with runs.
 *
 * Notifications key on the launching `toolUseId` when the SDK supplies it. When
 * it doesn't, the only link back is the `taskId`, which the launch ack prints
 * into its own text ("agentId: a730258b58505d274") — so keep both indexes and
 * let the caller try them in order.
 */
export function indexTaskStatus(messages: ChatMessage[]): TaskStatusIndex {
  const byToolUse = new Map<string, TaskStatusRow>();
  const byTaskId = new Map<string, TaskStatusRow>();
  for (const row of messages) {
    if (row.kind !== "task_status") continue;
    if (row.toolUseId) byToolUse.set(row.toolUseId, row);
    if (row.taskId) byTaskId.set(row.taskId, row);
  }
  return { byToolUse, byTaskId };
}

export interface TaskStatusIndex {
  byToolUse: Map<string, TaskStatusRow>;
  byTaskId: Map<string, TaskStatusRow>;
}

/**
 * The settle verdict for one launched background task — by its launching
 * tool_use, else by the id its launch ack printed. Used by the run fold and by
 * the tool card for a backgrounded `Bash`.
 */
export function findTaskStatus(
  index: TaskStatusIndex,
  toolUseId: string,
  ack: ToolResultRow | undefined,
): TaskStatusRow | undefined {
  const direct = index.byToolUse.get(toolUseId);
  if (direct) return direct;
  if (index.byTaskId.size === 0) return undefined;
  const id = ackTaskId(ack);
  return id ? index.byTaskId.get(id) : undefined;
}

/** The `Task` tool spawns subagents; its result is the subagent's report. */
const TASK_TOOLS = new Set(["Task", "Agent"]);

/** Whether a tool name is a subagent spawner. */
function isTaskName(name: string): boolean {
  return TASK_TOOLS.has(name);
}

/**
 * Narrowing form for scanning a mixed transcript. Kept separate from
 * {@link isTaskName}: applying a `row is ToolUseRow` guard to an already-narrowed
 * ToolUseRow makes its ELSE branch `never`, so code that handles both spawns and
 * plain tools must test the name directly.
 */
function isTaskRow(row: ChatMessage): row is ToolUseRow {
  return row.kind === "tool_use" && isTaskName(row.name);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Best-effort agent type: the Task input, else a child row's tag, else generic. */
function agentTypeOf(use: ToolUseRow, rows: ChatMessage[]): string {
  const fromInput = str(use.input.subagent_type) ?? str(use.input.agentType);
  if (fromInput) return fromInput;
  for (const r of rows) {
    if ("subagentType" in r && r.subagentType) return r.subagentType;
  }
  return "subagent";
}

/**
 * Readable text out of a tool result payload.
 *
 * The SDK hands a subagent's report back as an array of content blocks
 * (`[{type:"text", text:"…"}]`), so a naive stringify prints raw JSON where the
 * report should be. Unwrap the text blocks; fall back to JSON only for shapes
 * that carry no text at all.
 */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (block && typeof block === "object") {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string" && t.trim()) parts.push(t);
      }
    }
    if (parts.length > 0) return parts.join("\n\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

/**
 * The task id an async LAUNCH ACK printed into its own text ("agentId: abc123").
 * Only needed when the settle notification omits `tool_use_id` — then this is
 * the one thread back from the notification to the run that started it.
 */
export function ackTaskId(result: ToolResultRow | undefined): string | undefined {
  if (!result) return undefined;
  const m = /\b(?:agentId|agent_id|taskId|task_id|ID)\s*[:=]\s*([A-Za-z0-9_-]{6,})/.exec(
    resultText(result.content),
  );
  return m?.[1];
}

/** First line of a string, clipped — for one-line summaries. */
function firstLine(text: string, max = 120): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * A short label for what a tool call is doing — the command, the file, the
 * pattern — so the timeline reads as actions rather than a column of tool names.
 */
export function toolDetail(use: ToolUseRow): string | undefined {
  const i = use.input;
  return (
    str(i.command) ??
    str(i.file_path) ??
    str(i.filePath) ??
    str(i.notebook_path) ??
    str(i.path) ??
    str(i.pattern) ??
    str(i.query) ??
    str(i.url) ??
    str(i.description) ??
    undefined
  );
}

/**
 * Fold every subagent run out of a transcript, in spawn order.
 *
 * Runs are keyed by the spawning Task row's `toolUseId`; rows are attached by
 * their `parentToolUseId`. With a WINDOWED transcript the Task row can be above
 * the loaded window — those orphaned child rows simply produce no run (and
 * MessageList already falls back to rendering them at root), so paging the
 * parent in is what materializes the run.
 */
export function deriveSubagentRuns(
  messages: ChatMessage[],
  opts: {
    /**
     * Whether the parent chat's turn is still running. Required to tell a LIVE
     * async subagent from a finished one: an async spawn's tool result is only a
     * launch ack, so the sole proof that no more of its rows are coming is the
     * parent turn having ended. Defaults to false (treat as settled).
     */
    chatRunning?: boolean;
  } = {},
): SubagentRun[] {
  const chatRunning = opts.chatRunning ?? false;
  const taskStatus = indexTaskStatus(messages);
  // Pass 1: every Task row becomes a run shell, in spawn order.
  const runs = new Map<string, SubagentRun>();
  for (const row of messages) {
    if (!isTaskRow(row)) continue;
    runs.set(row.toolUseId, {
      id: row.toolUseId,
      chatId: row.chatId,
      use: row,
      agentType: "subagent",
      description: str(row.input.description),
      prompt: str(row.input.prompt),
      rows: [],
      steps: [],
      childRunIds: [],
      status: "running",
      toolCount: 0,
      turnCount: 0,
      startedAt: row.ts,
      durationMs: 0,
      async: false,
    });
  }
  if (runs.size === 0) return [];

  // Pass 2: attach child rows + the spawners' own results.
  const resultsByUse = new Map<string, ToolResultRow>();
  for (const row of messages) {
    if (row.kind === "tool_result") resultsByUse.set(row.toolUseId, row);
  }
  for (const row of messages) {
    const pid = "parentToolUseId" in row ? row.parentToolUseId : undefined;
    if (pid) runs.get(pid)?.rows.push(row);
  }

  // Pass 3: build each run's timeline + rollups.
  for (const run of runs.values()) {
    run.result = resultsByUse.get(run.id);
    run.agentType = agentTypeOf(run.use, run.rows);

    let lastTs = run.startedAt;
    for (const row of run.rows) {
      lastTs = Math.max(lastTs, row.ts);
      switch (row.kind) {
        case "assistant": {
          run.model ??= row.model;
          // Thinking-only rows carry no visible text — they'd render as blanks.
          if (row.text.trim()) {
            run.steps.push({ kind: "message", id: row.id, ts: row.ts, row });
            run.latest = firstLine(row.text);
          }
          break;
        }
        case "tool_use": {
          const result = resultsByUse.get(row.toolUseId);
          if (isTaskName(row.name)) {
            // A subagent spawning a subagent: a step here, its own run elsewhere.
            run.childRunIds.push(row.toolUseId);
            const child = runs.get(row.toolUseId);
            if (child) child.parentRunId = run.id;
            run.steps.push({
              kind: "subagent",
              id: row.id,
              ts: row.ts,
              runId: row.toolUseId,
              use: row,
              result,
              pending: !result,
            });
          } else {
            run.toolCount += 1;
            run.steps.push({
              kind: "tool",
              id: row.id,
              ts: row.ts,
              use: row,
              result,
              pending: !result,
              durationMs: result?.durationMs,
            });
            const detail = toolDetail(row);
            run.latest = detail ? `${row.name} · ${firstLine(detail, 60)}` : row.name;
          }
          break;
        }
        case "result":
          run.turnCount += 1;
          break;
        default:
          break;
      }
    }

    // A result that PRECEDES rows is a launch ack, not a report (async `Agent`).
    run.async = !!run.result && run.rows.some((r) => r.ts > run.result!.ts);
    const ackFailed =
      !!run.result && (run.result.isError || run.result.ok === false);

    if (run.result && !run.async) {
      // Synchronous spawn: the result IS the subagent's report, and its arrival
      // is the end of the run.
      run.status = ackFailed ? "failed" : "done";
      run.endedAt = run.result.ts;
      run.report = resultText(run.result.content).trim() || undefined;
      run.durationMs =
        run.result.durationMs ?? Math.max(0, run.result.ts - run.startedAt);
    } else if (ackFailed) {
      // The launch itself failed — the ack carries the reason.
      run.status = "failed";
      run.endedAt = run.result!.ts;
      run.report = resultText(run.result!.content).trim() || undefined;
      run.durationMs = Math.max(0, run.result!.ts - run.startedAt);
    } else {
      // Launched async: the result was only an ack, so this run's fate is not in
      // its own rows. Prefer the SDK's settle notification for THIS task — that
      // is what lets five parallel subagents hold five different statuses.
      run.durationMs = Math.max(0, lastTs - run.startedAt);
      const settled = findTaskStatus(taskStatus, run.id, run.result);
      if (settled) {
        run.settled = settled;
        run.status = settled.status === "completed" ? "done" : settled.status;
        run.endedAt = settled.ts;
        run.durationMs = settled.durationMs ?? Math.max(0, settled.ts - run.startedAt);
        // Its own last message is the report the ack never carried; the SDK's
        // recap stands in when the run ended without speaking.
        run.report = lastAssistantText(run.rows) ?? settled.summary;
      } else if (chatRunning) {
        // No verdict yet and the turn is still up — genuinely still working.
        run.status = "running";
      } else {
        // The parent turn ended without a notification for this task (an older
        // transcript, or a spawn the SDK never reported): nothing more is
        // coming, so settle it rather than leave a card spinning forever.
        run.status = "done";
        run.endedAt = lastTs;
        run.report = lastAssistantText(run.rows);
      }
    }
  }

  return [...runs.values()];
}

/** The subagent's final spoken message — its report when the spawner had none. */
function lastAssistantText(rows: ChatMessage[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (r.kind === "assistant" && r.text.trim()) return r.text;
  }
  return undefined;
}

/** Look one run up by id (null-safe over an already-derived list). */
export function findRun(runs: SubagentRun[], id: string | null): SubagentRun | undefined {
  return id ? runs.find((r) => r.id === id) : undefined;
}

/** Runs sorted for a roster: live first (newest first), then finished (newest first). */
export function sortRunsForRoster(runs: SubagentRun[]): SubagentRun[] {
  return [...runs].sort((a, b) => {
    const liveA = a.status === "running" ? 1 : 0;
    const liveB = b.status === "running" ? 1 : 0;
    if (liveA !== liveB) return liveB - liveA;
    return b.startedAt - a.startedAt;
  });
}

/** Human duration for run chrome ("8.1s", "1:24", "12:04"). */
export function runDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 1 : 0)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
