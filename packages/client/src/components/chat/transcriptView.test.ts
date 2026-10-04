/**
 * Which body the transcript pane shows.
 *
 * The cases that matter are the ones the first version of this fix got wrong:
 * it gated every placeholder on `!running`, so a chat that was mid-turn when
 * its transcript load failed showed NOTHING — not the rows, not the failure —
 * and once live rows arrived the failure could never be reported again. Both
 * are the symptom the whole change exists to remove ("just the newest message
 * or two"), so both are pinned here.
 */
import { describe, it, expect } from "vitest";
import { transcriptView } from "./transcriptView.js";

/** An idle chat holding no rows — the baseline the placeholders are for. */
const bare = { rowCount: 0, running: false, load: "idle" } as const;

describe("transcriptView — an empty pane and a failed one are different news", () => {
  it("shows the empty state only for a chat that genuinely has no messages", () => {
    expect(transcriptView({ ...bare, load: "idle" })).toEqual({ view: "empty", banner: false });
    expect(transcriptView({ ...bare, load: "ready" })).toEqual({ view: "empty", banner: false });
  });

  it("shows a spinner while the request is in flight, never 'No messages yet'", () => {
    expect(transcriptView({ ...bare, load: "loading" })).toEqual({
      view: "loading",
      banner: false,
    });
  });

  it("shows the failure, with no banner doubling it up", () => {
    expect(transcriptView({ ...bare, load: "failed" })).toEqual({
      view: "failed",
      banner: false,
    });
  });

  it("falls back to a BANNER when the chat is running — the stream needs the pane", () => {
    // The reviewer's case. `running` covers `waiting` too, so this is also the
    // chat parked on a permission prompt with no stream at all: before the
    // banner it rendered a blank pane with no hint and no retry.
    expect(transcriptView({ rowCount: 0, running: true, load: "failed" })).toEqual({
      view: "rows",
      banner: true,
    });
  });

  it("keeps the banner once live rows arrive, so the failure can't be masked", () => {
    // The second half of the same bug. `rowCount > 0` puts the placeholder out
    // of reach forever, so without the banner the reader is left holding the
    // newest message or two and no way to ask for the rest.
    expect(transcriptView({ rowCount: 2, running: true, load: "failed" })).toEqual({
      view: "rows",
      banner: true,
    });
    // …and still after the turn ends, because the history is still missing.
    expect(transcriptView({ rowCount: 2, running: false, load: "failed" })).toEqual({
      view: "rows",
      banner: true,
    });
  });

  it("drops the banner once a load actually succeeds", () => {
    expect(transcriptView({ rowCount: 2, running: false, load: "ready" })).toEqual({
      view: "rows",
      banner: false,
    });
  });

  it("never reports the same failure twice on one screen", () => {
    // `view: "failed"` and `banner: true` are the same news told two ways, and
    // together they read as two separate problems.
    for (const running of [true, false]) {
      for (const rowCount of [0, 5]) {
        for (const load of ["idle", "loading", "ready", "failed"] as const) {
          const s = transcriptView({ rowCount, running, load });
          expect(s.view === "failed" && s.banner).toBe(false);
        }
      }
    }
  });

  it("a running chat with rows renders them, whatever the load state", () => {
    // Nothing about a mid-turn chat should ever replace the pane: the rows and
    // the streaming tail are what the reader is there for.
    for (const load of ["idle", "loading", "ready"] as const) {
      expect(transcriptView({ rowCount: 3, running: true, load })).toEqual({
        view: "rows",
        banner: false,
      });
    }
  });
});
