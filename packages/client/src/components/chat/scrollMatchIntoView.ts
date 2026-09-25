import type { TranscriptMatch } from "./transcriptMatches.js";

/**
 * Bringing a search hit into view, as `Ctrl+F` does it.
 *
 * The obvious `match.row.scrollIntoView({ block: "center" })` is wrong for this
 * transcript for two measured reasons:
 *
 *   1. A row is not a line. Transcript rows routinely run 600–800px in a ~500px
 *      scrollport, so centring the ROW puts a hit near its top ABOVE the top
 *      edge — the counter says "14 of 76" and the viewport shows no highlight
 *      at all. Scrolling to the RANGE is the only thing that can't do that.
 *   2. Shell commands and file paths live in horizontally scrolling `<pre>`s,
 *      where the hit is off to the right of a truncated line. Vertical centring
 *      leaves it just as invisible.
 *
 * The comfort band exists for the third case: several hits inside one short
 * row. Re-centring the page when the next hit is already plainly readable makes
 * stepping feel like teleporting; leaving the page still and letting the
 * current-match highlight colour do the talking is what a browser's find does.
 */

/** Where a hit comes to rest, as a fraction of scrollport height. */
const REST_FRACTION = 0.35;
/** A hit already inside this band is readable — don't move the page. */
const COMFORT_TOP = 0.08;
/** Kept clear of the bottom: the "Jump to latest" pill floats over that strip. */
const COMFORT_BOTTOM = 0.8;
/** Breathing room when scrolling a hit in horizontally. */
const X_PADDING = 32;

function isEmptyRect(rect: DOMRect): boolean {
  return rect.width === 0 && rect.height === 0;
}

/**
 * Scroll every horizontally scrollable ancestor between the hit and the
 * transcript so the hit is not hidden past the right edge of a wide `<pre>`.
 *
 * Re-measured after each step because scrolling one ancestor moves the hit's
 * viewport rect, and the next ancestor up must be judged against where it is
 * NOW, not where it started.
 */
function revealHorizontally(range: Range, stopAt: HTMLElement): void {
  let el = range.startContainer.parentElement;
  while (el && el !== stopAt) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const rect = range.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      if (rect.left < box.left + X_PADDING) {
        el.scrollLeft -= box.left + X_PADDING - rect.left;
      } else if (rect.right > box.right - X_PADDING) {
        el.scrollLeft += rect.right - (box.right - X_PADDING);
      }
    }
    el = el.parentElement;
  }
}

/**
 * Put `match` where it can be read inside `container`.
 *
 * Jumps instantly rather than smoothly on purpose: each `scrollIntoView` with
 * `behavior: "smooth"` CANCELS the one before it, so holding Enter through a
 * run of matches animates toward the first and arrives nowhere near the last.
 */
export function scrollMatchIntoView(container: HTMLElement, match: TranscriptMatch): void {
  // A hit inside collapsed or otherwise unlaid-out content has no box of its
  // own; its row is the closest honest answer to "where is this".
  let rect = match.range.getBoundingClientRect();
  if (isEmptyRect(rect)) rect = match.row.getBoundingClientRect();
  if (isEmptyRect(rect)) return;

  const port = container.getBoundingClientRect();
  const top = rect.top - port.top;
  const bottom = rect.bottom - port.top;
  const height = port.height;

  if (top < height * COMFORT_TOP || bottom > height * COMFORT_BOTTOM) {
    container.scrollTop += top - height * REST_FRACTION;
  }
  revealHorizontally(match.range, container);
}
