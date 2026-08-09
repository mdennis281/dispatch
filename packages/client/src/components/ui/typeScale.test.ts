/**
 * The type scale, enforced.
 *
 * P4 collapsed twelve arbitrary font sizes (~540 uses, including both
 * `text-[11px]` and `text-[11.5px]`) onto six named steps. Without a guard that
 * is a one-day win: the next `text-[11.5px]` costs nobody anything to type and
 * reviews clean, and the drift starts over. Unlike the raw-`<button>` ratchet
 * this one is absolute, because the codemod took the count to zero — there is
 * no legacy to grandfather, so anything it finds is new.
 *
 * Scale: text-2xs 10 / xs 11 / sm 12 / base 12.5 / lg 13.5 / xl 15 (index.css).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("type scale", () => {
  it("has no arbitrary font sizes left in the client", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      // Skip this file: the pattern below is spelled out in it verbatim.
      if (file.endsWith("typeScale.test.ts")) continue;
      for (const [i, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
        if (/text-\[\d+(\.\d+)?px\]/.test(line)) {
          offenders.push(`${relative(SRC, file).replace(/\\/g, "/")}:${i + 1}`);
        }
      }
    }
    expect(
      offenders,
      `Arbitrary font size(s) found. Use the scale: text-2xs (10) / text-xs (11) / ` +
        `text-sm (12) / text-base (12.5) / text-lg (13.5) / text-xl (15). ` +
        `If a new step is genuinely needed, add it to @theme in index.css and name it.`,
    ).toEqual([]);
  });
});
