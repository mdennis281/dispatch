/**
 * A mark that joins the loop late has to be put where the loop already is.
 *
 * A CSS animation starts when it is applied to an element, not at the document's
 * time origin. The splash's mark is in the document from parse, so its 0% and
 * the document's are the same instant — but a `BootMark` on a connecting or
 * updating screen is created when that screen appears, and starts its cycle at
 * 0% however long the page has been open.
 *
 * Nothing about the ANIMATION minds; the loop has no beginning. The COLOURS do.
 * The rotation re-dyes the mark from a timer and every tick is placed in a
 * window where the piece it dyes is off screen — and those windows are phases of
 * the loop, which the scheduler reads off `performance.now()`. That is only the
 * phase of a mark whose cycle is aligned to the document's. For any other one
 * every tick lands somewhere arbitrary in its cycle, and roads and dots change
 * colour in front of you. Measured before the fix: a mark mounted at 1700ms drew
 * 0.0% while the ticks worked to 74.6%, and five pieces changed colour on screen
 * over fifteen seconds.
 *
 * This can only be pinned by reading the source: the client's vitest runs in a
 * node environment, so there is no document to mount into and no animation to
 * interrogate. What it is really guarding is the SHAPE of the fix — that the
 * alignment is absolute rather than an offset measured from "now", which is the
 * version that has to guess which renders followed a restart and is wrong in
 * both directions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * LF, whatever the checkout says.
 *
 * These files are LF in the repo, but `core.autocrlf` hands out a CRLF working
 * copy on Windows — and every pattern that anchors on a newline then stops
 * matching. The failure is loud in the useless direction: red on a Windows
 * worktree and green in CI, which is how a guard gets learned as noise.
 */
const read = (p: string): string =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const bootMark = read("../components/brand/BootMark.tsx");
const html = read("../../index.html");

describe("a mark that joins the loop late is aligned to the document's clock", () => {
  /**
   * `startTime = 0` makes elapsed time equal document time, so the phase is
   * `documentTime % period` — exactly what the tick scheduler assumes, and
   * without this file's subject having to know what the period is.
   */
  it("moves the loop's animations to the timeline origin", () => {
    expect(bootMark).toMatch(/\.startTime = 0/);
  });

  /**
   * An offset computed from the current time is the version this replaced. It
   * only lands correctly on a render that FOLLOWS a restart — on any other one
   * it shifts the mark by however long it has been running, which is the drift
   * it was meant to remove.
   */
  it("does not derive the alignment from the current time", () => {
    const fn = /const align = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[\]\);/.exec(bootMark);
    expect(fn, "no align callback to check").not.toBeNull();
    expect(fn![0], "align absolutely, not by an offset from now").not.toMatch(
      /performance\.now\(\)|timeline\??\.currentTime/,
    );
  });

  /**
   * A restart is not always followed by a render.
   *
   * Tearing the canvas down un-hides the SVG, and a `display: none` SVG has no
   * animations — so the ones that come back are new, at 0%. On a size change
   * React runs the layout effect BEFORE that cleanup, while there is still
   * nothing to align, and then nothing re-renders: measured, the mark comes back
   * drawing 0.0% against ticks working to 12.6%. Aligning inside the cleanup is
   * what closes it (17.5% against 18.3%, one frame apart).
   */
  it("re-aligns where the canvas is torn down", () => {
    const cleanup = /return \(\) => \{[\s\S]*?\n    \};/.exec(bootMark);
    expect(cleanup, "no canvas cleanup to check").not.toBeNull();
    expect(cleanup![0]).toMatch(/removeAttribute\("data-canvas"\)/);
    expect(cleanup![0], "un-hiding the SVG restarts it; nothing may re-render after").toMatch(
      /\balign\(\)/,
    );
  });

  /** Only the loop's own animations are ours to move. */
  it("touches only the splash's animations", () => {
    expect(bootMark).toMatch(/startsWith\("boot-splash-"\)/);
  });

  /**
   * And the assumption itself is written down where it is made, so the next
   * person to place a tick knows it is only true of a mark that was here at
   * parse — which the splash is and nothing else is.
   */
  it("says so where the ticks are scheduled", () => {
    const scheduler = /function startTicks\(\)[\s\S]*?\n        \}/.exec(html);
    expect(scheduler, "no startTicks in index.html").not.toBeNull();
    expect(scheduler![0]).toMatch(/applied to an element/);
  });
});
