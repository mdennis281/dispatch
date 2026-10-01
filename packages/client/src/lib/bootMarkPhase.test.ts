/**
 * A mark that joins the loop late has to say WHERE it joined.
 *
 * A CSS animation starts when it is applied to an element, not at the document's
 * time origin. The splash's mark is in the document from parse, so its 0% and
 * the document's are the same instant — but a `BootMark` on a connecting or
 * updating screen is created whenever that screen appears, and starts its cycle
 * at 0% however long the page has been open.
 *
 * Nothing about the ANIMATION minds; the loop has no beginning. The COLOURS do.
 * The rotation re-dyes the mark from a timer and every tick is placed in a
 * window where the piece it dyes is off screen — and those windows are phases of
 * the loop, which the scheduler reads off `performance.now()`. That is only the
 * phase of a mark whose 0% was the document's. For any other one every tick
 * lands somewhere arbitrary in its cycle, and roads and dots change colour in
 * front of you. Measured before the fix: a mark mounted at 1700ms sat at 0%
 * while the ticks were working to 32.5%.
 *
 * `--boot-phase` is the negative `animation-delay` that closes the gap. This
 * file pins the two halves of it to each other, because they are in different
 * files and in different languages and nothing else would notice them parting.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * LF, whatever the checkout says.
 *
 * `index.html` is LF in the repo, but `core.autocrlf` hands out a CRLF working
 * copy on Windows — and every pattern below that anchors on a newline then stops
 * matching. The failure is silent in the useful direction and loud in the
 * useless one: the suite goes red on a Windows worktree and green in CI, which
 * is how a guard like this gets learned as noise.
 */
const read = (p: string): string =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const html = read("../../index.html");
const bootMark = read("../components/brand/BootMark.tsx");

/** Every rule that carries a piece of the loop, and therefore needs the offset. */
const LOOP_RULES = [".boot-splash__pan", ".boot-splash__road", ".boot-splash__dot"];

describe("a mark that joins the loop late is offset into it", () => {
  for (const rule of LOOP_RULES) {
    it(`${rule} takes its delay from --boot-phase`, () => {
      const block = new RegExp(`\\${rule} \\{([\\s\\S]*?)\\n      \\}`).exec(html);
      expect(block, `no ${rule} rule in index.html`).not.toBeNull();
      expect(
        block![1],
        `${rule} animates part of the loop, so it has to start where the loop is`,
      ).toMatch(/animation-delay:\s*var\(--boot-phase,\s*0ms\)/);
    });
  }

  it("declares the delay AFTER any animation shorthand that would reset it", () => {
    // `.boot-splash__pan` uses the shorthand, which sets every animation-*
    // longhand it does not name — including the delay, to zero.
    const block = /\.boot-splash__pan \{([\s\S]*?)\n      \}/.exec(html)![1]!;
    const shorthand = block.indexOf("animation:");
    const delay = block.indexOf("animation-delay:");
    expect(shorthand, "no animation shorthand to order against").toBeGreaterThan(-1);
    expect(delay, "the shorthand would reset a delay declared above it").toBeGreaterThan(shorthand);
  });

  it("BootMark sets it, as a negative offset into the cycle", () => {
    expect(bootMark).toMatch(/setProperty\(\s*"--boot-phase"/);
    // Negative: a positive delay would hold the mark on its first frame instead.
    expect(bootMark).toMatch(/-\(now % PERIOD_MS\)/);
  });

  /**
   * The dependency array is load-bearing, not tidiness.
   *
   * The delay is measured from the moment the animation STARTED. Re-stamping it
   * on a later render, against a start time that has not moved, shifts the mark
   * by the difference — so an effect that ran every render would reintroduce
   * exactly the drift it exists to remove, and would do it continuously.
   */
  it("stamps the phase on mount, not on every render", () => {
    const effect = /useLayoutEffect\(\(\) => \{[\s\S]*?--boot-phase[\s\S]*?\n  \}, (\[[^\]]*\])\);/.exec(
      bootMark,
    );
    expect(effect, "the phase must be set in a useLayoutEffect WITH a dependency array").not.toBeNull();
    expect(effect![1]).not.toBe("[]");
  });

  it("agrees with --boot-beat about how long a cycle is", () => {
    const beat = /--boot-beat: (\d+)ms/.exec(html);
    const period = /const PERIOD_MS = ([\d_]+);/.exec(bootMark);
    expect(beat).not.toBeNull();
    expect(period, "BootMark needs the period and CSS cannot hand it one").not.toBeNull();
    expect(Number(period![1]!.replace(/_/g, ""))).toBe(Number(beat![1]));
  });
});
