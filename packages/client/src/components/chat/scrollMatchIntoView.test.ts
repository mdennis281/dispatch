import { describe, expect, it } from "vitest";
import { scrollMatchIntoView } from "./scrollMatchIntoView.js";
import type { TranscriptMatch } from "./transcriptMatches.js";

const PORT = { top: 100, bottom: 600, height: 500 } as DOMRect;

function rect(top: number, height: number, left = 0, width = 40): DOMRect {
  return { top, bottom: top + height, height, left, right: left + width, width } as DOMRect;
}

function container(scrollTop = 0): HTMLElement {
  return { scrollTop, getBoundingClientRect: () => PORT } as unknown as HTMLElement;
}

/** A match whose range reports `rangeRect` and whose row reports `rowRect`. */
function match(rangeRect: DOMRect, rowRect = rangeRect, parent: unknown = null): TranscriptMatch {
  return {
    range: {
      getBoundingClientRect: () => rangeRect,
      startContainer: { parentElement: parent },
    },
    row: { getBoundingClientRect: () => rowRect },
    rowId: "row",
    start: 0,
  } as unknown as TranscriptMatch;
}

describe("scrollMatchIntoView", () => {
  it("scrolls to the match, not to the centre of a row taller than the port", () => {
    // The measured regression: an 800px row holding a hit near its top. Centring
    // the ROW puts the hit above the top edge — counter says "14 of 76", nothing
    // is highlighted on screen.
    const el = container(2000);
    scrollMatchIntoView(el, match(rect(120, 16), rect(110, 800)));

    // Rests 35% down the port: 120 - 100 = 20px in, wants to be at 175.
    expect(el.scrollTop).toBe(2000 + 20 - 175);
  });

  it("leaves the page alone when the match is already comfortably readable", () => {
    const el = container(2000);
    scrollMatchIntoView(el, match(rect(300, 16)));
    expect(el.scrollTop).toBe(2000);
  });

  it("scrolls a match hiding behind the floating jump-to-latest pill", () => {
    const el = container(2000);
    // 80% of 500 = 400 → viewport y 500. A hit at 560 is inside the port but
    // under the pill.
    scrollMatchIntoView(el, match(rect(560, 16)));
    expect(el.scrollTop).toBe(2000 + 460 - 175);
  });

  it("falls back to the row when the match itself has no box", () => {
    const el = container(2000);
    scrollMatchIntoView(el, match(rect(0, 0, 0, 0), rect(50, 30)));
    expect(el.scrollTop).toBe(2000 - 50 - 175);
  });

  it("does nothing when neither the match nor its row is laid out", () => {
    const el = container(2000);
    scrollMatchIntoView(el, match(rect(0, 0, 0, 0), rect(0, 0, 0, 0)));
    expect(el.scrollTop).toBe(2000);
  });

  it("scrolls a hit hidden past the right edge of a wide pre into view", () => {
    const el = container(2000);
    let scrollLeft = 0;
    const pre = {
      scrollWidth: 1200,
      clientWidth: 600,
      get scrollLeft() {
        return scrollLeft;
      },
      set scrollLeft(v: number) {
        scrollLeft = v;
      },
      getBoundingClientRect: () => rect(300, 20, 0, 600),
      parentElement: null,
    };
    scrollMatchIntoView(el, match(rect(300, 16, 900, 40), rect(300, 20), pre));

    // Hit right edge 940 must land 32px inside the pre's right edge (600).
    expect(scrollLeft).toBe(940 - (600 - 32));
  });
});
