import { describe, expect, it } from "vitest";
import { restoredScrollTop, type PageAnchor } from "./pageAnchor.js";

const PREPENDED = 6000;

/** An anchor as the last scroll event before the page landed measured it. */
function askedAt(scrollTop: number, rowTop: number): PageAnchor {
  return { row: null, rowTop, scrollHeight: 10_000, scrollTop };
}

describe("restoredScrollTop", () => {
  it("restores to where the reader IS when the page lands, not where they asked for it", () => {
    // Asked at 380 with the first row 40px down; the flick coasted on to the
    // very top, where onScroll re-measured the row at 420px down.
    const anchor = askedAt(0, 420);
    // No native anchoring (iOS < 27): scrollTop is untouched, the row moved down
    // by exactly the prepended height.
    const top = restoredScrollTop(anchor, {
      rowTop: 420 + PREPENDED,
      scrollTop: 0,
      scrollHeight: 10_000 + PREPENDED,
      clientHeight: 800,
    });
    // Same row, same place on screen. The old restore landed at PREPENDED + 380:
    // thrown 380px back down the transcript.
    expect(top).toBe(PREPENDED);
  });

  it("is a no-op when the browser already anchored the prepend itself", () => {
    const anchor = askedAt(120, 300);
    // Chrome moved scrollTop for us, so the row is where it was on screen.
    const top = restoredScrollTop(anchor, {
      rowTop: 300,
      scrollTop: 120 + PREPENDED,
      scrollHeight: 10_000 + PREPENDED,
      clientHeight: 800,
    });
    expect(top).toBe(120 + PREPENDED);
  });

  it("ignores growth below the row — a stream landing at the bottom is not a prepend", () => {
    const anchor = askedAt(0, 40);
    const top = restoredScrollTop(anchor, {
      rowTop: 40 + PREPENDED,
      scrollTop: 0,
      // 900px of streamed reply arrived at the bottom while the page was out.
      scrollHeight: 10_000 + PREPENDED + 900,
      clientHeight: 800,
    });
    expect(top).toBe(PREPENDED);
  });

  it("falls back to distance-from-bottom when the row was folded away", () => {
    const anchor = askedAt(200, 40);
    const top = restoredScrollTop(anchor, {
      rowTop: null,
      scrollTop: 200,
      scrollHeight: 10_000 + PREPENDED,
      clientHeight: 800,
    });
    expect(top).toBe(200 + PREPENDED);
  });

  it("clamps into the scrollable range when a fold left the transcript shorter", () => {
    const anchor = askedAt(300, 40);
    expect(
      restoredScrollTop(anchor, { rowTop: null, scrollTop: 300, scrollHeight: 9_000, clientHeight: 800 }),
    ).toBe(0);
    expect(
      restoredScrollTop(anchor, { rowTop: 40 + 50_000, scrollTop: 300, scrollHeight: 2_000, clientHeight: 800 }),
    ).toBe(1_200);
  });
});
