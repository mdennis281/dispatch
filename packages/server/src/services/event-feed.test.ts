import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INTEGRATION_EVENT_TYPES,
  type AttentionItem,
  type ChatStatus,
  type PrRecord,
} from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { StateDb } from "../store/db.js";
import { EventCursorError, EventFeedService, eventReachFor, type EventFeedDeps } from "./event-feed.js";

const ALL = eventReachFor(null);
let dir: string;
let db: StateDb;
let bus: EventBus;
let now: number;
let timers: Array<() => void>;
let feeds: EventFeedService[];

function pr(over: Partial<PrRecord> & { number: number }): PrRecord {
  const repo = over.repo ?? "o/r";
  return {
    key: `${repo}#${over.number}`,
    repo,
    url: `https://github.com/${repo}/pull/${over.number}`,
    title: `PR ${over.number}`,
    branch: "b",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    labels: [],
    hold: false,
    mergeable: null,
    reviewDecision: null,
    reviewers: [],
    threads: [],
    checks: [],
    firstSeenAt: 0,
    lastPolledAt: 0,
    lastChangedAt: 0,
    nextPollAt: 0,
    quietPolls: 0,
    watchedUntil: 0,
    projectId: "p1",
    chatId: "c1",
    ...over,
  } as PrRecord;
}

function item(over: Partial<AttentionItem> & { id: string }): AttentionItem {
  return { chatId: "c1", projectId: "p1", kind: "question", summary: "Pick one", createdAt: 1, ...over };
}

async function feed(over: Partial<EventFeedDeps> = {}, prs: PrRecord[] = []): Promise<EventFeedService> {
  const f = new EventFeedService({
    bus,
    db,
    store: {
      getChat: async (id: string) => ({ id, projectId: "p1", title: `Chat ${id}` }) as never,
      listPrRecords: async () => prs,
      readMessages: async () => [{ kind: "assistant", text: "All done — merged #12.", id: "m1" }] as never,
    },
    now: () => now,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
    log: () => {},
    ...over,
  });
  feeds.push(f);
  await f.start();
  return f;
}

function status(chatId: string, s: ChatStatus): void {
  bus.publish({ type: "chat-status", chatId, status: s } as never);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-events-"));
  db = new StateDb(dir);
  bus = new EventBus();
  now = Date.UTC(2026, 9, 29, 19, 0, 0);
  timers = [];
  feeds = [];
});
afterEach(async () => {
  for (const f of feeds) f.dispose();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("EventFeedService — derivations", () => {
  it("announces a chat once it SETTLES, not on a fresh session's idle", async () => {
    const f = await feed();
    status("c1", "idle"); // never seen working: no turn happened
    expect(timers).toHaveLength(0);
    status("c1", "running");
    status("c1", "idle");
    expect(timers).toHaveLength(1);
    timers.shift()!();
    await f.whenIdle();
    const { events } = f.poll({}, ALL);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "chat.settled",
      chatId: "c1",
      projectId: "p1",
      ts: now,
      payload: { status: "idle", title: "Chat c1", lastAssistantText: "All done — merged #12." },
    });
    expect(events[0]!.tsLocal).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \S+$/);
  });

  it("does not announce a chat that picked work back up inside the settle window", async () => {
    const f = await feed({ getStatus: () => "running" });
    status("c1", "running");
    status("c1", "idle");
    timers.shift()!(); // live status says running → re-arms instead of firing
    await f.whenIdle();
    expect(f.poll({}, ALL).events).toHaveLength(0);
  });

  it("turns PR record churn into one event per state TRANSITION", async () => {
    const f = await feed({}, [pr({ number: 1 })]); // seeded open: no "opened" on boot
    bus.publish({ type: "pr-record-update", record: pr({ number: 1, checks: [] }) });
    bus.publish({ type: "pr-record-update", record: pr({ number: 1, state: "merged" }) });
    bus.publish({ type: "pr-record-update", record: pr({ number: 1, state: "merged" }) });
    bus.publish({ type: "pr-record-update", record: pr({ number: 2 }) });
    bus.publish({ type: "pr-record-update", record: pr({ number: 2, state: "closed" }) });
    bus.publish({ type: "pr-record-update", record: pr({ number: 2 }) });
    // First sight of an already-merged PR is history, not news.
    bus.publish({ type: "pr-record-update", record: pr({ number: 3, state: "merged" }) });
    const events = f.poll({}, ALL).events;
    expect(events.map((e) => [e.type, e.payload.number, e.payload.reopened ?? false])).toEqual([
      ["pr.merged", 1, false],
      ["pr.opened", 2, false],
      ["pr.closed", 2, false],
      ["pr.opened", 2, true],
    ]);
    expect(events[0]!.payload).toMatchObject({ repo: "o/r", url: "https://github.com/o/r/pull/1", title: "PR 1" });
  });

  it("dedupes attention by id and resolves only what it announced", async () => {
    const f = await feed();
    bus.publish({ type: "attention-add", item: item({ id: "a1" }) });
    bus.publish({ type: "attention-add", item: item({ id: "a1", summary: "upserted" }) });
    bus.publish({ type: "attention-resolve", id: "never-seen" });
    bus.publish({
      type: "attention-add",
      item: item({ id: "a2", kind: "review", summary: "CI failed", prNumber: 7, url: "https://x/7", reviewKinds: ["check"] }),
    });
    bus.publish({ type: "attention-resolve", id: "a1", chatId: "c1" });
    const events = f.poll({}, ALL).events;
    expect(events.map((e) => [e.type, e.payload.attentionId])).toEqual([
      ["attention.raised", "a1"],
      ["attention.raised", "a2"],
      ["attention.resolved", "a1"],
    ]);
    expect(events[1]!.payload).toEqual({
      attentionId: "a2", kind: "review", summary: "CI failed", prNumber: 7, prUrl: "https://x/7", reviewKinds: ["check"],
    });
  });
});

describe("EventFeedService — polling", () => {
  it("pages from a cursor, oldest first, and never repeats or skips", async () => {
    const f = await feed();
    for (let i = 0; i < 5; i++) f.append("attention.raised", { chatId: "c1", projectId: "p1" }, { i });
    const first = f.poll({ cursor: "0", limit: 2 }, ALL);
    expect(first.events.map((e) => e.payload.i)).toEqual([0, 1]);
    expect(first).toMatchObject({ hasMore: true, nextCursor: first.events[1]!.id });
    const second = f.poll({ cursor: first.nextCursor, limit: 2 }, ALL);
    expect(second.events.map((e) => e.payload.i)).toEqual([2, 3]);
    const third = f.poll({ cursor: second.nextCursor, limit: 2 }, ALL);
    expect(third.events.map((e) => e.payload.i)).toEqual([4]);
    expect(third.hasMore).toBe(false);
    const empty = f.poll({ cursor: third.nextCursor }, ALL);
    expect(empty).toMatchObject({ events: [], hasMore: false, nextCursor: third.nextCursor });
  });

  it("with no cursor returns the NEWEST page, in order, and a cursor at the head", async () => {
    const f = await feed();
    for (let i = 0; i < 5; i++) f.append("chat.settled", { chatId: "c1" }, { i });
    const page = f.poll({ limit: 2 }, ALL);
    expect(page.events.map((e) => e.payload.i)).toEqual([3, 4]);
    expect(page).toMatchObject({ hasMore: false, nextCursor: String(f.head()) });
  });

  it("advances the cursor past events a filter skipped", async () => {
    const f = await feed();
    f.append("chat.settled", { chatId: "c1", projectId: "p1" }, {});
    f.append("pr.merged", { chatId: "c2", projectId: "p2" }, {});
    const page = f.poll({ cursor: "0", types: ["pr.merged"], chatId: "c2" }, ALL);
    expect(page.events.map((e) => e.type)).toEqual(["pr.merged"]);
    const next = f.poll({ cursor: "0", types: ["attention.raised"] }, ALL);
    expect(next).toMatchObject({ events: [], nextCursor: "2" });
  });

  it("filters by since", async () => {
    const f = await feed();
    f.append("chat.settled", {}, { i: 0 });
    now += 60_000;
    f.append("chat.settled", {}, { i: 1 });
    expect(f.poll({ since: now }, ALL).events.map((e) => e.payload.i)).toEqual([1]);
    // Beside a cursor `since` is ignored: honouring both would skip event 0
    // AND move the cursor past it, losing it for good.
    expect(f.poll({ cursor: "0", since: now }, ALL).events.map((e) => e.payload.i)).toEqual([0, 1]);
  });

  it("applies the caller's reach: scopes per type, and the project allowlist", async () => {
    const f = await feed();
    f.append("chat.settled", { chatId: "c1", projectId: "p1" }, {});
    f.append("attention.raised", { chatId: "c1", projectId: "p1" }, {});
    f.append("pr.merged", { chatId: "c9", projectId: "p9" }, {});
    f.append("chat.settled", { chatId: "c0" }, {}); // no project
    const chatsOnly = eventReachFor({ scopes: ["chats:read", "tools:chat"] });
    expect(f.poll({ cursor: "0" }, chatsOnly).events.map((e) => e.type)).toEqual(["chat.settled", "chat.settled"]);
    const p1Only = eventReachFor({ scopes: ["chats:read", "attention:read", "projects:read"], projectIds: ["p1"] });
    // A project-restricted token never sees an event with no project.
    expect(f.poll({ cursor: "0" }, p1Only).events.map((e) => e.type)).toEqual(["chat.settled", "attention.raised"]);
    // A filter narrows inside the reach; it can never widen it.
    expect(f.poll({ cursor: "0", projectIds: ["p9"] }, p1Only).events).toEqual([]);
    expect(eventReachFor({ scopes: ["tools:chat"] }).types).toEqual([]);
    expect(eventReachFor(null).types).toEqual(INTEGRATION_EVENT_TYPES);
  });

  it("refuses a malformed cursor and one from another instance", async () => {
    const f = await feed();
    f.append("chat.settled", {}, {});
    expect(() => f.poll({ cursor: "abc" }, ALL)).toThrow(EventCursorError);
    expect(() => f.poll({ cursor: "99" }, ALL)).toThrow(/ahead of this feed/);
  });

  it("keeps the sequence across a restart, and flags a gap a prune left", async () => {
    const f = await feed();
    for (let i = 0; i < 3; i++) f.append("chat.settled", {}, { i });
    f.dispose();
    // Old rows age out on the next start's prune; seq numbers must not be reused.
    now += 8 * 24 * 60 * 60_000;
    const g = await feed();
    g.append("chat.settled", {}, { i: 3 });
    const page = g.poll({ cursor: "1" }, ALL);
    expect(page.events.map((e) => [e.id, e.payload.i])).toEqual([["4", 3]]);
    expect(page.gap).toBe(true);
    expect(g.poll({ cursor: "3" }, ALL).gap).toBeUndefined();
  });
});
