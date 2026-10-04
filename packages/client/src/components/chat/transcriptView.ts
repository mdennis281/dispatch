/**
 * What the transcript pane should show: the rows, or one of the three
 * "nothing to show" placeholders — plus whether a failure still needs saying
 * alongside the rows.
 *
 * A pure function beside the component, in the shape of `chatHeaderRefs`,
 * because the decision has four inputs and the interesting cases are the ones
 * that are awkward to stage in a browser: a chat that is mid-turn when its
 * transcript GET fails, and a chat whose live rows arrive after it failed.
 * Both were wrong in the first version of this fix and neither was catchable
 * without rendering, which is why this moved out of the JSX.
 */
import type { ChatPage } from "../../stores/messages.js";

export type TranscriptView = "rows" | "empty" | "loading" | "failed";

export interface TranscriptViewState {
  /** Which of the four bodies the pane renders. */
  view: TranscriptView;
  /**
   * Show the failure as a strip above the rows. Never set together with
   * `view: "failed"` — that is the same news told the other way, and telling it
   * twice on one screen reads as two different problems.
   */
  banner: boolean;
}

/**
 * `running` means the chat's status is `running` OR `waiting` — not "tokens are
 * arriving". A `waiting` chat is parked on a permission prompt with nothing
 * streaming at all, which is why it cannot be treated as "the stream carries
 * the screen".
 */
export function transcriptView(input: {
  rowCount: number;
  running: boolean;
  load: ChatPage["load"];
}): TranscriptViewState {
  const { rowCount, running, load } = input;

  // The full-height placeholders need a pane with nothing else in it. With rows
  // present, or a turn in flight, taking the whole pane would hide what the
  // reader is actually here for.
  const bare = rowCount === 0 && !running;

  if (bare) {
    if (load === "loading") return { view: "loading", banner: false };
    if (load === "failed") return { view: "failed", banner: false };
    return { view: "empty", banner: false };
  }

  // Otherwise the rows (or the streaming tail) render, and a failed load is
  // reported beside them. It persists until a load SUCCEEDS: until then the
  // history above these rows is still missing, and the reader needs the retry.
  return { view: "rows", banner: load === "failed" };
}
