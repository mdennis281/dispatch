/**
 * WebhookService — outbound, signed POSTs of bus events to URLs the owner (or
 * an integration token) subscribed.
 *
 * The pipeline is filter → sign → POST → retry, and every stage is shaped by a
 * failure it must not reproduce:
 *
 *   - It is a pure CONSUMER of the bus, like the notifier. A receiver that is
 *     down, slow, or returning 500 can never take the bus down: every handler
 *     catches, every fetch has a deadline, and the only side effect is a row in
 *     `webhook_delivery` plus an HTTP request.
 *   - A delivery is a ROW before it is a request. The row is written `pending`
 *     before the first attempt, so a server that dies mid-POST (or is stopped
 *     with a retry 10 minutes out) picks the delivery back up on boot instead
 *     of silently dropping it. `start()` is that resume.
 *   - Retries re-sign with a fresh timestamp but keep the delivery id, so a
 *     receiver can reject replays by `t` and still dedupe by `X-Dispatch-Delivery`.
 *   - A dead endpoint stops costing anything. Twenty dead deliveries in a row
 *     pause the subscription and raise a `notice`; the Settings pane shows why.
 *   - `chat-settled` is derived with the completion notice's settle rule, not
 *     the raw `idle` edge: `onTurnEnd` publishes `idle` BEFORE flushing queued
 *     sends, so the raw edge says "done" about a chat that is already a
 *     sentence into its next turn.
 *
 * The subscription cache (`subs`) is authoritative in memory. Every mutation —
 * a CRUD call, a failure count, an auto-pause — happens on the cached object
 * synchronously and is then saved, so two deliveries settling in the same tick
 * cannot lose each other's `consecutiveFailures` increment the way two
 * read-modify-write round trips through the store would.
 */
import { createHmac, randomBytes } from "node:crypto";
import { ChatSettleWatcher, lastAssistantText } from "./chat-settle.js";
import {
  CHAT_SETTLED_EVENT,
  WEBHOOK_EXCLUDED_WIRE_EVENTS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_PAUSE_AFTER_DEAD,
  WEBHOOK_RETRY_DELAYS_MS,
  WebhookSubscriptionInputSchema,
  webhookFilterMatches,
  withSentContextSummary,
  type ChatSettledPayload,
  type ChatStatus,
  type WebhookDelivery,
  type WebhookEnvelope,
  type WebhookEventScope,
  type WebhookSubscription,
  type WebhookSubscriptionInput,
  type WebhookSubscriptionPublic,
  type WsServerEvent,
} from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { Store } from "../store/index.js";
import {
  WebhookError,
  assertMayManage,
  assertPublicUrl,
  boundFilterFor,
  createdByFor,
  mayAccess,
  resolveHostAddresses,
  type HostResolver,
  type WebhookCaller,
} from "./webhook-policy.js";

/** The envelope `type` of a test fire. Not a subscribable event. */
export const WEBHOOK_TEST_EVENT = "webhook-test";

/**
 * How long one POST may take. Generous for a webhook — a receiver that queues
 * work before answering is common — but bounded, because an attempt that never
 * settles holds its delivery `pending` with no retry scheduled.
 */
export const WEBHOOK_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Minimal fetch surface, matching the notifier's: `globalThis.fetch`
 * satisfies it and a test passes a `vi.fn()` without casting.
 */
export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number }>;

export interface WebhookServiceDeps {
  bus: EventBus;
  store: Store;
  fetch?: FetchLike;
  /** Live broker status, re-read after the settle window. */
  getStatus?(chatId: string): ChatStatus | undefined;
  /** A turn about to open under an at-rest status — see the completion notice. */
  hasPendingWork?(chatId: string): boolean;
  /** Resolver behind the public-address check on token-created subscriptions. */
  resolveHost?: HostResolver;
  now?: () => number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  settleMs?: number;
  log?: (line: string) => void;
}

/** Headers on every delivery. */
export interface SignedRequest {
  headers: Record<string, string>;
  body: string;
}

/**
 * Sign `body` the way a receiver verifies it: `t=<unix seconds>,v1=<hex
 * HMAC-SHA256 over "<t>.<body>">`. The timestamp is INSIDE the signed string,
 * so a captured delivery cannot be replayed later under its original
 * signature. Exported for the test receiver and for anyone writing one.
 */
export function signWebhookBody(secret: string, body: string, unixSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${unixSeconds}.${body}`).digest("hex");
  return `t=${unixSeconds},v1=${mac}`;
}

/**
 * Verify a signature header against the body — the receiver's half, kept beside
 * the signer so the two cannot drift. `toleranceSeconds` rejects a stale `t`;
 * pass `Infinity` to skip the clock check.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  opts: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  const parts = new Map(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1");
  if (!Number.isFinite(t) || !v1) return false;
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > tolerance) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  // Constant-time compare on equal-length hex; a length mismatch is a mismatch.
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

function newId(): string {
  return randomBytes(12).toString("base64url");
}

/**
 * The event as a receiver gets it. A session's init row carries the whole
 * system prompt it was built with (see shared/sent-context.ts): the memory
 * catalogue, machine-wide instructions, every repo path. A `chat-message`
 * subscription needs only `chats:read`, which never granted any of that, and
 * the body is stored once per subscription in the delivery log. So it goes
 * out as labels and sizes only.
 */
function forWebhook(evt: WsServerEvent): WsServerEvent {
  if (evt.type !== "chat-message" || evt.message.kind !== "system") return evt;
  const data = withSentContextSummary(evt.message.data, 0);
  return data === evt.message.data ? evt : { ...evt, message: { ...evt.message, data } };
}

function stripSecret(sub: WebhookSubscription): WebhookSubscriptionPublic {
  const { secret: _secret, ...rest } = sub;
  return rest;
}

export class WebhookService {
  private readonly bus: EventBus;
  private readonly store: Store;
  private readonly fetchImpl: FetchLike;
  private readonly resolveHost: HostResolver;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (line: string) => void;

  /** Authoritative in-memory copy of every subscription (see the header). */
  private readonly subs = new Map<string, WebhookSubscription>();
  /** Retry timers by delivery id — cleared on dispose, re-armed on boot. */
  private readonly timers = new Map<string, unknown>();
  /** Delivery ids with an attempt in flight, so a retry never overlaps one. */
  private readonly inFlight = new Set<string>();
  /** Every async path, so tests can await the bus settling. */
  private readonly pending = new Set<Promise<unknown>>();
  private readonly settle: ChatSettleWatcher;
  private offAll?: () => void;
  private started = false;
  private disposed = false;

  constructor(deps: WebhookServiceDeps) {
    this.bus = deps.bus;
    this.store = deps.store;
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    this.resolveHost = deps.resolveHost ?? resolveHostAddresses;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.log(`[Dispatch] webhooks: ${line}`));
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // A retry 30 minutes out must never be the reason the process stays up.
        (t as unknown as { unref?: () => void }).unref?.();
        return t;
      });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.settle = new ChatSettleWatcher({
      getStatus: deps.getStatus,
      hasPendingWork: deps.hasPendingWork,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      settleMs: deps.settleMs,
      onSettled: (chatId, status) => void this.track(this.fireSettled(chatId, status)),
    });
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Load subscriptions, subscribe to the bus, and resume every delivery a
   * previous process left pending. Idempotent.
   */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    for (const sub of await this.store.listWebhookSubscriptions()) this.subs.set(sub.id, sub);
    this.offAll = this.bus.subscribe((evt) => this.onEvent(evt));
    const owed = await this.store.listPendingWebhookDeliveries();
    for (const d of owed) this.scheduleResume(d);
    if (owed.length) this.log(`resumed ${owed.length} pending deliver${owed.length === 1 ? "y" : "ies"}`);
  }

  dispose(): void {
    this.disposed = true;
    this.offAll?.();
    this.offAll = undefined;
    for (const t of this.timers.values()) this.clearTimer(t);
    this.timers.clear();
    this.settle.dispose();
  }

  /** Resolve once every in-flight ingest and attempt has settled (tests). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    const tracked = p.catch((err: unknown) => {
      // Nothing here may become an unhandled rejection: this runs off a bus
      // listener with no caller to report to.
      this.log(`error: ${String(err)}`);
      return undefined as T;
    });
    const handle = tracked.finally(() => this.pending.delete(handle));
    this.pending.add(handle);
    return tracked;
  }

  /* ------------------------------------------------------------- the bus */

  private activeSubs(): WebhookSubscription[] {
    return [...this.subs.values()].filter((s) => s.active);
  }

  private onEvent(evt: WsServerEvent): void {
    if (this.disposed) return;
    if (evt.type === "chat-status") this.onChatStatus(evt.chatId, evt.status);
    if (evt.type === "chat-deleted") this.settle.drop(evt.chatId);
    if (WEBHOOK_EXCLUDED_WIRE_EVENTS.has(evt.type)) return;
    // The cheap exit: with nothing subscribed, every event costs one Set lookup
    // and one array scan, and never an async hop or a store read.
    if (this.activeSubs().length === 0) return;
    const at = this.now();
    void this.track(this.ingest(evt, at));
  }

  private async ingest(evt: WsServerEvent, at: number): Promise<void> {
    const scope = await this.scopeOf(evt);
    await this.fanOut(scope, at, forWebhook(evt));
  }

  /**
   * Match a scoped event against every active subscription, write one delivery
   * row each, then start every first attempt WITHOUT awaiting it. The rows are
   * the durable part; the POSTs run concurrently so one blackholed receiver
   * (up to WEBHOOK_REQUEST_TIMEOUT_MS) cannot delay every other subscription's
   * copy of the same event by that long.
   */
  private async fanOut(scope: WebhookEventScope, at: number, data: unknown): Promise<void> {
    const rows: WebhookDelivery[] = [];
    for (const sub of this.activeSubs()) {
      if (!webhookFilterMatches(sub.filters, scope)) continue;
      rows.push(await this.enqueue(sub, { type: scope.type, at, projectId: scope.projectId, chatId: scope.chatId, data }));
    }
    for (const row of rows) void this.track(this.attempt(row));
  }

  /**
   * Where an event sits, for the filters. The chat id is read off the event
   * where it carries one; the project is read off the event where it carries
   * one and looked up through the chat otherwise (`getChat` is cached, so this
   * is a Map read for any chat the server has touched).
   */
  private async scopeOf(evt: WsServerEvent): Promise<WebhookEventScope> {
    const scope: WebhookEventScope = { type: evt.type };
    switch (evt.type) {
      case "chat-message":
        scope.chatId = evt.chatId;
        scope.rowKind = evt.message.kind;
        break;
      case "attention-add":
        scope.chatId = evt.item.chatId;
        scope.projectId = evt.item.projectId;
        scope.attentionKind = evt.item.kind;
        break;
      case "chat-update":
        scope.chatId = evt.chat.id;
        scope.projectId = evt.chat.projectId;
        break;
      case "chat-deleted":
        scope.chatId = evt.chatId;
        scope.projectId = evt.projectId;
        break;
      case "project-update":
        scope.projectId = evt.project.id;
        break;
      case "project-config-update":
      case "memory-update":
      case "memory-deleted":
        scope.projectId = evt.projectId;
        break;
      case "pr-record-update":
        scope.chatId = evt.record.chatId;
        scope.projectId = evt.record.projectId;
        break;
      case "runner-update":
        scope.chatId = evt.runner.chatId;
        scope.projectId = evt.runner.projectId;
        break;
      case "worktree-update":
        scope.chatId = evt.chatId ?? evt.worktree.chatId;
        scope.projectId = evt.worktree.projectId;
        break;
      case "terminal-update":
        scope.chatId = evt.terminal.chatId;
        break;
      default:
        if ("chatId" in evt && typeof evt.chatId === "string") scope.chatId = evt.chatId;
    }
    if (scope.chatId && !scope.projectId) {
      const chat = await this.store.getChat(scope.chatId).catch(() => null);
      if (chat) scope.projectId = chat.projectId;
    }
    return scope;
  }

  /* --------------------------------------------------------- chat-settled */

  /** The settle rule itself lives in chat-settle.ts, shared with the event feed. */
  private onChatStatus(chatId: string, status: ChatStatus): void {
    if (this.activeSubs().length === 0) {
      this.settle.drop(chatId);
      return;
    }
    this.settle.onStatus(chatId, status);
  }

  private async fireSettled(chatId: string, status: ChatStatus): Promise<void> {
    const chat = await this.store.getChat(chatId).catch(() => null);
    const payload: ChatSettledPayload = {
      chatId,
      projectId: chat?.projectId ?? "",
      status,
      lastAssistantText: await lastAssistantText(this.store, chatId),
    };
    await this.fanOut(
      { type: CHAT_SETTLED_EVENT, chatId, projectId: chat?.projectId },
      this.now(),
      payload,
    );
  }

  /* ------------------------------------------------------------ delivery */

  /** Write the pending row for one subscription. The attempt is the caller's. */
  private async enqueue(
    sub: WebhookSubscription,
    envelope: Omit<WebhookEnvelope, "id">,
  ): Promise<WebhookDelivery> {
    const id = newId();
    const body = JSON.stringify({ id, ...envelope } satisfies WebhookEnvelope);
    const now = this.now();
    return this.store.saveWebhookDelivery({
      id,
      subscriptionId: sub.id,
      eventType: envelope.type,
      chatId: envelope.chatId,
      projectId: envelope.projectId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
      body,
    });
  }

  /** Boot: re-arm a pending row at its due time (immediately when overdue). */
  private scheduleResume(d: WebhookDelivery): void {
    const sub = this.subs.get(d.subscriptionId);
    // A pending row whose subscription is gone or paused stays as it is: the
    // row is the record that the receiver is still owed it, and re-activating
    // the subscription resumes it (see `update`).
    if (!sub?.active) return;
    const delay = Math.max(0, (d.nextAttemptAt ?? 0) - this.now());
    this.armTimer(d.id, delay);
  }

  private armTimer(deliveryId: string, delayMs: number): void {
    const prior = this.timers.get(deliveryId);
    if (prior !== undefined) this.clearTimer(prior);
    this.timers.set(
      deliveryId,
      this.setTimer(() => {
        this.timers.delete(deliveryId);
        void this.track(this.attemptById(deliveryId));
      }, delayMs),
    );
  }

  private async attemptById(id: string): Promise<void> {
    const row = await this.store.getWebhookDelivery(id);
    if (row && row.status === "pending") await this.attempt(row);
  }

  /**
   * One POST. Records the outcome on the row and the subscription, and
   * schedules the retry or declares the delivery dead.
   *
   * `force` is the test fire and the redeliver button: both are a human asking
   * "does it work NOW", which a paused subscription must still answer.
   */
  private async attempt(row: WebhookDelivery, opts: { force?: boolean } = {}): Promise<WebhookDelivery> {
    const sub = this.subs.get(row.subscriptionId);
    if (!sub) return row;
    if (!sub.active && !opts.force) return row;
    if (this.inFlight.has(row.id) || this.disposed) return row;
    this.inFlight.add(row.id);
    try {
      const outcome = await this.post(sub, row.body);
      const now = this.now();
      const attempts = row.attempts + 1;
      let next: WebhookDelivery;
      if (outcome.ok) {
        next = { ...row, status: "delivered", attempts, nextAttemptAt: undefined, lastStatus: outcome.status, lastError: undefined, updatedAt: now };
        sub.lastDeliveryAt = now;
        sub.consecutiveFailures = 0;
        await this.store.saveWebhookSubscription(sub);
      } else if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
        next = { ...row, status: "dead", attempts, nextAttemptAt: undefined, lastStatus: outcome.status, lastError: outcome.error, updatedAt: now };
        await this.recordDead(sub);
      } else if (!sub.active) {
        // A forced attempt (test, redeliver) on a paused subscription gets
        // exactly one try. A retry timer would fire into `attemptById`, be
        // refused for the pause, and leave the row `pending` with no timer:
        // never redeliverable, never swept, and fired as a stale surprise the
        // day the subscription is re-enabled. Settled dead instead, and
        // without touching the failure count — it is already paused and the
        // human is probing it.
        next = { ...row, status: "dead", attempts, nextAttemptAt: undefined, lastStatus: outcome.status, lastError: outcome.error, updatedAt: now };
      } else {
        const delay = WEBHOOK_RETRY_DELAYS_MS[attempts - 1]!;
        next = { ...row, status: "pending", attempts, nextAttemptAt: now + delay, lastStatus: outcome.status, lastError: outcome.error, updatedAt: now };
        // Timer first, save second: the save is what a crash loses, and the
        // boot resume re-arms from the row, so a timer without a row is the
        // harmless order and a row without a timer is a delivery nobody retries.
        this.armTimer(row.id, delay);
      }
      await this.store.saveWebhookDelivery(next);
      return next;
    } finally {
      this.inFlight.delete(row.id);
    }
  }

  private async post(
    sub: WebhookSubscription,
    body: string,
  ): Promise<{ ok: boolean; status?: number; error?: string }> {
    // A token's subscription is re-checked at every attempt, not just at
    // creation — a name that pointed at a public host yesterday can point at
    // 127.0.0.1 today.
    if (sub.createdBy !== "user") {
      try {
        await assertPublicUrl(sub.url, this.resolveHost);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const t = Math.floor(this.now() / 1000);
    const envelope = JSON.parse(body) as WebhookEnvelope;
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Dispatch-Webhooks/1",
        "x-dispatch-event": envelope.type,
        "x-dispatch-delivery": envelope.id,
        "x-dispatch-signature": signWebhookBody(sub.secret, body, t),
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_REQUEST_TIMEOUT_MS),
      // Never follow a redirect. The public-address check above judged the URL
      // the subscription names; a receiver answering `307 Location:
      // http://127.0.0.1:4318/...` would have `follow` re-POST the signed body
      // to exactly the address that check exists to refuse. One rule for every
      // subscription rather than a token-only one: a webhook that moved should
      // be edited, not silently chased.
      redirect: "manual",
    };
    try {
      const res = await this.fetchImpl(sub.url, init);
      if (res.status >= 300 && res.status < 400) {
        return { ok: false, status: res.status, error: `HTTP ${res.status} (redirects are not followed)` };
      }
      if (res.ok) return { ok: true, status: res.status };
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** A delivery died. Count it, and pause the subscription at the threshold. */
  private async recordDead(sub: WebhookSubscription): Promise<void> {
    sub.consecutiveFailures += 1;
    if (sub.active && sub.consecutiveFailures >= WEBHOOK_PAUSE_AFTER_DEAD) {
      sub.active = false;
      sub.pausedReason =
        `Paused after ${sub.consecutiveFailures} consecutive failed deliveries` +
        ` (last: ${new Date(this.now()).toISOString()}).`;
      this.bus.publish({
        type: "notice",
        level: "warn",
        text: `Webhook "${sub.name}" paused: ${sub.consecutiveFailures} deliveries in a row failed every retry. Re-enable it under Settings → Integrations once ${safeHost(sub.url)} is back.`,
      });
      this.log(`paused "${sub.name}" (${sub.id}) after ${sub.consecutiveFailures} dead deliveries`);
    }
    await this.store.saveWebhookSubscription(sub);
  }

  /* ---------------------------------------------------------------- CRUD */

  /** Everything this caller may see, keys stripped. */
  list(caller: WebhookCaller): WebhookSubscriptionPublic[] {
    return [...this.subs.values()].filter((s) => mayAccess(caller, s)).map(stripSecret);
  }

  /** 404 for a missing OR foreign subscription — a token must not enumerate the owner's. */
  private own(caller: WebhookCaller, id: string): WebhookSubscription {
    const sub = this.subs.get(id);
    if (!sub || !mayAccess(caller, sub)) throw new WebhookError(404, "No such webhook.");
    return sub;
  }

  /** Create. Returns the full row INCLUDING the secret — the one time it is shown. */
  async create(caller: WebhookCaller, raw: unknown): Promise<WebhookSubscription> {
    assertMayManage(caller);
    const input = parseInput(raw);
    const filters = boundFilterFor(caller, input.filters ?? {});
    if (caller.kind === "integration") await assertPublicUrl(input.url, this.resolveHost);
    const now = this.now();
    const sub: WebhookSubscription = {
      id: newId(),
      name: input.name,
      url: input.url,
      secret: input.secret ?? randomBytes(32).toString("base64url"),
      filters,
      active: input.active ?? true,
      createdBy: createdByFor(caller),
      createdAt: now,
      consecutiveFailures: 0,
    };
    await this.store.saveWebhookSubscription(sub);
    this.subs.set(sub.id, sub);
    return sub;
  }

  /**
   * Update. Every field is optional; a present `secret` rotates it and is
   * echoed back, otherwise the response carries no key. Re-enabling clears the
   * pause reason, resets the failure count — the human has said the endpoint is
   * back — and resumes any delivery left pending while it was off.
   */
  async update(caller: WebhookCaller, id: string, raw: unknown): Promise<WebhookSubscriptionPublic & { secret?: string }> {
    assertMayManage(caller);
    const sub = this.own(caller, id);
    const input = parsePartialInput(raw);
    // Validate EVERYTHING before touching the cached row. The cache is
    // authoritative and the next delivery persists whatever it finds there, so
    // a request refused half-way (a token's filter failing its scope check
    // after the secret was already assigned) would have left a rotated secret
    // live behind a 403.
    if (input.url !== undefined && caller.kind === "integration") {
      await assertPublicUrl(input.url, this.resolveHost);
    }
    const filters = input.filters !== undefined ? boundFilterFor(caller, input.filters) : undefined;

    const wasActive = sub.active;
    const patch: Partial<WebhookSubscription> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.url !== undefined) patch.url = input.url;
    if (input.secret !== undefined) patch.secret = input.secret;
    if (filters !== undefined) patch.filters = filters;
    if (input.active !== undefined) patch.active = input.active;
    if (patch.active && !wasActive) {
      // Re-enabling is the human saying the endpoint is back.
      patch.pausedReason = undefined;
      patch.consecutiveFailures = 0;
    }
    // Assigned onto the SAME object rather than replaced in the map: an
    // in-flight attempt holds a reference and will save it when it settles, and
    // a replacement would let that stale object overwrite this edit.
    Object.assign(sub, patch);
    await this.store.saveWebhookSubscription(sub);
    if (sub.active && !wasActive) {
      for (const d of await this.store.listPendingWebhookDeliveries()) {
        if (d.subscriptionId === sub.id) this.scheduleResume(d);
      }
    }
    return input.secret !== undefined ? { ...stripSecret(sub), secret: sub.secret } : stripSecret(sub);
  }

  async remove(caller: WebhookCaller, id: string): Promise<void> {
    assertMayManage(caller);
    this.own(caller, id);
    this.subs.delete(id);
    // Retry timers for its deliveries are left armed: each fires into
    // `attemptById`, finds the row gone (deleted in the same transaction as the
    // subscription) and does nothing. Tracking timers per subscription just to
    // save those wake-ups would be bookkeeping for no behaviour.
    await this.store.deleteWebhookSubscription(id);
  }

  /**
   * Fire a synthetic delivery through the real pipeline — row, signature,
   * retries — and return it after the FIRST attempt, so the pane can show the
   * status code the receiver answered with.
   */
  async test(caller: WebhookCaller, id: string): Promise<WebhookDelivery> {
    assertMayManage(caller);
    const sub = this.own(caller, id);
    const now = this.now();
    const deliveryId = newId();
    const body = JSON.stringify({
      id: deliveryId,
      type: WEBHOOK_TEST_EVENT,
      at: now,
      data: { subscriptionId: sub.id, name: sub.name, message: "Test delivery from Dispatch." },
    } satisfies WebhookEnvelope);
    const row = await this.store.saveWebhookDelivery({
      id: deliveryId,
      subscriptionId: sub.id,
      eventType: WEBHOOK_TEST_EVENT,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
      body,
    });
    return this.attempt(row, { force: true });
  }

  async deliveries(caller: WebhookCaller, id: string, limit = 100): Promise<WebhookDelivery[]> {
    this.own(caller, id);
    return this.store.listWebhookDeliveries(id, Math.min(Math.max(1, limit), 500));
  }

  /**
   * Send a settled delivery again: same id, same body, a fresh attempt budget.
   * Refused while the delivery is still pending — it is already being retried.
   */
  async redeliver(caller: WebhookCaller, id: string, deliveryId: string): Promise<WebhookDelivery> {
    assertMayManage(caller);
    this.own(caller, id);
    const row = await this.store.getWebhookDelivery(deliveryId);
    if (!row || row.subscriptionId !== id) throw new WebhookError(404, "No such delivery.");
    if (row.status === "pending") throw new WebhookError(409, "That delivery is still being retried.");
    const now = this.now();
    const reset = await this.store.saveWebhookDelivery({
      ...row,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      lastStatus: undefined,
      lastError: undefined,
      updatedAt: now,
    });
    return this.attempt(reset, { force: true });
  }
}

function parseInput(raw: unknown): WebhookSubscriptionInput {
  const parsed = WebhookSubscriptionInputSchema.safeParse(raw);
  if (!parsed.success) throw new WebhookError(400, firstIssue(parsed.error));
  return parsed.data;
}

function parsePartialInput(raw: unknown): Partial<WebhookSubscriptionInput> {
  const parsed = WebhookSubscriptionInputSchema.partial().safeParse(raw);
  if (!parsed.success) throw new WebhookError(400, firstIssue(parsed.error));
  return parsed.data;
}

function firstIssue(err: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issue = err.issues[0];
  if (!issue) return "Invalid webhook.";
  const path = issue.path.map(String).join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** The host for a notice — never the full URL, which may carry a token in its path. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the endpoint";
  }
}
