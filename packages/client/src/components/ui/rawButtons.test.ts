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
 *
 * 83 → 82: the media work added two in-prose chips and a viewer nav control, and
 * paid for all three. `codeRefs`' pointer chip and the new media chip are now one
 * `ui/InlineChip` — a chip that sits in a line of prose genuinely can't be
 * `Button`, which starts at h-6 and would open the line box. The viewer's
 * prev/next is `Button circle`.
 *
 * 82 → 83: the session detail work. An Active-sessions row is a two-line
 * disclosure target — device label above, last-seen and network below, with the
 * Revoke `Button` beside it — so the clickable thing is the row itself, not a
 * control inside it. `Button` cannot be that without dropping its own padding,
 * height floor and single-line layout, which is the whole component.
 *
 * 83 → 84: the sidebar's nested `ReviewRow`, for the same reason and in the same
 * file as the `ChatRow` directly above it, which has always been a bare element.
 * It's a full-width row of a glyph, a fixed `#139`, a summary that truncates and
 * an age pinned right — and `Button` is `h-6 justify-center whitespace-nowrap`
 * with padding of its own, every one of which this row would have to override.
 *
 * 84 → 87: the Mission board preview (`preview/mission/`). It arrived with 27
 * bare elements and pays for 24 of them: the icon-only and text actions became
 * `IconButton` and `Button` (`danger`, `subtle`, `link`, `default`), and the
 * fifteen navigation rows — sidebar tree entries, dependency rows, hire rows —
 * collapsed onto ONE wrapper, `chrome.tsx`'s `RowButton`, which is the same
 * argument as `ReviewRow` above made once instead of fifteen times.
 *
 * The three that remain are all in `chrome.tsx` and are each a shape the kit
 * does not have: `RowButton` itself; `Tunable`, an editable value that sits
 * inline in a line of prose, where `Button`'s `h-6` would open the line box
 * (the same reason `InlineChip` exists); and `Section`'s header toggle, which
 * is a disclosure heading rather than an action.
 */
const BASELINE = 87;

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
