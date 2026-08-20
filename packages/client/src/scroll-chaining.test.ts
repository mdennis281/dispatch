import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the fix for the invisible wheel trap that killed transcript scrolling.
 *
 * `.cm-scroll` carries `overscroll-behavior: contain`, which is right for the
 * real vertical panes. But CSS refuses to pair `overflow-x: auto` with
 * `overflow-y: visible` — setting one axis non-visible forces the other to
 * `auto`. So a wrapper that only ever wanted a SIDEWAYS scrollbar (a markdown
 * table, a code block, a breadcrumb strip) is silently a scroll container on
 * both axes and inherits `contain` on the vertical one.
 *
 * It has no vertical overflow, so it paints no scrollbar and cannot scroll — and
 * `contain` STILL refuses to hand the wheel up to the transcript. Measured
 * against the shipped CSS: wheeling over a table moved the transcript 0px, where
 * plain prose moved 300px. Nothing on screen explained why.
 *
 * `.cm-scroll-x` releases the vertical axis. These are static checks rather than
 * a browser test because the regression vector is a person adding `cm-scroll` to
 * a NEW horizontal wrapper and never learning this rule.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every double-quoted string literal in a source file. */
function stringLiterals(source: string): string[] {
  return source.match(/"(?:[^"\\n]|\.)*"/g) ?? [];
}

describe("scroll chaining", () => {
  const css = readFileSync(join(SRC, "index.css"), "utf8");

  it("keeps `.cm-scroll` containing its own overscroll", () => {
    // The reason the class exists: a flick that runs off the end of the
    // transcript must not move the shell (and the bottom nav with it).
    expect(css).toMatch(/\.cm-scroll\s*\{[^}]*overscroll-behavior:\s*contain/);
  });

  it("defines `.cm-scroll-x` releasing ONLY the vertical axis", () => {
    const block = /\.cm-scroll-x\s*\{([^}]*)\}/.exec(css);
    expect(block, "`.cm-scroll-x` is missing from index.css").not.toBeNull();
    expect(block![1]).toMatch(/overscroll-behavior-y:\s*auto/);
    // Sideways overscroll must stay contained, or running off the end of a wide
    // table hands the gesture to the browser as a back-navigation.
    expect(block![1]).not.toMatch(/overscroll-behavior-x|overscroll-behavior:/);
  });

  it("pairs every horizontal-only `.cm-scroll` with `.cm-scroll-x`", () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      for (const literal of stringLiterals(readFileSync(file, "utf8"))) {
        const horizontal = /\boverflow-x-(auto|scroll)\b/.test(literal);
        // `\bcm-scroll\b` matches the base class without matching `cm-scroll-x`.
        const themed = /\bcm-scroll\b/.test(literal);
        if (!horizontal || !themed) continue;
        if (/\bcm-scroll-x\b/.test(literal)) continue;
        offenders.push(`${file.replace(SRC, "")}: ${literal}`);
      }
    }

    expect(
      offenders,
      "these wrap horizontally but trap the vertical wheel — add `cm-scroll-x`",
    ).toEqual([]);
  });
});
