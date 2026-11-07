import { isLimitSentence, parseSessionLimit, type HarnessLimitHit } from "@dispatch/shared";

/**
 * Did this turn fail because the subscription window ran out, and when does it
 * reopen?
 *
 * The counterpart of Codex's `usageLimitExceeded` error code — except the only
 * evidence is prose, so it goes through the shared sentence parser. Returns
 * undefined for an ordinary error, which is the signal to render the row as a
 * plain failure rather than a scheduled pause.
 *
 * A limit sentence whose reset time we can't read is STILL a limit, reported
 * with no `resetsAt`. Gating the whole verdict on the time is how the weekly
 * sentence ("resets Nov 11, 6pm") once skipped failover entirely: the account
 * was out, a fallback was configured, and the chat just failed. Failover copes
 * with an unknown reset (it assumes an hour); only parking needs the instant,
 * and the resume scheduler already declines to park without one.
 */
export function parseClaudeLimitHit(
  text: string | undefined,
  now: number,
): HarnessLimitHit | undefined {
  if (!text || !isLimitSentence(text)) return undefined;
  const limit = parseSessionLimit(text, now);
  return { resetsAt: limit?.resetsAt, reason: text };
}
