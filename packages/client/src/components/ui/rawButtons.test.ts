/**
 * The no-raw-`<button>` rule, as a ratchet.
 *
 * P5 asked for an ESLint rule banning `<button>` outside `components/ui/`. This
 * repo has no ESLint at all, and CI runs `vitest`, not a linter — so adding the
 * rule "properly" would mean a whole toolchain (eslint + typescript-eslint +
 * the react plugins), a config, a CI step, and a flag day fixing 100+ existing
 * call sites before anything could go green. A test does the same job here with
 * no new dependency and no new CI wiring.
 *
 * It is a RATCHET, not a ban: the count may fall, never rise. A green suite on
 * day one is the point — a rule that starts red is a rule everyone learns to
 * skip. When you reach for a raw `<button>`, use `Button` or `IconButton`
 * instead (they now carry `link` and `toggle` variants precisely because those
 * were the two shapes people kept hand-rolling). If you genuinely need a bare
 * element — a whole row that happens to be clickable, a custom trigger a
 * Popover renders — lower BASELINE by hand in the same commit and say why.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** `packages/client/src`. */
const SRC = fileURLToPath(new URL("../..", import.meta.url));

/** Where raw `<button>` is the primitive rather than a bypass of it. */
const ALLOWED_DIR = join(SRC, "components", "ui");

/**
 * Raw `<button>` elements outside `components/ui/` at the time the ratchet was
 * introduced. Lower this as call sites migrate; never raise it.
 *
 * 85 → 84: the settings modals became pages. Two hand-rolled controls went with
 * them — the project-config section rail and a private on/off switch, now
 * `ui/Switch` — against one bare element added back, the settings rail row,
 * which is a whole row that happens to be clickable.
 *
 * 84 → 83: `chat/FilePathPicker` was deleted. The composer's "Insert file path"
 * now opens the file explorer's picker modal, whose result rows are `role=option`
 * inside a listbox rather than a stack of buttons.
 */
const BASELINE = 83;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function countRawButtons(): { total: number; byFile: [string, number][] } {
  const byFile: [string, number][] = [];
  let total = 0;
  for (const file of walk(SRC)) {
    if (file.startsWith(ALLOWED_DIR)) continue;
    const n = (readFileSync(file, "utf8").match(/<button[\s>]/g) ?? []).length;
    if (n > 0) {
      byFile.push([relative(SRC, file).replace(/\\/g, "/"), n]);
      total += n;
    }
  }
  byFile.sort((a, b) => b[1] - a[1]);
  return { total, byFile };
}

describe("primitive kit", () => {
  it("does not grow the number of raw <button> elements outside components/ui", () => {
    const { total, byFile } = countRawButtons();
    expect(
      total,
      total > BASELINE
        ? `Raw <button> count rose ${BASELINE} → ${total}. Use Button/IconButton ` +
            `(variants: default, primary, subtle, ghost, danger, link, toggle) — or, if a ` +
            `bare element is genuinely right here, lower BASELINE in this file and say why.\n` +
            `Worst offenders: ${byFile
              .slice(0, 5)
              .map(([f, n]) => `${f} (${n})`)
              .join(", ")}`
        : `Raw <button> count fell to ${total}. Lower BASELINE in this file to lock the win in.`,
    ).toBe(BASELINE);
  });
});
