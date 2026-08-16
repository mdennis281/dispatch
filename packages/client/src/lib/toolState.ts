import type { TaskStatusRow, ToolResultRow } from "@dispatch/shared";
import { ackTaskId } from "./subagentRuns.js";

export type ToolCallState = "running" | "ok" | "failed" | "stopped";

/**
 * How one tool call is going, for every surface that draws a status glyph.
 *
 * The subtlety this centralizes: a BACKGROUNDED call answers in milliseconds
 * with a launch ack and keeps working, so its own `result` is a receipt rather
 * than an outcome. Such a call stays "running" until its task settles, and its
 * ok/error flags are ignored — they describe the ack, not the work.
 */
export function toolCallState(result?: ToolResultRow, task?: TaskStatusRow): ToolCallState {
  const backgrounded = !!result && (!!task || !!ackTaskId(result));
  if (!result || (backgrounded && !task)) return "running";
  if (task?.status === "failed" || (!backgrounded && (result.isError || result.ok === false))) {
    return "failed";
  }
  if (task?.status === "stopped") return "stopped";
  return "ok";
}

/** The elapsed time worth showing — never the ack time of a backgrounded call. */
export function toolCallElapsed(result?: ToolResultRow, task?: TaskStatusRow): number | undefined {
  const backgrounded = !!result && (!!task || !!ackTaskId(result));
  return task?.durationMs ?? (backgrounded ? undefined : result?.durationMs);
}
