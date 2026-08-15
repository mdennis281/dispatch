/** What one `ResizeObserver` pass on an ellipsized label has to work with. */
export interface OverflowMetrics {
  /** Widest content width — the hidden measuring span's, or the node's own. */
  measuredWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Was the text cut? `null` means UNMEASURABLE — keep whatever was decided last.
 *
 * A transcript row is `content-visibility: auto` (see `.cm-row-cv`), so the
 * browser SKIPS its subtree whenever it scrolls out of view — and a skipped
 * subtree reports every box as 0x0 AND fires the observer on both the skip and
 * the unskip. Treating that as a measurement flips `overflowing` off on the way
 * out and back on on the way in, for every ellipsized label in every row the
 * reader scrolls past. Each flip swaps the label's box between a bare span and a
 * `Tooltip` trigger, re-runs Prism over the command inside it, and moves the
 * scroller's `scrollHeight` — which is what makes a long chat lag, snap and
 * flicker as you scroll it.
 *
 * A box that is laid out but happens to be 0 wide (a flex item crushed by a
 * sibling) still has a height, so it is measured normally.
 */
export function measureOverflow(m: OverflowMetrics): boolean | null {
  if (m.clientWidth === 0 && m.clientHeight === 0) return null;
  return m.measuredWidth > m.clientWidth + 1 || m.scrollHeight > m.clientHeight + 1;
}
