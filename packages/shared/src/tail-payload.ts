/**
 * A machine-readable tail line on a prose tool result.
 *
 * The `dispatch-github` PR tools answer in prose (their first reader is a
 * model) and append ONE marked line the transcript parses into a card (its
 * second reader is a human). The issue tools do the same. This is the codec
 * both share, so "how is the envelope found and stripped" is decided once —
 * the PR one grew rules (line-anchored, last match, strip even when unreadable)
 * out of real transcripts, and a second implementation would relearn them.
 */
import type * as z from "zod";

/** Serialize a payload as the tail line of a tool result. */
export function encodeTailPayload(marker: string, payload: unknown): string {
  return `${marker}${JSON.stringify(payload)}`;
}

/**
 * Pull the payload out of a tool result, and give back the prose without it.
 *
 * Never throws, and — just as importantly — never LEAKS. The envelope line is
 * stripped whenever it is found, whether or not it parses: a result from a
 * NEWER build may carry a shape this client cannot read, and the failure mode
 * that must not happen is `<<dispatch:pr>>{…}` rendered to a human as if it
 * were something the agent said. Both directions degrade to "no payload, all
 * prose", which is the pre-existing rendering.
 *
 * The marker is matched only at the START of a line, so prose or a JSON blob
 * that happens to contain the string cannot be mistaken for machinery.
 */
export function decodeTailPayload<T>(
  text: string,
  marker: string,
  schema: z.ZodType<T>,
): { payload: T | null; text: string } {
  const at = lastLineStartMarker(text, marker);
  if (at < 0) return { payload: null, text };
  const after = at + marker.length;
  const end = text.indexOf("\n", after);
  const json = end < 0 ? text.slice(after) : text.slice(after, end);
  // Drop the whole line, including the newline that preceded it.
  const head = at > 0 ? text.slice(0, at - 1) : "";
  const tail = end < 0 ? "" : text.slice(end + 1);
  const prose = (head + (head && tail ? "\n" : "") + tail).trim();
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return { payload: parsed.success ? parsed.data : null, text: prose };
  } catch {
    return { payload: null, text: prose };
  }
}

/**
 * Index of the last marker that begins a line, or -1.
 *
 * Line-anchored on purpose: these results end in a JSON blob written for the
 * model, and prose can quote anything. A marker found mid-line is a
 * coincidence, not an envelope.
 */
function lastLineStartMarker(text: string, marker: string): number {
  let from = text.length;
  for (;;) {
    const at = text.lastIndexOf(marker, from);
    if (at < 0) return -1;
    if (at === 0 || text[at - 1] === "\n") return at;
    from = at - 1;
    if (from < 0) return -1;
  }
}
