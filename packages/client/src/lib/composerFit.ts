/**
 * How the composer toolbar decides how big each control gets.
 *
 * The row is one line, `flex-nowrap`, with Send pinned to its right end. Every
 * control you switch on competes for the same strip, and that strip is anywhere
 * from ~1100px on a wide desktop to ~342px inside a 390px phone. The old answer
 * was a single `compact` boolean plus a hard "below md, move most of it into a
 * sheet" rule — which meant a phone couldn't show effort at all, and a 700px
 * window threw away every label the moment one control overflowed.
 *
 * The answer here is a ladder. Each control declares the sizes it actually has
 * (see `COMPOSER_CONTROLS.sizes`) and the row walks every control down that
 * ladder — lg → md → sm → off — until it fits. Two rules give the walk its
 * shape:
 *
 *   1. LEVEL DOWN BEFORE DROPPING. The next control to shrink is always the
 *      one that is currently BIGGEST. So a cramped row becomes all-medium, then
 *      all-icons, and only starts evicting once every control is already an
 *      icon. You never lose the context meter while the model picker still
 *      wears a full label.
 *   2. PRIORITY BREAKS TIES. Between two controls at the same rung, the lower
 *      priority shrinks (and eventually leaves) first.
 *
 * Nothing is ever lost by leaving: the composer options menu holds every
 * control at every width, which is what makes eviction an acceptable last rung
 * rather than a bug.
 *
 * This module is pure — no DOM, no React. The component measures and calls
 * `demote`/`promote` one step at a time; the convergence loop lives there
 * because only it can read `scrollWidth`. Keeping the policy separable is also
 * what makes it testable, since jsdom lays nothing out and would report every
 * width as 0.
 */
import {
  COMPOSER_CONTROLS,
  ladderOf,
  rungCost,
  widestSize,
  type ComposerControl,
  type ComposerVisibility,
  type ControlSize,
} from "./composerPrefs.js";

/** The size each control is currently drawn at; `off` means "not in the row". */
export type ComposerSizes = Record<ComposerControl, ControlSize>;

/** The rung below `size` on this control's ladder, or `off` past the end. */
function stepDown(id: ComposerControl, size: ControlSize): ControlSize | null {
  if (size === "off") return null;
  const ladder = ladderOf(id);
  const i = ladder.indexOf(size);
  // Not on the ladder at all (a stale size from an older build) — treat the
  // widest rung as the answer rather than getting stuck.
  if (i < 0) return ladder[0]!;
  return ladder[i + 1] ?? "off";
}

/** The rung above `size`, or null when already at this control's widest. */
function stepUp(id: ComposerControl, size: ControlSize): ControlSize | null {
  const ladder = ladderOf(id);
  if (size === "off") return ladder[ladder.length - 1]!;
  const i = ladder.indexOf(size);
  if (i < 0) return ladder[0]!;
  return i === 0 ? null : ladder[i - 1]!;
}

/** Everything visible at its widest — the layout we try for before measuring. */
export function widestSizes(visible: ComposerVisibility): ComposerSizes {
  return Object.fromEntries(
    COMPOSER_CONTROLS.map((c) => [c.id, visible[c.id] ? widestSize(c.id) : "off"]),
  ) as ComposerSizes;
}

/**
 * Fold a visibility change into an existing layout: a control you just switched
 * off goes to `off`, one you switched on comes back at its widest and lets the
 * measuring loop shrink it (and its neighbours) from there. Returns the same
 * object when nothing changed, so it can be used straight inside a setState.
 */
export function reconcile(sizes: ComposerSizes, visible: ComposerVisibility): ComposerSizes {
  let changed = false;
  const next = { ...sizes };
  for (const c of COMPOSER_CONTROLS) {
    const want = visible[c.id] ? (sizes[c.id] === "off" ? widestSize(c.id) : sizes[c.id]) : "off";
    if (want !== next[c.id]) {
      next[c.id] = want;
      changed = true;
    }
  }
  return changed ? next : sizes;
}

/**
 * Shrink exactly one control by one rung — the biggest one, lowest priority
 * first among equals. Returns null when everything visible is already `off`,
 * which is the layout's way of saying it has nothing left to give.
 */
export function demote(sizes: ComposerSizes, visible: ComposerVisibility): ComposerSizes | null {
  let pick: ComposerControl | null = null;
  let pickCost = Infinity;
  let pickPriority = Infinity;
  for (const c of COMPOSER_CONTROLS) {
    if (!visible[c.id] || sizes[c.id] === "off") continue;
    const cost = rungCost(sizes[c.id]);
    // Strictly-biggest wins; equal-biggest goes to the lower priority.
    if (cost < pickCost || (cost === pickCost && c.priority < pickPriority)) {
      pick = c.id;
      pickCost = cost;
      pickPriority = c.priority;
    }
  }
  if (!pick) return null;
  const next = stepDown(pick, sizes[pick]);
  return next ? { ...sizes, [pick]: next } : null;
}

/**
 * The exact inverse: grow one control by one rung — the smallest one, highest
 * priority first among equals — so a widening window unwinds the shrinking in
 * the order it happened. Returns null when everything is already at its widest.
 */
export function promote(sizes: ComposerSizes, visible: ComposerVisibility): ComposerSizes | null {
  let pick: ComposerControl | null = null;
  let pickCost = -Infinity;
  let pickPriority = -Infinity;
  for (const c of COMPOSER_CONTROLS) {
    if (!visible[c.id]) continue;
    if (sizes[c.id] === widestSize(c.id)) continue;
    const cost = rungCost(sizes[c.id]);
    if (cost > pickCost || (cost === pickCost && c.priority > pickPriority)) {
      pick = c.id;
      pickCost = cost;
      pickPriority = c.priority;
    }
  }
  if (!pick) return null;
  const next = stepUp(pick, sizes[pick]);
  return next ? { ...sizes, [pick]: next } : null;
}

/** How many visible controls the row had to push out into the options menu. */
export function evictedCount(sizes: ComposerSizes, visible: ComposerVisibility): number {
  return COMPOSER_CONTROLS.filter((c) => visible[c.id] && sizes[c.id] === "off").length;
}
