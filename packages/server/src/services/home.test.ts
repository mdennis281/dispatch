import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import { MetricsService, type MetricInput } from "./metrics.js";
import { AttentionQueue } from "./attention.js";
import { HomeService, dayRange } from "./home.js";
import type { AttentionItem, Chat, Project } from "@dispatch/shared";

const DAY = 86_400_000;
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

describe("dayRange", () => {
  it("covers every day the window touches, oldest first, with no gaps", () => {
    const to = NOW + 1;
    const days = dayRange(to - 7 * DAY, to);
    expect(days).toHaveLength(8); // seven whole days plus the partial today
    for (let i = 1; i < days.length; i++) expect(days[i]! - days[i - 1]!).toBe(1);
  });

  it("is one day wide for a window inside a single day", () => {
    expect(dayRange(NOW, NOW + 1)).toHaveLength(1);
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
