/**
 * Claude Code's own auto-compact trigger, and how Dispatch's threshold maps
 * onto it. Moved here from `@dispatch/shared` (#428): no other provider has an
 * `autoCompactWindow`, so the numbers below are facts about this CLI alone.
 */

/**
 * How far below its auto-compact window Claude Code actually compacts: it
 * reserves min(max output, 20k) for the reply plus a 13k buffer. Measured on
 * CLI 2.1.293 — a 100k window compacted at 65–68k, every time.
 */
export const CLAUDE_COMPACT_HEADROOM = 33_000;
/** The range the CLI's `autoCompactWindow` setting accepts; outside it the value is silently dropped. */
export const CLAUDE_COMPACT_WINDOW_MIN = 100_000;
export const CLAUDE_COMPACT_WINDOW_MAX = 1_000_000;

/**
 * The `autoCompactWindow` to hand Claude Code so its OWN trigger fires at
 * Dispatch's threshold. That trigger runs between requests inside a turn; the
 * broker's turn-end check alone let one long agentic turn run from 100k to
 * 720k without compacting, because the turn never ended.
 *
 * `configured` is the raw Settings window, honoured only where the CLI would
 * honour it (a 20k "reserve" typed there was always ignored, and still is).
 * Below the CLI's floor a threshold can't be expressed natively; the window is
 * clamped up and the turn-end check covers the gap.
 */
export function claudeCompactWindow(
  threshold: number | undefined,
  configured: number | undefined,
): number | undefined {
  const valid =
    configured && configured >= CLAUDE_COMPACT_WINDOW_MIN && configured <= CLAUDE_COMPACT_WINDOW_MAX
      ? configured
      : undefined;
  if (!threshold) return valid;
  const fromThreshold = Math.min(
    CLAUDE_COMPACT_WINDOW_MAX,
    Math.max(CLAUDE_COMPACT_WINDOW_MIN, threshold + CLAUDE_COMPACT_HEADROOM),
  );
  return valid ? Math.min(valid, fromThreshold) : fromThreshold;
}
