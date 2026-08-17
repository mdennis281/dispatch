/**
 * Selection and cursor arithmetic, pulled out of the browser hook so it can be
 * tested without a DOM (the client suite runs in a bare node environment on
 * purpose — see vitest.config.ts).
 *
 * Both of these look trivial and are not. Range-select has to work over the
 * order the LIST is in rather than the order the paths sort in, which stop being
 * the same thing the moment you sort by size. Cursor movement has to wrap, and
 * has to do something sensible when nothing is focused yet — including when the
 * list is empty, where the obvious modulo divides by zero.
 */
import type { FsEntry } from "@dispatch/shared";

/**
 * The paths between `anchor` and `target` inclusive, in DISPLAY order, keeping
 * only the ones this picker will accept.
 *
 * Display order is the whole point: shift-clicking two rows means "and
 * everything I can see between them". Computing the span from sorted paths
 * instead would select a different set the moment the list is sorted by size or
 * date — one that doesn't match the rows the user's eye just traversed.
 *
 * An anchor or target that isn't in the list (a stale selection after a refresh
 * dropped a file) degrades to selecting just the target, which is what a plain
 * click would have done.
 */
export function rangeSelection(
  entries: FsEntry[],
  anchor: string | null,
  target: string,
  isSelectable: (entry: FsEntry) => boolean,
): string[] {
  const to = entries.findIndex((e) => e.path === target);
  if (to < 0) return [];
  const from = anchor ? entries.findIndex((e) => e.path === anchor) : -1;
  if (from < 0) {
    const entry = entries[to];
    return entry && isSelectable(entry) ? [entry.path] : [];
  }
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return entries
    .slice(lo, hi + 1)
    .filter(isSelectable)
    .map((e) => e.path);
}

/**
 * Where ↑/↓ lands.
 *
 * Wraps, so holding Down at the bottom returns to the top rather than sticking
 * — a list you can only leave by scrolling back is worse than one that loops.
 * With nothing focused, Down starts at the first row and Up at the last, which
 * is what makes "open the picker, press Up" reach the end of a long folder in
 * one keystroke.
 */
export function nextCursor(
  entries: FsEntry[],
  cursor: string | null,
  delta: number,
): FsEntry | null {
  if (!entries.length) return null;
  const at = cursor ? entries.findIndex((e) => e.path === cursor) : -1;
  if (at < 0) return (delta > 0 ? entries[0] : entries[entries.length - 1]) ?? null;
  // `+ length` before the modulo: JS `%` keeps the sign, so -1 % 5 is -1, not 4.
  return entries[(at + delta + entries.length) % entries.length] ?? null;
}

/**
 * Drop selected paths that are no longer in the list.
 *
 * A listing refresh after a delete or an external change can remove rows that
 * are still selected, and a selection holding paths that aren't on screen is
 * how "Delete" acts on something the user can't see.
 */
export function pruneSelection(entries: FsEntry[], selected: string[]): string[] {
  const present = new Set(entries.map((e) => e.path));
  return selected.filter((p) => present.has(p));
}
