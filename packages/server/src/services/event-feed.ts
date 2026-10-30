/**
 * EventFeedService — the durable log behind the integration event feed
 * (`events_poll`, `GET /api/integration/events`). See
 * shared/integration-events.ts for the contract.
 *
 * A pure bus CONSUMER, like the webhooks: it derives a handful of facts from
 * the wire stream and appends each as a row in `integration_event`. Readers
 * page through that table by `seq`. Three derivations need state, and each
 * keeps it here rather than trusting a single event:
 *
 *   - `chat.settled` uses the shared settle rule (chat-settle.ts). The raw
 *     `idle` edge fires before queued sends flush; a poller told "done" about a
 *     chat already working again would act on a lie.
 *   - `pr.*` is a state TRANSITION. `pr-record-update` fires on every change the
 *     catalog renders — a new check, a comment — so a merged PR re-polled ten
 *     times must still produce ONE `pr.merged`. The last state per key is seeded
 *     from the registry on start, so a restart does not re-announce every open
 *     PR as newly opened.
 *   - `attention.*` dedupes by item id. The queue UPSERTS on `attention-add`
 *     (a review item re-raised with new kinds keeps its id), and a resolve for
 *     an id this feed never announced is someone else's bookkeeping, not news.
 *
 * Nothing here can take the bus down: every handler catches and logs.
 */
import {
  INTEGRATION_EVENT_SCOPES,
  INTEGRATION_EVENT_TYPES,
  INTEGRATION_EVENT_PAGE_DEFAULT,
  INTEGRATION_EVENT_PAGE_MAX,
  INTEGRATION_EVENT_RETENTION_MS,
  INTEGRATION_EVENT_RETENTION_ROWS,
  formatLocalTime,
  type AttentionItem,
  type ChatStatus,
  type IntegrationEvent,
  type IntegrationEventPage,
  type IntegrationEventType,
  type PrRecord,
  type WsServerEvent,
} from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { StateDb } from "../store/db.js";
import type { Store } from "../store/index.js";
import { ChatSettleWatcher, lastAssistantText } from "./chat-settle.js";

/** A settled turn's last words are a preview, not the transcript. */
export const EVENT_TEXT_CLIP = 600;
/** Prune every this many appends (and once on start). */
const PRUNE_EVERY = 200;

/** A cursor the feed cannot honour — the caller's mistake, so a 400 / tool error. */
export class EventCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventCursorError";
  }
}

export interface EventFeedDeps {
  bus: EventBus;
  db: StateDb;
  store: Pick<Store, "getChat" | "listPrRecords" | "readMessages">;
  getStatus?(chatId: string): ChatStatus | undefined;
  hasPendingWork?(chatId: string): boolean;
  now?: () => number;
  settleMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  log?: (line: string) => void;
}

export interface EventFeedQuery {
  /** The `id` of the last event already seen. Omitted → the newest page. */
  cursor?: string;
  /** Only events at or after this epoch ms. */
  since?: number;
  limit?: number;
  types?: readonly IntegrationEventType[];
  projectIds?: readonly string[];
  chatId?: string;
}

/**
 * What the CALLER may see, applied on top of its filters: the types its scopes
 * cover, and the projects its token is restricted to (`null` = every project).
 * Never widened by a filter — a filter can only narrow inside this.
 */
export interface EventFeedReach {
  types: readonly IntegrationEventType[];
  projects: ReadonlySet<string> | null;
}

/**
 * A caller's reach from its grant. A browser session (no scopes list) sees
 * everything; a token sees the types its read scopes cover, within its
 * project allowlist. Shared by the REST route and the MCP binding so the two
 * surfaces cannot disagree about what one token may read.
 */
export function eventReachFor(grant: { scopes?: readonly string[]; projectIds?: readonly string[] } | null): EventFeedReach {
  if (!grant) return { types: INTEGRATION_EVENT_TYPES, projects: null };
  const scopes = grant.scopes ?? [];
  return {
    types: INTEGRATION_EVENT_TYPES.filter((t) => scopes.includes(INTEGRATION_EVENT_SCOPES[t])),
    projects: grant.projectIds?.length ? new Set(grant.projectIds) : null,
  };
}

interface Row {
  seq: number;
  type: string;
  chat_id: string | null;
  project_id: string | null;
  ts: number;
  payload: string;
}

function clip(text: string, max = EVENT_TEXT_CLIP): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function toEvent(r: Row): IntegrationEvent {
  return {
    id: String(r.seq),
    type: r.type as IntegrationEventType,
    ...(r.chat_id ? { chatId: r.chat_id } : {}),
    ...(r.project_id ? { projectId: r.project_id } : {}),
    ts: r.ts,
    tsLocal: formatLocalTime(r.ts),
    payload: JSON.parse(r.payload) as Record<string, unknown>,
  };
}

export class EventFeedService {
  private readonly bus: EventBus;
  private readonly db: StateDb;
  private readonly store: EventFeedDeps["store"];
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly settle: ChatSettleWatcher;
  /** Last known state per PR key — the transition detector. */
  private readonly prState = new Map<string, PrRecord["state"]>();
  /** Attention items this feed announced and has not yet seen resolved. */
  private readonly raised = new Map<string, AttentionItem>();
  private readonly pending = new Set<Promise<unknown>>();
  private off?: () => void;
  private appends = 0;
  private started = false;
  private disposed = false;

  constructor(deps: EventFeedDeps) {
    this.bus = deps.bus;
    this.db = deps.db;
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.warn(`[Dispatch] event feed: ${line}`));
    this.settle = new ChatSettleWatcher({
      getStatus: deps.getStatus,
      hasPendingWork: deps.hasPendingWork,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      settleMs: deps.settleMs,
      onSettled: (chatId, status) => void this.track(this.onSettled(chatId, status)),
    });
  }

  /** Seed PR states, prune, subscribe. Idempotent. */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    for (const pr of await this.store.listPrRecords().catch(() => [])) this.prState.set(pr.key, pr.state);
    this.prune();
    this.off = this.bus.subscribe((evt) => {
      try {
        this.onEvent(evt);
      } catch (err) {
        this.log(`error: ${String(err)}`);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.off?.();
    this.off = undefined;
    this.settle.dispose();
  }

  /** Resolve once every async derivation has landed (tests). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /* ------------------------------------------------------------- reading */

  /** The newest `seq` ever assigned — 0 on an empty, never-written log. */
  head(): number {
    const row = this.db
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'integration_event'")
      .get() as { seq: number } | undefined;
    return Number(row?.seq ?? 0);
  }

  poll(q: EventFeedQuery, reach: EventFeedReach): IntegrationEventPage {
    const limit = Math.min(Math.max(1, Math.floor(q.limit ?? INTEGRATION_EVENT_PAGE_DEFAULT)), INTEGRATION_EVENT_PAGE_MAX);
    // Read the head FIRST and bound the scan by it: an event appended between
    // the scan and the head read would otherwise be skipped by a nextCursor
    // that jumped past it.
    const head = this.head();
    let after = 0;
    if (q.cursor !== undefined) {
      if (!/^\d+$/.test(q.cursor)) {
        throw new EventCursorError(`"${q.cursor}" is not a cursor — pass the \`id\` of the last event you saw (a whole number).`);
      }
      after = Number(q.cursor);
      if (after > head) {
        throw new EventCursorError(
          `Cursor ${after} is ahead of this feed (newest id is ${head}) — it came from another Dispatch instance, ` +
            "or the log was reset. Poll without a cursor to start again.",
        );
      }
    }
    const types = (q.types?.length ? q.types.filter((t) => reach.types.includes(t)) : reach.types) as string[];
    let projects: string[] | null = q.projectIds?.length ? [...q.projectIds] : null;
    if (reach.projects) projects = (projects ?? [...reach.projects]).filter((p) => reach.projects!.has(p));
    const empty: IntegrationEventPage = { events: [], nextCursor: String(Math.max(after, head)), hasMore: false };
    if (types.length === 0 || (projects && projects.length === 0)) return empty;

    const where =
      "seq > ? AND seq <= ? AND ts >= ?" +
      " AND type IN (SELECT value FROM json_each(?))" +
      " AND (? IS NULL OR project_id IN (SELECT value FROM json_each(?)))" +
      " AND (? IS NULL OR chat_id = ?)";
    const projectsJson = projects ? JSON.stringify(projects) : null;
    const args = [after, head, q.since ?? 0, JSON.stringify(types), projectsJson, projectsJson, q.chatId ?? null, q.chatId ?? null];
    // No cursor: the NEWEST page, so a first poll answers "what just happened"
    // rather than replaying a week of history from the oldest row.
    const newest = q.cursor === undefined && q.since === undefined;
    const rows = this.db
      .prepare(`SELECT * FROM integration_event WHERE ${where} ORDER BY seq ${newest ? "DESC" : "ASC"} LIMIT ?`)
      .all(...args, limit + 1) as unknown as Row[];
    const hasMore = !newest && rows.length > limit;
    const page = rows.slice(0, limit);
    if (newest) page.reverse();
    const events = page.map(toEvent);
    const last = page[page.length - 1];
    const out: IntegrationEventPage = {
      events,
      // A full page resumes after its last row; anything shorter has scanned
      // to the head, and so may skip straight there.
      nextCursor: String(hasMore && last ? last.seq : Math.max(after, head)),
      hasMore,
    };
    if (q.cursor !== undefined && after < head) {
      const oldest = this.db.prepare("SELECT MIN(seq) AS seq FROM integration_event").get() as { seq: number | null };
      if (oldest.seq === null || after + 1 < Number(oldest.seq)) out.gap = true;
    }
    return out;
  }

  /* ------------------------------------------------------------- writing */

  /** Append one event. Synchronous: the row exists before the bus handler returns. */
  append(type: IntegrationEventType, scope: { chatId?: string; projectId?: string }, payload: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO integration_event (type, chat_id, project_id, ts, payload) VALUES (?, ?, ?, ?, ?)")
      .run(type, scope.chatId ?? null, scope.projectId ?? null, this.now(), JSON.stringify(payload));
    if (++this.appends % PRUNE_EVERY === 0) this.prune();
  }

  private prune(): void {
    try {
      this.db.prepare("DELETE FROM integration_event WHERE ts < ?").run(this.now() - INTEGRATION_EVENT_RETENTION_MS);
      this.db
        .prepare(
          "DELETE FROM integration_event WHERE seq <= (SELECT seq FROM integration_event ORDER BY seq DESC LIMIT 1 OFFSET ?)",
        )
        .run(INTEGRATION_EVENT_RETENTION_ROWS);
    } catch (err) {
      this.log(`prune failed: ${String(err)}`);
    }
  }

  private track<T>(p: Promise<T>): Promise<T | undefined> {
    const tracked = p.catch((err: unknown) => {
      this.log(`error: ${String(err)}`);
      return undefined;
    });
    const handle = tracked.finally(() => this.pending.delete(handle));
    this.pending.add(handle);
    return tracked;
  }

  private onEvent(evt: WsServerEvent): void {
    if (this.disposed) return;
    switch (evt.type) {
      case "chat-status":
        this.settle.onStatus(evt.chatId, evt.status);
        return;
      case "chat-deleted":
        this.settle.drop(evt.chatId);
        return;
      case "attention-add":
        this.onAttentionAdd(evt.item);
        return;
      case "attention-resolve":
        this.onAttentionResolve(evt.id);
        return;
      case "pr-record-update":
        this.onPrRecord(evt.record);
        return;
    }
  }

  private async onSettled(chatId: string, status: ChatStatus): Promise<void> {
    if (this.disposed) return;
    const chat = await this.store.getChat(chatId).catch(() => null);
    const text = await lastAssistantText(this.store, chatId);
    this.append(
      "chat.settled",
      { chatId, projectId: chat?.projectId },
      { status, ...(chat?.title ? { title: chat.title } : {}), lastAssistantText: clip(text) },
    );
  }

  private onAttentionAdd(item: AttentionItem): void {
    const known = this.raised.has(item.id);
    this.raised.set(item.id, item);
    if (known) return;
    this.append("attention.raised", { chatId: item.chatId, projectId: item.projectId }, attentionPayload(item));
  }

  private onAttentionResolve(id: string): void {
    const item = this.raised.get(id);
    if (!item) return;
    this.raised.delete(id);
    this.append("attention.resolved", { chatId: item.chatId, projectId: item.projectId }, attentionPayload(item));
  }

  private onPrRecord(record: PrRecord): void {
    const prev = this.prState.get(record.key);
    this.prState.set(record.key, record.state);
    if (prev === record.state) return;
    let type: IntegrationEventType;
    if (record.state === "open") type = "pr.opened";
    else if (prev === undefined) return; // First sight of an already-finished PR is history, not news.
    else type = record.state === "merged" ? "pr.merged" : "pr.closed";
    this.append(type, { chatId: record.chatId, projectId: record.projectId }, {
      repo: record.repo,
      number: record.number,
      url: record.url,
      title: record.title,
      branch: record.branch,
      state: record.state,
      ...(type === "pr.opened" && prev !== undefined ? { reopened: true } : {}),
    });
  }
}

function attentionPayload(item: AttentionItem): Record<string, unknown> {
  return {
    attentionId: item.id,
    kind: item.kind,
    summary: item.summary,
    ...(item.prNumber !== undefined ? { prNumber: item.prNumber } : {}),
    ...(item.url ? { prUrl: item.url } : {}),
    ...(item.reviewKinds?.length ? { reviewKinds: item.reviewKinds } : {}),
  };
}
