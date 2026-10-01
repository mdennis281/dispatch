import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import { MetricsService, type MetricInput, type MetricSpanInput } from "./metrics.js";
import { AttentionQueue } from "./attention.js";
import { HomeService } from "./home.js";
import { GLOBAL_PROJECT_ID } from "@dispatch/shared";
import type { AttentionItem, Chat, Project } from "@dispatch/shared";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);

let dir: string;
let store: Store;
let metrics: MetricsService;
let attention: AttentionQueue;
let now: number;

function makeHome(): HomeService {
  return new HomeService({ store, metrics, attention, now: () => now });
}

function project(id: string, name: string): Project {
  return {
    id,
    name,
    repoPath: `C:/repos/${id}`,
    worktreeRoot: `C:/worktrees/${id}`,
    subApps: [],
    createdAt: NOW - 90 * DAY,
  };
}

function chat(id: string, projectId: string, over: Partial<Chat> = {}): Chat {
  return {
    id,
    projectId,
    title: `chat ${id}`,
    worktrees: [],
    prs: [],
    createdAt: NOW - 2 * DAY,
    ...over,
  };
}

function event(over: Partial<MetricInput> & { ts: number }): MetricInput {
  return {
    category: "tool",
    identifier: "Bash",
    projectId: "p1",
    chatId: "c1",
    // Part of the dedup key — two rows sharing one id are ONE occurrence (see
    // `eventKey`), so every field a fixture varies has to appear here.
    toolUseId: `tu-${over.ts}-${over.identifier ?? "Bash"}-${over.chatId ?? "c1"}`,
    ...over,
  };
}

function item(id: string, chatId: string): AttentionItem {
  return { id, chatId, kind: "question", summary: id, createdAt: NOW };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-home-"));
  store = new Store(dir);
  await store.init();
  metrics = new MetricsService({ db: store.stateDb, now: () => now, flushMs: 0 });
  attention = new AttentionQueue({ bus: new EventBus() });
  now = NOW;
});
afterEach(async () => {
  metrics.dispose();
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the sparkline's buckets", () => {
  it("is one point per day over a week, and per hour over a day", async () => {
    await store.saveProject(project("p1", "Alpha"));
    const home = makeHome();
    expect((await home.overview("7d")).projects[0]!.spark).toHaveLength(7);
    expect((await home.overview("30d")).projects[0]!.spark).toHaveLength(30);
    expect((await home.overview("24h")).projects[0]!.spark).toHaveLength(24);
  });

  it("buckets from the window start, so no bucket is partial", async () => {
    // THE BUG THIS GUARDS: with calendar-day keys, a 24h window read at
    // 12:00 UTC splits evenly but one read at 01:00 puts 23 hours in one
    // bucket and 1 in the next, so steady traffic draws a cliff. Here the
    // clock is deliberately NOT on a day boundary and the load is uniform —
    // one event per hour — so every bucket must read exactly 1.
    await store.saveProject(project("p1", "Alpha"));
    metrics.recordMany(
      Array.from({ length: 24 }, (_, i) => event({ ts: NOW - i * HOUR, identifier: `t${i}` })),
    );

    const out = await makeHome().overview("24h");
    const spark = out.projects[0]!.spark;
    expect(spark).toHaveLength(24);
    expect(spark.every((n) => n === 1)).toBe(true);
  });

  it("places the oldest event first and the newest last", async () => {
    await store.saveProject(project("p1", "Alpha"));
    metrics.recordMany([
      event({ ts: NOW - 6 * DAY, identifier: "old" }),
      event({ ts: NOW - 1000, identifier: "new" }),
    ]);

    const spark = (await makeHome().overview("7d")).projects[0]!.spark;
    expect(spark[0]).toBe(1);
    expect(spark[spark.length - 1]).toBe(1);
    expect(spark.reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe("HomeService.overview", () => {
  it("rolls the ledger up per project and sums the headline", async () => {
    await store.saveProject(project("p1", "Alpha"));
    await store.saveProject(project("p2", "Beta"));
    await store.saveChat(chat("c1", "p1", { status: "running" }));
    await store.saveChat(chat("c2", "p1", { status: "idle" }));
    await store.saveChat(chat("c3", "p2", { status: "queued" }));
    metrics.recordMany([
      event({ ts: NOW - DAY }),
      event({ ts: NOW - DAY, identifier: "Read" }),
      event({ ts: NOW - 2 * DAY, projectId: "p2", chatId: "c3" }),
    ]);

    const home = makeHome();
    const out = await home.overview("7d");

    expect(out.totals.projects).toBe(2);
    expect(out.totals.chats).toBe(3);
    // `running` and `queued` both count as working; `idle` does not.
    expect(out.totals.working).toBe(2);
    expect(out.totals.events).toBe(3);

    const [alpha, beta] = out.projects;
    // Busiest first.
    expect(alpha!.id).toBe("p1");
    expect(alpha!.events).toBe(2);
    expect(alpha!.working).toBe(1);
    expect(beta!.events).toBe(1);
    // Every spark is the same width, whatever the project did.
    expect(alpha!.spark).toHaveLength(beta!.spark.length);
    expect(alpha!.spark.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("keeps the global chat's pseudo-project out of the grid", async () => {
    // `store.listProjects()` synthesizes it, and it is not a repo — no
    // checkout, no workflow, nothing a project card could say. Without
    // `realProjects` the grid grows a card for it and the headline counts it
    // as a project. The activity TAIL still names it, because that reports
    // where a row came from rather than offering somewhere to go.
    await store.saveProject(project("p1", "Alpha"));
    await store.saveChat(chat("cg", GLOBAL_PROJECT_ID));
    metrics.record(
      event({ ts: NOW - 1000, projectId: GLOBAL_PROJECT_ID, chatId: "cg", identifier: "Glob" }),
    );

    const out = await makeHome().overview("7d");
    expect(out.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(out.totals.projects).toBe(1);
    expect(out.recent[0]).toMatchObject({ identifier: "Glob", projectName: "Global" });
  });

  it("excludes archived chats from the counts", async () => {
    await store.saveProject(project("p1", "Alpha"));
    await store.saveChat(chat("c1", "p1", { status: "running" }));
    await store.saveChat(chat("c2", "p1", { status: "running", archived: true }));

    const out = await makeHome().overview("7d");
    expect(out.totals.chats).toBe(1);
    expect(out.totals.working).toBe(1);
  });

  it("attributes attention items to the project of the chat they sit on", async () => {
    await store.saveProject(project("p1", "Alpha"));
    await store.saveProject(project("p2", "Beta"));
    await store.saveChat(chat("c1", "p1"));
    await store.saveChat(chat("c3", "p2"));
    attention.add(item("a1", "c1"));
    attention.add(item("a2", "c1"));
    attention.add(item("a3", "c3"));
    // An item on a chat that no longer exists still counts in the headline.
    attention.add(item("a4", "gone"));

    const out = await makeHome().overview("7d");
    expect(out.totals.attention).toBe(4);
    const byId = Object.fromEntries(out.projects.map((p) => [p.id, p.attention]));
    expect(byId).toEqual({ p1: 2, p2: 1 });
  });

  it("names the project and chat behind each line of the activity tail", async () => {
    await store.saveProject(project("p1", "Alpha"));
    await store.saveChat(chat("c1", "p1", { title: "Fix the thing" }));
    metrics.record(event({ ts: NOW - 1000, identifier: "Grep" }));

    const out = await makeHome().overview("7d");
    expect(out.recent[0]).toMatchObject({
      identifier: "Grep",
      projectName: "Alpha",
      chatTitle: "Fix the thing",
    });
  });

  it("serves the cached snapshot rather than recomputing on every call", async () => {
    await store.saveProject(project("p1", "Alpha"));
    const home = makeHome();
    const first = await home.overview("7d");

    metrics.record(event({ ts: NOW }));
    now += 1_000; // inside the TTL
    const second = await home.overview("7d");

    expect(second.computedAt).toBe(first.computedAt);
    expect(second.totals.events).toBe(first.totals.events);
  });

  it("caches each window width separately", async () => {
    await store.saveProject(project("p1", "Alpha"));
    metrics.recordMany([event({ ts: NOW - 2 * DAY }), event({ ts: NOW - 1000 })]);
    const home = makeHome();

    expect((await home.overview("24h")).totals.events).toBe(1);
    expect((await home.overview("7d")).totals.events).toBe(2);
    // The 24h slot is still its own, not overwritten by the wider read.
    expect((await home.overview("24h")).totals.events).toBe(1);
  });

  it("falls back to chat activity when a project has no ledger rows", async () => {
    await store.saveProject(project("p1", "Alpha"));
    await store.saveChat(chat("c1", "p1"));

    const out = await makeHome().overview("7d");
    expect(out.projects[0]!.events).toBe(0);
    expect(out.projects[0]!.lastActivityAt).toBeGreaterThan(0);
  });
});

function span(over: Partial<MetricSpanInput> & { startTs: number }): MetricSpanInput {
  return {
    state: "tool",
    identifier: "Bash",
    projectId: "p1",
    chatId: "c1",
    endTs: over.startTs + MINUTE,
    // Like `toolUseId` above, this is the dedup key — vary it with everything
    // a fixture varies, or two spans collapse into one.
    spanKey: `sp-${over.startTs}-${over.projectId ?? "p1"}-${over.chatId ?? "c1"}`,
    ...over,
  };
}

describe("HomeService — runtime", () => {
  it("attributes span time to the project that owns it", async () => {
    await store.saveProject(project("p1", "Alpha"));
    await store.saveProject(project("p2", "Beta"));
    metrics.recordSpans([
      span({ startTs: NOW - 2 * HOUR }),
      span({ startTs: NOW - 3 * HOUR }),
      span({ startTs: NOW - 2 * HOUR, projectId: "p2", chatId: "c3" }),
    ]);

    const out = await makeHome().overview("7d");
    const byId = Object.fromEntries(out.projects.map((p) => [p.id, p.runtimeMs]));
    expect(byId.p1).toBe(2 * MINUTE);
    expect(byId.p2).toBe(MINUTE);
    expect(out.totals.runtimeMs).toBe(3 * MINUTE);
  });

  it("counts a span that is still running up to now", async () => {
    await store.saveProject(project("p1", "Alpha"));
    // A four-hour sleep that has not finished is exactly the span this page
    // most needs to show, so `end_ts IS NULL` is clipped to the clock rather
    // than skipped.
    metrics.recordSpans([span({ startTs: NOW - 4 * HOUR, endTs: null, state: "sleeping" })]);

    const out = await makeHome().overview("7d");
    expect(out.projects[0]!.runtimeMs).toBe(4 * HOUR);
  });

  it("is ATTRIBUTED time — two overlapping spans count twice", async () => {
    await store.saveProject(project("p1", "Alpha"));
    // A turn that ran two tool calls at once. The Metrics view would union
    // these into one minute of wall clock; the overview deliberately does not,
    // and the tile says "attributed" because of this.
    metrics.recordSpans([
      span({ startTs: NOW - HOUR, chatId: "c1" }),
      span({ startTs: NOW - HOUR, chatId: "c2" }),
    ]);

    const out = await makeHome().overview("7d");
    expect(out.projects[0]!.runtimeMs).toBe(2 * MINUTE);
  });

  it("survives a project id that is also an Object.prototype key", async () => {
    // Project ids can be AUTHORED rather than generated — "hivebreak" and
    // "zomboid-rcon" are real ones — so `__proto__` is a legal id. On a plain
    // `{}` accumulator the `??=` would resolve the inherited property instead
    // of creating a row, write through to `Object.prototype`, and corrupt every
    // other project's totals. Both accumulators are null-prototype.
    await store.saveProject(project("__proto__", "Edge"));
    await store.saveProject(project("p1", "Alpha"));
    metrics.recordMany([
      event({ ts: NOW - DAY, projectId: "__proto__", chatId: "cx" }),
      event({ ts: NOW - DAY }),
    ]);
    metrics.recordSpans([span({ startTs: NOW - HOUR, projectId: "__proto__", chatId: "cx" })]);

    const out = await makeHome().overview("7d");
    const byId = Object.fromEntries(out.projects.map((p) => [p.id, p]));
    expect(byId.__proto__!.events).toBe(1);
    expect(byId.__proto__!.runtimeMs).toBe(MINUTE);
    expect(byId.p1!.events).toBe(1);
    expect(byId.p1!.runtimeMs).toBe(0);
    expect(({} as Record<string, unknown>).events).toBeUndefined();
  });

  it("excludes a span that STARTED before the window, as documented", async () => {
    await store.saveProject(project("p1", "Alpha"));
    metrics.recordSpans([
      span({ startTs: NOW - 8 * DAY }), // outside a 7-day window
      span({ startTs: NOW - 2 * DAY }), // inside it
    ]);

    const out = await makeHome().overview("7d");
    // Not split across the boundary — whole, and booked to the window it began
    // in. That is the trade `projectRollup` takes to stay on the index.
    expect(out.projects[0]!.runtimeMs).toBe(MINUTE);
  });
});

describe("HomeService — cache behaviour", () => {
  it("recomputes when a caller forces it", async () => {
    await store.saveProject(project("p1", "Alpha"));
    const home = makeHome();
    const first = await home.overview("7d");

    metrics.record(event({ ts: NOW }));
    now += 1_000; // still well inside the TTL
    const forced = await home.overview("7d", { force: true });

    // The Reload button's whole job. An unforced call here returns `first`.
    expect(forced.computedAt).toBe(now);
    expect(forced.totals.events).toBe(first.totals.events + 1);
  });

  it("shares one recompute between callers racing a cold window", async () => {
    await store.saveProject(project("p1", "Alpha"));
    const home = makeHome();
    const [a, b, c] = await Promise.all([
      home.overview("30d"),
      home.overview("30d"),
      home.overview("30d"),
    ]);
    // One object, not three equal ones: the rollup ran once. Three independent
    // 30-day walks is the case this guard exists for.
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("drops every window on invalidate, so a backfill's rows are picked up", async () => {
    // The boot race: `start()` warms 7d while `MetricsBackfill` is still
    // importing, so the cached rollup can be of an empty ledger. The page
    // fetches once and never polls, so without this the first visitor sees
    // zeros for the whole TTL.
    await store.saveProject(project("p1", "Alpha"));
    const home = makeHome();
    expect((await home.overview("7d")).totals.events).toBe(0);

    metrics.record(event({ ts: NOW - DAY })); // the backfill lands
    home.invalidate();

    expect((await home.overview("7d")).totals.events).toBe(1);
  });

  it("reports a failed background refresh instead of leaving it unhandled", async () => {
    await store.saveProject(project("p1", "Alpha"));
    const errors: unknown[] = [];
    const home = new HomeService({
      store,
      metrics,
      attention,
      now: () => now,
      onError: (err) => errors.push(err),
    });
    await home.overview("7d");

    // The store goes away under it — a stand-in for any transient failure.
    const boom = new Error("store is gone");
    const listChats = store.listChats.bind(store);
    store.listChats = () => Promise.reject(boom);
    now += 60_000; // past the 7d TTL

    // Still answers, from the stale snapshot, rather than rejecting.
    const stale = await home.overview("7d");
    expect(stale.totals.projects).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual([boom]);
    store.listChats = listChats;
  });
});
