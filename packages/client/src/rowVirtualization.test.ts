/**
 * `content-visibility` on transcript rows must stay behind the MEASURED
 * anchoring flag, and must never go back behind a feature query.
 *
 * The regression this guards is expensive and silent. `.cm-row-cv` gives rows
 * `content-visibility: auto`, so an unseen row is a 90px `contain-intrinsic-
 * size` placeholder that becomes its real height as you scroll up into it —
 * above the reader. Only scroll anchoring absorbs that.
 *
 * PR #218 tried to disable it where anchoring is missing with `@supports not
 * (overflow-anchor: auto)`. That never fired: `@supports` asks whether a
 * declaration PARSES, and WebKit parses `overflow-anchor` (a real WebKit
 * answers `CSS.supports("overflow-anchor","auto") === true`) while older iOS
 * does not act on it. The bug therefore shipped looking fixed for months, and
 * only the on-device interaction tracer caught it — on iOS 18.7, 97 of 98 row
 * resizes came from exactly 90px, 63 of them above the reader.
 *
 * So the rule is: the optimization is OPT-IN behind `[data-cm-anchor="native"]`,
 * which `lib/scrollAnchoring.ts` sets only after measuring the behaviour. A
 * bare `.cm-row-cv { content-visibility: auto }` would re-enable it everywhere,
 * and a feature query would re-enable it on exactly the devices that break.
 *
 * Static, because the client's vitest runs in `node` with no DOM — the same
 * reason `ui/rawButtons.test.ts` and `scroll-chaining.test.ts` are static.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Comments STRIPPED first. Every claim below is about what the stylesheet
// DOES, and the docblock above the rule necessarily quotes the broken gate it
// replaced — scanning the raw text matches that prose and fails on a file that
// is entirely correct. `rows/mediaCoverage.test.ts` strips for the same reason.
const css = readFileSync(fileURLToPath(new URL("./index.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Every `selector { ... }` block whose body mentions `content-visibility`. */
function blocksWithContentVisibility(): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const selector = m[1]!.trim().split("\n").pop()!.trim();
    const body = m[2]!;
    if (/content-visibility\s*:/.test(body)) out.push({ selector, body });
  }
  return out;
}

describe("transcript row virtualization", () => {
  it("only enables content-visibility behind the measured anchoring flag", () => {
    const blocks = blocksWithContentVisibility().filter((b) => b.selector.includes(".cm-row-cv"));
    expect(blocks.length, "expected a .cm-row-cv content-visibility rule").toBeGreaterThan(0);
    for (const b of blocks) {
      // A rule that TURNS IT ON must be gated. One that turns it off may not be.
      if (/content-visibility\s*:\s*auto/.test(b.body)) {
        expect(
          b.selector,
          `"${b.selector}" enables content-visibility without the measured flag — see lib/scrollAnchoring.ts`,
        ).toContain('[data-cm-anchor="native"]');
      }
    }
  });

  it("does not gate row virtualization on an overflow-anchor feature query", () => {
    // `@supports` reports PARSING, not behaviour, and WebKit parses this
    // property. Any @supports condition naming it is the old, broken gate.
    const conditions = css.match(/@supports[^{]*/g) ?? [];
    for (const c of conditions) {
      expect(c, "overflow-anchor cannot be feature-detected — probe the behaviour instead").not.toMatch(
        /overflow-anchor/,
      );
    }
  });

  it("keeps the placeholder paired with the property it sizes", () => {
    // `contain-intrinsic-size` without `content-visibility` is inert, and
    // `content-visibility` without it makes the scrollbar lie. Splitting them
    // across rules is how one of them quietly gets dropped.
    for (const b of blocksWithContentVisibility()) {
      if (!b.selector.includes(".cm-row-cv")) continue;
      if (/content-visibility\s*:\s*auto/.test(b.body)) {
        expect(b.body, `"${b.selector}" sets content-visibility with no intrinsic size`).toMatch(
          /contain-intrinsic-size\s*:/,
        );
      }
    }
  });
});
