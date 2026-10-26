import { parseSessionLimit, type HarnessLimitHit } from "@dispatch/shared";

/**
 * Did this turn fail because the subscription window ran out, and when does it
 * reopen?
 *
 * The counterpart of Codex's `usageLimitExceeded` error code — except the only
 * evidence is prose, so it goes through the shared sentence parser. Returns
 * undefined for an ordinary error, which is the signal to render the row as a
 * plain failure rather than a scheduled pause.
 */
export function parseClaudeLimitHit(
  text: string | undefined,
  now: number,
): HarnessLimitHit | undefined {
  const limit = parseSessionLimit(text, now);
  if (!limit) return undefined;
  return { resetsAt: limit.resetsAt, reason: text ?? "Usage limit reached." };
}
