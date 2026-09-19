/**
 * The contract between an issue tool and the card that renders it — the
 * issue-side twin of `pr-tools`.
 *
 * WHY this exists. `mcp__dispatch-issues__*` answers in fenced prose, because
 * its first reader is a model and the issue's text is untrusted input that has
 * to arrive labelled as such. The transcript's second reader is a human, who
 * wants the issue's title, who opened it, its labels, the comment they just
 * posted — and reconstructing that from the fenced prose is exactly the kind of
 * guesswork that goes wrong. So each tool also emits ONE machine-readable line,
 * last, which the client parses into a card.
 *
 * The snapshot is FROZEN at the moment the tool ran, like a PR card's: a
 * `issue_read` from last week shows the issue as it was read, not as it is.
 */
import * as z from "zod";
import { IssueCommentSchema, IssueSchema } from "./issues.js";
import { decodeTailPayload, encodeTailPayload } from "./tail-payload.js";

export const IssueToolKindSchema = z.enum(["issue_list", "issue_read", "issue_comment", "issue_update"]);
export type IssueToolKind = z.infer<typeof IssueToolKindSchema>;

/** What the tool DID — same loose, self-describing shape as a PR outcome. */
export const IssueToolOutcomeSchema = z.object({
  summary: z.string(),
  ok: z.boolean().default(true),
  details: z.array(z.string()).default([]),
});
export type IssueToolOutcome = z.infer<typeof IssueToolOutcomeSchema>;

export const IssueToolPayloadSchema = z.object({
  v: z.literal(1),
  tool: IssueToolKindSchema,
  outcome: IssueToolOutcomeSchema,
  /** The issue as it stood when the tool answered. Absent for a list, or a miss. */
  issue: IssueSchema.optional(),
  /**
   * Comments carried with the issue: the ones `issue_read` fetched, or the one
   * `issue_comment` just posted (so the card can show what was said without
   * re-reading the tracker).
   */
  comments: z.array(IssueCommentSchema).optional(),
  /** How many comments the issue has in total, when `comments` is a window. */
  commentCount: z.number().int().nonnegative().optional(),
  /** `issue_list`'s rows. */
  issues: z.array(IssueSchema).optional(),
});
export type IssueToolPayload = z.infer<typeof IssueToolPayloadSchema>;

/** Deliberately ugly, like the PR one, so it is obviously machinery in a raw transcript. */
export const ISSUE_TOOL_PAYLOAD_MARKER = "<<dispatch:issue>>";

export function encodeIssueToolPayload(payload: IssueToolPayload): string {
  return encodeTailPayload(ISSUE_TOOL_PAYLOAD_MARKER, payload);
}

export function decodeIssueToolPayload(text: string): {
  payload: IssueToolPayload | null;
  text: string;
} {
  return decodeTailPayload(text, ISSUE_TOOL_PAYLOAD_MARKER, IssueToolPayloadSchema);
}
