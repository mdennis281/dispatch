/**
 * The contract between a PR tool and the card that renders it.
 *
 * WHY this exists. Every `mcp__dispatch-github__*_pr` tool answers in prose, because its
 * first reader is a model. The transcript's second reader is a human, who wants
 * the PR's title, its size, who is reviewing and which job went red — and
 * re-deriving that from prose is exactly the kind of guesswork that goes subtly
 * wrong. So each tool also emits ONE machine-readable line, last, which the
 * client parses into a card.
 *
 * The snapshot is FROZEN at the moment the tool ran, deliberately. A card that
 * re-read the live registry would rewrite history: scroll back to the
 * `create_pr` from last Tuesday and it would show today's CI, today's
 * reviewers — a record of an event, quietly restated as the present. The one
 * exception is `watch_pr`, whose entire job IS the present; its card is allowed
 * to prefer the live row and says so.
 */
import * as z from "zod";
import { PrSnapshotSchema } from "./domain.js";

/** Which tool produced the payload — decides what the card's body says. */
export const PrToolKindSchema = z.enum([
  "create_pr",
  "watch_pr",
  "resolve_thread",
  "request_review",
  "post_review",
  "approve_pr",
]);
export type PrToolKind = z.infer<typeof PrToolKindSchema>;

/**
 * What the tool DID, beyond the PR's state.
 *
 * Kept as loose, self-describing lines rather than a per-tool union: the card
 * renders them as an outcome list, and a new tool (or a new refusal reason)
 * should be able to say something useful without a schema change and a client
 * release to match.
 */
export const PrToolOutcomeSchema = z.object({
  /** One-line headline, e.g. "Opened PR #96" or "Refused: merge conflicts". */
  summary: z.string(),
  /** Did the tool do the thing it was asked to do? */
  ok: z.boolean().default(true),
  /** Supporting lines — reviewers asked, threads resolved, blockers found. */
  details: z.array(z.string()).default([]),
});
export type PrToolOutcome = z.infer<typeof PrToolOutcomeSchema>;

/** The tail line a PR tool appends to its result. */
export const PrToolPayloadSchema = z.object({
  /** Envelope version, so an old transcript stays readable by a new client. */
  v: z.literal(1),
  tool: PrToolKindSchema,
  outcome: PrToolOutcomeSchema,
  /**
   * The PR as it stood when the tool ran. Absent when the tool could not read it
   * at all (an unknown number, an unresolvable repo) — the card then shows the
   * outcome alone rather than inventing a PR.
   */
  pr: PrSnapshotSchema.optional(),
});
export type PrToolPayload = z.infer<typeof PrToolPayloadSchema>;

/**
 * The marker that opens the payload line.
 *
 * A sentinel rather than "the last line happens to be JSON": these results end
 * in prose that can itself contain braces, and a card that renders a code block
 * as a PR would be worse than one that renders nothing. Deliberately ugly so it
 * is obvious in a raw transcript that the line is machinery.
 */
export const PR_TOOL_PAYLOAD_MARKER = "<<dispatch:pr>>";

/** Serialize a payload as the tail line of a tool result. */
export function encodePrToolPayload(payload: PrToolPayload): string {
  return `${PR_TOOL_PAYLOAD_MARKER}${JSON.stringify(payload)}`;
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
export function decodePrToolPayload(text: string): {
  payload: PrToolPayload | null;
  text: string;
} {
  const at = lastLineStartMarker(text);
  if (at < 0) return { payload: null, text };
  const after = at + PR_TOOL_PAYLOAD_MARKER.length;
  const end = text.indexOf("\n", after);
  const json = end < 0 ? text.slice(after) : text.slice(after, end);
  // Drop the whole line, including the newline that preceded it.
  const head = at > 0 ? text.slice(0, at - 1) : "";
  const tail = end < 0 ? "" : text.slice(end + 1);
  const prose = (head + (head && tail ? "\n" : "") + tail).trim();
  try {
    const parsed = PrToolPayloadSchema.safeParse(JSON.parse(json));
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
function lastLineStartMarker(text: string): number {
  let from = text.length;
  for (;;) {
    const at = text.lastIndexOf(PR_TOOL_PAYLOAD_MARKER, from);
    if (at < 0) return -1;
    if (at === 0 || text[at - 1] === "\n") return at;
    from = at - 1;
    if (from < 0) return -1;
  }
}
