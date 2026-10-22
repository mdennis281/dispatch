/**
 * Outbound webhook subscriptions — the shapes the server stores, the routes
 * serve and the Settings pane edits.
 *
 * A subscription is "POST these bus events to this URL, signed with this
 * secret". The filter vocabulary is derived from the wire schema rather than
 * re-typed, so a wire event added later is offered automatically and a wire
 * event renamed fails typecheck here instead of silently matching nothing.
 */
import { z } from "zod";
import { AttentionItemSchema, ChatMessageSchema } from "./messages.js";
import { ChatStatusSchema } from "./common.js";
import { WsServerEventSchema } from "./wire.js";

/**
 * Wire events a webhook can NEVER subscribe to.
 *
 * `hello` and `pong` are per-socket handshakes that never reach the bus.
 * `message-chunk` is the token stream, excluded by decision. `terminal-output`
 * and `runner-log` are excluded for the same reason that decision was made:
 * each is a per-chunk stream from a subprocess, and a delivery row plus up to
 * six HTTP attempts PER CHUNK would fill the delivery table and the receiver
 * alike within one noisy `pnpm dev`. The row-level events those streams
 * summarise (`terminal-update`, `runner-update`) are offered instead.
 */
export const WEBHOOK_EXCLUDED_WIRE_EVENTS: ReadonlySet<string> = new Set([
  "hello",
  "pong",
  "message-chunk",
  "terminal-output",
  "runner-log",
]);

/**
 * The derived event. Not a wire event: a raw `idle` is published before queued
 * sends flush, so it says "done" about a chat that may be a sentence into its
 * next turn. The server fires this only once the chat has STAYED at rest — see
 * `WebhookService` and the settle rule it borrows from the completion notice.
 */
export const CHAT_SETTLED_EVENT = "chat-settled" as const;

/** Every wire event type, in schema order. */
const WIRE_EVENT_TYPES = WsServerEventSchema.options.map((o) => o.shape.type.value);

/**
 * What a subscription's `events` filter may name: the offerable wire events plus
 * {@link CHAT_SETTLED_EVENT}. Order follows the wire schema so the Settings
 * pane lists them stably.
 */
export const WEBHOOK_EVENT_TYPES = [
  ...WIRE_EVENT_TYPES.filter((t) => !WEBHOOK_EXCLUDED_WIRE_EVENTS.has(t)),
  CHAT_SETTLED_EVENT,
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const WebhookEventTypeSchema = z.enum(
  WEBHOOK_EVENT_TYPES as unknown as [WebhookEventType, ...WebhookEventType[]],
);

/** Transcript row kinds a `chat-message` subscription may narrow to. */
export const WEBHOOK_ROW_KINDS = ChatMessageSchema.options.map((o) => o.shape.kind.value);
export type WebhookRowKind = (typeof WEBHOOK_ROW_KINDS)[number];
const WebhookRowKindSchema = z.enum(
  WEBHOOK_ROW_KINDS as unknown as [WebhookRowKind, ...WebhookRowKind[]],
);

/** Attention kinds an `attention-add` subscription may narrow to. */
export const WEBHOOK_ATTENTION_KINDS = AttentionItemSchema.shape.kind.options;
export type WebhookAttentionKind = (typeof WEBHOOK_ATTENTION_KINDS)[number];

/**
 * Which events a subscription wants. Every list is optional and an absent (or
 * empty) list means "all" — modelled on `AttentionFilterSchema`, where unset
 * means ON so that a kind added in a later version is never silently muted on
 * a subscription stored before it existed.
 */
export const WebhookFilterSchema = z.object({
  events: z.array(WebhookEventTypeSchema).optional(),
  /** Only consulted for `chat-message`. */
  rowKinds: z.array(WebhookRowKindSchema).optional(),
  /** Only consulted for `attention-add`. */
  attentionKinds: z.array(AttentionItemSchema.shape.kind).optional(),
  projectIds: z.array(z.string().min(1)).optional(),
  chatIds: z.array(z.string().min(1)).optional(),
});
export type WebhookFilter = z.infer<typeof WebhookFilterSchema>;

/** Nothing narrowed — every offerable event, every project, every chat. */
export const EMPTY_WEBHOOK_FILTER: WebhookFilter = {};

/** Who made a subscription: the browser session, or an integration token id. */
export const WEBHOOK_CREATED_BY_USER = "user" as const;

export const WebhookSubscriptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  url: z.string().url(),
  /** The HMAC key. Stripped from list responses; returned on create and rotate. */
  secret: z.string().min(1),
  filters: WebhookFilterSchema.default({}),
  active: z.boolean().default(true),
  createdBy: z.string().min(1).default(WEBHOOK_CREATED_BY_USER),
  createdAt: z.number().int(),
  lastDeliveryAt: z.number().int().optional(),
  /**
   * Dead deliveries in a row. Reset to zero by any delivered attempt; at
   * {@link WEBHOOK_PAUSE_AFTER_DEAD} the subscription is paused.
   */
  consecutiveFailures: z.number().int().nonnegative().default(0),
  /**
   * Why `active` went false without anyone asking — set by the auto-pause and
   * cleared by the next edit that re-enables. Settings shows it beside the
   * toggle so a dead endpoint reads as "paused: 20 failures" and not as a
   * switch somebody forgot.
   */
  pausedReason: z.string().optional(),
});
export type WebhookSubscription = z.infer<typeof WebhookSubscriptionSchema>;

/** A subscription as the list route returns it — everything but the key. */
export type WebhookSubscriptionPublic = Omit<WebhookSubscription, "secret">;

/** The body of a create / update request. */
export const WebhookSubscriptionInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL"),
  /** Omitted on create → generated. Present on update → rotated. */
  secret: z.string().min(8).max(256).optional(),
  filters: WebhookFilterSchema.optional(),
  active: z.boolean().optional(),
});
export type WebhookSubscriptionInput = z.infer<typeof WebhookSubscriptionInputSchema>;

/* ------------------------------------------------------------- delivery */

export const WebhookDeliveryStatusSchema = z.enum(["pending", "delivered", "dead"]);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>;

/**
 * Backoff between a failed attempt and the next one, indexed by how many
 * attempts have failed so far. Five retries after the first attempt; when the
 * last of them fails the delivery is dead.
 */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [
  5_000,
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
];
/** First attempt plus one retry per backoff step. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;
/** Consecutive dead deliveries that pause a subscription. */
export const WEBHOOK_PAUSE_AFTER_DEAD = 20;
/** How long delivery rows are kept. */
export const WEBHOOK_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** One POST and its retry history. */
export const WebhookDeliverySchema = z.object({
  /** Also the `X-Dispatch-Delivery` header, so a receiver can dedupe a redelivery. */
  id: z.string().min(1),
  subscriptionId: z.string().min(1),
  /** The envelope `type` — a {@link WebhookEventType}, or `webhook-test`. */
  eventType: z.string().min(1),
  chatId: z.string().optional(),
  projectId: z.string().optional(),
  status: WebhookDeliveryStatusSchema,
  attempts: z.number().int().nonnegative(),
  /** When the next attempt is due; meaningful only while `pending`. */
  nextAttemptAt: z.number().int().optional(),
  /** HTTP status of the last attempt, absent when the request itself failed. */
  lastStatus: z.number().int().optional(),
  /** Why the last attempt failed — the network error, or `HTTP 503`. */
  lastError: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** The exact bytes that were signed. Kept so a redelivery re-sends them verbatim. */
  body: z.string(),
});
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

/** The POST body, as the receiver parses it. */
export interface WebhookEnvelope {
  /** The delivery id; equals the `X-Dispatch-Delivery` header. */
  id: string;
  type: string;
  /** Epoch ms when the event was observed. */
  at: number;
  projectId?: string;
  chatId?: string;
  /** The wire event (or the derived `chat-settled` payload) verbatim. */
  data: unknown;
}

/** What `chat-settled` carries in `data`. */
export const ChatSettledPayloadSchema = z.object({
  chatId: z.string(),
  projectId: z.string(),
  status: ChatStatusSchema,
  /** The last assistant text of the turn, or empty when there was none. */
  lastAssistantText: z.string(),
});
export type ChatSettledPayload = z.infer<typeof ChatSettledPayloadSchema>;

/* ------------------------------------------------------------ matching */

/**
 * Where an event sits, as the filters see it — derived once per event by the
 * server (which has the store to look a chat's project up) and tested against
 * every subscription here.
 */
export interface WebhookEventScope {
  type: string;
  projectId?: string;
  chatId?: string;
  /** For `chat-message`: the row's kind. */
  rowKind?: string;
  /** For `attention-add`: the item's kind. */
  attentionKind?: string;
}

/**
 * Does this scoped event pass a filter? Pure, so the test can enumerate the
 * cases without a bus.
 *
 * An unset or empty list matches everything. A `rowKinds` list is consulted
 * only for `chat-message` and `attentionKinds` only for `attention-add`; on any
 * other event they are ignored rather than failing it, because "I want
 * assistant rows and every attention item" is one subscription, not two.
 */
export function webhookFilterMatches(filter: WebhookFilter, scope: WebhookEventScope): boolean {
  if (!listAllows(filter.events, scope.type)) return false;
  if (scope.type === "chat-message" && !listAllows(filter.rowKinds, scope.rowKind)) return false;
  if (scope.type === "attention-add" && !listAllows(filter.attentionKinds, scope.attentionKind)) {
    return false;
  }
  if (filter.projectIds?.length && !listAllows(filter.projectIds, scope.projectId)) return false;
  if (filter.chatIds?.length && !listAllows(filter.chatIds, scope.chatId)) return false;
  return true;
}

/**
 * Unset or empty → allowed. Otherwise the value must be present AND listed: a
 * project-scoped subscription must not receive a global event that has no
 * project at all, because "only my project" is what the filter promised.
 */
function listAllows(list: readonly string[] | undefined, value: string | undefined): boolean {
  if (!list || list.length === 0) return true;
  return value !== undefined && list.includes(value);
}
