/**
 * HUMAN REVIEW — the contract between `request_human_review`, the broker that
 * raises its card, and the card that answers it.
 *
 * A review rides the QUESTION channel (an `AskUserQuestion` permission with a
 * `review` payload beside its `questions`) rather than growing a channel of its
 * own. That channel already owns everything that makes a card hard to miss —
 * the Attention Queue entry, notifier webhooks, restore-on-reload, the
 * teardown that denies whatever a stopped session left pending. It also means a
 * client that predates the review card still renders a WORKING card: it sees
 * one ordinary question whose options are the three verdicts.
 *
 * Lives in shared because both sides spell the verdict labels: the server
 * builds the options from them and reads the human's answer back out, and the
 * card sends them and re-reads its own resolved row. A label that disagreed
 * between the two would silently turn every "Approve" into "Keep iterating".
 */
import * as z from "zod";
import { ImageRefSchema } from "./common.js";

/**
 * Hard cap on the agent's prose. The whole point of the card is that it is
 * read in seconds — the evidence (screenshots, a running preview) carries the
 * detail, and a paragraph that needs scrolling is a paragraph that gets
 * skipped. Enforced at the tool schema, so an over-long summary is REJECTED and
 * the agent rewrites it, rather than silently clipped mid-thought.
 */
export const HUMAN_REVIEW_SUMMARY_MAX = 400;
/** Headline cap — it has to fit the card header and an Attention Queue row. */
export const HUMAN_REVIEW_TITLE_MAX = 80;
/** More than this is a gallery nobody walks; pick the shots that decide it. */
export const HUMAN_REVIEW_MAX_SCREENSHOTS = 6;

export const HUMAN_REVIEW_VERDICTS = ["approve", "iterate", "stop"] as const;
export type HumanReviewVerdict = (typeof HUMAN_REVIEW_VERDICTS)[number];

/** The option label each verdict travels as. */
export const HUMAN_REVIEW_ANSWERS: Record<HumanReviewVerdict, string> = {
  approve: "Approve",
  iterate: "Keep iterating",
  stop: "Stop work",
};

/**
 * How the question channel appends a human's notes to their chosen answer
 * (`<label> — additional instructions: <notes>`). The tool result reaching the
 * model can carry only the one answer string, so the comment is folded in and
 * split back out here.
 */
export const QUESTION_NOTES_SEPARATOR = " — additional instructions: ";

/** An http(s) URL — never `javascript:` or `data:`, because it lands in an href. */
export const HTTP_URL_RE = /^https?:\/\/[^\s]+$/i;

/** The `review` payload riding a review card's input. */
export const HumanReviewPayloadSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  /** Already ingested into the chat's assets by the time the card sees them. */
  screenshots: z.array(ImageRefSchema).default([]),
  previewUrl: z.string().regex(HTTP_URL_RE).optional(),
  prUrl: z.string().regex(HTTP_URL_RE).optional(),
});
export type HumanReviewPayload = z.infer<typeof HumanReviewPayloadSchema>;

/**
 * The review payload on a permission row's input, or null when this is an
 * ordinary question. Parsed, not cast: a row is re-read from disk for as long
 * as the chat exists, and a malformed one must fall back to the plain
 * question card rather than throw inside the transcript.
 */
export function readHumanReview(input: Record<string, unknown>): HumanReviewPayload | null {
  const parsed = HumanReviewPayloadSchema.safeParse(input.review);
  return parsed.success ? parsed.data : null;
}

/**
 * The verdict and comment inside an answer string, or null for no answer.
 *
 * Anything that is not one of the three labels reads as ITERATE, with the whole
 * text as the comment. The only way to produce one is the free-form answer an
 * older client's plain question card offers, and a human who typed prose
 * instead of pressing Approve has not approved anything — but they did say
 * something the agent should act on.
 */
export function parseHumanReviewAnswer(
  answer: string | undefined,
): { verdict: HumanReviewVerdict; comment?: string } | null {
  const text = (answer ?? "").trim();
  if (!text) return null;
  const cut = text.indexOf(QUESTION_NOTES_SEPARATOR);
  const label = (cut >= 0 ? text.slice(0, cut) : text).trim();
  const note = cut >= 0 ? text.slice(cut + QUESTION_NOTES_SEPARATOR.length).trim() : "";
  const verdict = HUMAN_REVIEW_VERDICTS.find((v) => HUMAN_REVIEW_ANSWERS[v] === label);
  if (!verdict) return { verdict: "iterate", comment: text };
  return note ? { verdict, comment: note } : { verdict };
}
