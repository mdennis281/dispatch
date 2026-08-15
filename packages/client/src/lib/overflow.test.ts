import { describe, expect, it } from "vitest";
import { measureOverflow } from "./overflow.js";

describe("measureOverflow", () => {
  it("reports a cut when the content is wider than the box", () => {
    expect(
      measureOverflow({ measuredWidth: 400, clientWidth: 200, scrollHeight: 16, clientHeight: 16 }),
    ).toBe(true);
  });

  it("reports a cut when a clamped box is shorter than its content", () => {
    expect(
      measureOverflow({ measuredWidth: 100, clientWidth: 200, scrollHeight: 48, clientHeight: 32 }),
    ).toBe(true);
  });

  it("tolerates a sub-pixel measurement without claiming a cut", () => {
    expect(
      measureOverflow({ measuredWidth: 201, clientWidth: 200, scrollHeight: 17, clientHeight: 16 }),
    ).toBe(false);
  });

  /**
   * The regression this file exists for. A transcript row scrolled out of view is
   * skipped by `content-visibility: auto`, which reports every box as 0x0 and
   * fires the ResizeObserver. Answering `false` there flips every ellipsized
   * label in the row off, and back on again the moment it scrolls back in.
   */
  it("declines to answer for a skipped (0x0) subtree", () => {
    expect(
      measureOverflow({ measuredWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0 }),
    ).toBeNull();
  });

  it("still answers for a laid-out box that is merely zero-width", () => {
    expect(
      measureOverflow({ measuredWidth: 120, clientWidth: 0, scrollHeight: 16, clientHeight: 16 }),
    ).toBe(true);
  });
});
