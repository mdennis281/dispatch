/**
 * THE INTEGRATION EVENT FEED — a pull-based "what happened since I last
 * looked" for a caller that has no socket and no chat of its own.
 *
 * Webhooks push; this is the other half, for a connector that can only make
 * tool calls (the Grok connector polls between a driver's questions). It is
 * deliberately NOT the wire stream: a poller asking "is anything done?" wants
 * half a dozen facts it can act on, not 400 `chat-status` edges a minute. Each
 * type here is a DERIVED fact, computed by the server where it has the state to
 * get it right — "settled" with the completion notice's settle rule rather than
 * the raw `idle` edge, "merged" from a state TRANSITION rather than every
 * re-poll of a merged PR.
 *
 * Cursor-based: `id` is a monotonically increasing sequence that survives a
 * restart (the log lives in state.db), so a poller that stores the last `id`
 * it saw never misses or double-reads an event across a server bounce.
 */
import { z } from "zod";

export const INTEGRATION_EVENT_TYPES = [
  /** A chat's turn finished and it STAYED at rest (idle/done/failed/error). */
  "chat.settled",
  /** A PR Dispatch tracks was opened — or reopened (`payload.reopened`). */
  "pr.opened",
  "pr.merged",
  /** Closed WITHOUT merging. */
  "pr.closed",
  /** A new item in the global attention queue. */
  "attention.raised",
  /** An attention item left the queue: answered, dismissed, or its chat moved on. */
  "attention.resolved",
] as const;
export type IntegrationEventType = (typeof INTEGRATION_EVENT_TYPES)[number];

export function isIntegrationEventType(value: string): value is IntegrationEventType {
  return (INTEGRATION_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The read scope each event type needs, mirroring the webhook table
 * (`WEBHOOK_EVENT_SCOPES`): a token that cannot read the attention queue over
 * REST must not read it a line at a time from the feed.
 */
export const INTEGRATION_EVENT_SCOPES: Readonly<Record<IntegrationEventType, string>> = {
  "chat.settled": "chats:read",
  "pr.opened": "projects:read",
  "pr.merged": "projects:read",
  "pr.closed": "projects:read",
  "attention.raised": "attention:read",
  "attention.resolved": "attention:read",
};

export const IntegrationEventSchema = z.object({
  /** The cursor value — pass the last one you saw as `cursor` to continue. */
  id: z.string(),
  type: z.enum(INTEGRATION_EVENT_TYPES),
  chatId: z.string().optional(),
  projectId: z.string().optional(),
  /** Epoch ms. */
  ts: z.number().int(),
  /** The same instant as text with its zone, e.g. `2026-10-29 14:03:12 CDT`. */
  tsLocal: z.string(),
  /**
   * Type-specific detail:
   * - `chat.settled`: `{ status, title?, lastAssistantText }` (text clipped)
   * - `pr.*`: `{ repo, number, url, title, branch, state, reopened? }`
   * - `attention.*`: `{ attentionId, kind, summary, prNumber?, prUrl? }`
   */
  payload: z.record(z.string(), z.unknown()),
});
export type IntegrationEvent = z.infer<typeof IntegrationEventSchema>;

/** One page of the feed. */
export interface IntegrationEventPage {
  events: IntegrationEvent[];
  /**
   * Where to resume. Always present — even on an empty page it advances past
   * every event the filters skipped, so a narrow poll never rescans them.
   */
  nextCursor: string;
  /** More matching events are already waiting past this page. */
  hasMore: boolean;
  /**
   * The cursor pointed before the oldest event still retained, so some events
   * in between were pruned and can't be returned. Absent when nothing was lost.
   */
  gap?: boolean;
}

/** Default and ceiling for a page. */
export const INTEGRATION_EVENT_PAGE_DEFAULT = 50;
export const INTEGRATION_EVENT_PAGE_MAX = 200;
/** How long the log keeps an event, and how many it keeps at most. */
export const INTEGRATION_EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const INTEGRATION_EVENT_RETENTION_ROWS = 10_000;
