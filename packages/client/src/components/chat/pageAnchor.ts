/**
 * Keeping the reader's place when an older page is prepended to the transcript.
 *
 * The page is asked for ~400px before the top and lands a network round trip
 * later. The reader does not stop in between: a flick on iOS keeps coasting
 * toward the top the whole time the request is out, and through a reverse
 * proxy that is a long time. The old restore put `scrollTop` back to where it
 * was when the page was ASKED FOR, so every page threw the reader back down by
 * however far they had travelled since — up to 400px — and the write killed
 * their momentum too. Scrolling up through history was a series of shoves
 * backwards until every page had loaded.
 *
 * So the anchor is a ROW, re-measured on every scroll event while the page is
 * in flight, and the correction is applied to where the reader IS when it lands.
 */

export interface PageAnchor {
  /**
   * The top row of the window when the page was requested. Nothing sits above
   * it but the pager button, so a prepend is the only thing that can move it —
   * streaming growth at the bottom and rows resizing below it cannot.
   */
  row: Element | null;
  /** `row`'s offset from the scroller's top edge, as of the latest scroll event. */
  rowTop: number;
  /** Fallback metrics, for when the row doesn't survive the prepend. */
  scrollHeight: number;
  scrollTop: number;
}

export interface ScrollerNow {
  /** Where the anchor row sits now, or `null` if it is no longer in the DOM. */
  rowTop: number | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function measurePageAnchor(scroller: HTMLElement, row: Element | null): PageAnchor {
  return {
    row,
    rowTop: row ? row.getBoundingClientRect().top - scroller.getBoundingClientRect().top : 0,
    scrollHeight: scroller.scrollHeight,
    scrollTop: scroller.scrollTop,
  };
}

/**
 * Where `scrollTop` has to go so the reader sees what they saw before the page.
 *
 * Relative to the CURRENT `scrollTop`: whatever the browser already did about
 * the prepend is in there. Chrome's native scroll anchoring may have corrected
 * it already, in which case the row hasn't moved and this is a no-op; iOS
 * Safari before 27 has no scroll anchoring, so the row has moved by exactly the
 * prepended height and this adds it back.
 *
 * The row can be gone: an incoming `Task` row folds its already-loaded child
 * rows into one subagent card. Then fall back to "same distance from the
 * bottom", which is only as fresh as the last scroll event — close enough for a
 * case that rare.
 */
export function restoredScrollTop(anchor: PageAnchor, now: ScrollerNow): number {
  const target =
    now.rowTop !== null
      ? now.scrollTop + (now.rowTop - anchor.rowTop)
      : now.scrollHeight - anchor.scrollHeight + anchor.scrollTop;
  // The delta can be NEGATIVE (that same fold can leave the transcript shorter
  // than before), so clamp into the range the scroller can actually take.
  const maxTop = Math.max(0, now.scrollHeight - now.clientHeight);
  return Math.min(Math.max(target, 0), maxTop);
}
