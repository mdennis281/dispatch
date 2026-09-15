import { describe, expect, it, vi } from "vitest";
import type { Issue, IssueClaim, IssueConfig, IssueWatch, Project } from "@dispatch/shared";
import type { AppSettings } from "../store/index.js";
import { EventBus } from "../bus.js";
import { CLAIM_GRACE_MS, IssueWatcher, type IssueWatcherOptions, type IssueWatcherSpawn } from "./issue-watcher.js";
import type { BoundIssueTracker } from "./issues/service.js";

const HOUR = 60 * 60_000;
const T0 = Date.parse("2026-09-15T12:00:00Z");

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `Issue ${number}`,
    body: "body",
    state: "open",
    url: `https://github.com/acme/api/issues/${number}`,
    author: "alice",
    authorTrust: "owner",
    authorIsBot: false,
    labels: [],
    assignees: [],
    commentCount: 0,
    createdAt: new Date(T0 + number * 1000).toISOString(),
    updatedAt: new Date(T0 + number * 1000).toISOString(),
    ...over,
  };
}

/** The store surface the watcher uses, in memory. */
function fakeStore(over: { settings?: Partial<AppSettings>; projects?: string[] } = {}) {
  const claims = new Map<string, IssueClaim>();
  const watches = new Map<string, IssueWatch>();
  const store: IssueWatcherOptions["store"] = {
    listProjects: async () => (over.projects ?? ["p1"]).map((id) => ({ id, repoPath: "/r" }) as Project),
    getProject: async (id) => ({ id, repoPath: "/r" }) as Project,
    getSettings: async () => ({ ...(over.settings ?? {}) }) as AppSettings,
    listIssueClaims: async (projectId) => [...claims.values()].filter((c) => !projectId || c.projectId === projectId),
    claimIssues: async (rows) => {
      const taken: IssueClaim[] = [];
      for (const c of rows) {
        if (claims.has(c.key)) continue;
        claims.set(c.key, c);
        taken.push(c);
      }
      return taken;
    },
    deleteIssueClaim: async (key) => {
      claims.delete(key);
    },
    updateIssueClaim: async (key, update) => {
      const prev = claims.get(key);
      if (!prev) return null;
      const next = { ...prev, ...update };
      claims.set(key, next);
      return next;
    },
    getIssueWatch: async (projectId) => watches.get(projectId) ?? null,
    saveIssueWatch: async (w) => {
      watches.set(w.projectId, w);
      return w;
    },
  };
  return { store, claims, watches };
}

function fakeTracker(open: Issue[]) {
  const labels = new Map<number, Set<string>>();
  const update = vi.fn(async (n: number, patch: { addLabels?: string[]; removeLabels?: string[] }) => {
    const set = labels.get(n) ?? new Set<string>();
    for (const l of patch.addLabels ?? []) set.add(l);
    for (const l of patch.removeLabels ?? []) set.delete(l);
    labels.set(n, set);
    const found = open.find((i) => i.number === n) ?? issue(n, { state: "closed" });
    return { ...found, labels: [...set] };
  });
  const tracker: BoundIssueTracker = {
    source: { provider: "github", repo: "acme/api" },
    from: "origin",
    list: vi.fn(async () => open.filter((i) => i.state === "open")),
    get: vi.fn(async (n: number) => open.find((i) => i.number === n) ?? null),
    comments: async () => [],
    comment: async () => ({ id: "1" }),
    update,
  };
  return { tracker, labels, update };
}

function watcher(input: {
  open: Issue[];
  config?: IssueConfig | null;
  settings?: Partial<AppSettings>;
  active?: boolean;
  spawn?: IssueWatcherOptions["spawn"];
  chatExists?: IssueWatcherOptions["chatExists"];
}) {
  const clock = { now: T0 };
  const { store, claims, watches } = fakeStore({ settings: input.settings });
  const { tracker, labels, update } = fakeTracker(input.open);
  const spawns: IssueWatcherSpawn[] = [];
  const spawn =
    input.spawn ??
    (async (s: IssueWatcherSpawn) => {
      spawns.push(s);
      return { chatId: `chat-${spawns.length}` };
    });
  const bus = new EventBus();
  const notices: string[] = [];
  bus.on("notice", (e) => notices.push(e.text));
  const w = new IssueWatcher({
    store,
    bus,
    configFor: () => input.config === undefined ? { enabled: true } : input.config,
    trackerFor: async () => tracker,
    spawn,
    chatExists: input.chatExists,
    active: () => input.active ?? true,
    now: () => clock.now,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  /** Enrol: the first poll only sets the baseline. */
  const enrol = async () => {
    const r = await w.pollNow("p1");
    expect(r.skipped).toBe("baseline-set");
  };
  return { w, clock, store, claims, watches, tracker, labels, update, spawns, bus, notices, enrol };
}

describe("IssueWatcher", () => {
  it("takes nothing on the first poll after enrolment — the backlog stays where it is", async () => {
    const before = new Date(T0 - HOUR).toISOString();
    const t = watcher({ open: [issue(1, { createdAt: before }), issue(2, { createdAt: before })] });
    await t.enrol();
    expect(t.spawns).toHaveLength(0);
    expect(t.watches.get("p1")?.baselineAt).toBe(T0);
    // A later poll still refuses those two: they predate the baseline.
    t.clock.now = T0 + HOUR;
    const r = await t.w.pollNow("p1");
    expect(r.taken).toEqual([]);
    expect(r.seen.map((s) => s.reason)).toEqual(["opened before enrolment", "opened before enrolment"]);
  });

  it("claims, labels, and starts ONE chat for a batch of new issues", async () => {
    const open: Issue[] = [];
    const t = watcher({ open, config: { enabled: true, maxConcurrent: 5 } });
    await t.enrol();
    t.clock.now = T0 + HOUR;
    open.push(issue(10, { createdAt: new Date(T0 + 10_000).toISOString() }), issue(11, { createdAt: new Date(T0 + 20_000).toISOString() }));
    const r = await t.w.pollNow("p1");
    expect(r.taken).toEqual([10, 11]);
    expect(r.chatId).toBe("chat-1");
    expect(t.spawns).toHaveLength(1);
    expect(t.spawns[0]!.issues.map((i) => i.number)).toEqual([10, 11]);
    expect(t.spawns[0]!.policy.mode).toBe("triage");
    // Both labelled BEFORE the spawn, and both rows point at the chat.
    expect([...t.labels.get(10)!]).toEqual(["dispatch:working"]);
    expect(t.claims.get("github:acme/api#10")).toMatchObject({ state: "working", chatId: "chat-1" });
    expect(t.notices).toEqual(["Started a chat for 2 new issues in github:acme/api"]);
  });

  it("never re-takes an issue it already holds, and skips one another instance labelled", async () => {
    const open = [issue(10, { createdAt: new Date(T0 + 1).toISOString() })];
    const t = watcher({ open });
    await t.enrol();
    t.clock.now = T0 + HOUR;
    expect((await t.w.pollNow("p1")).taken).toEqual([10]);
    open.push(issue(11, { createdAt: new Date(T0 + 2).toISOString(), labels: ["Dispatch:Working"] }));
    t.clock.now = T0 + 2 * HOUR;
    const r = await t.w.pollNow("p1");
    expect(r.taken).toEqual([]);
    expect(r.seen).toEqual([
      expect.objectContaining({ number: 10, reason: "working by this instance" }),
      expect.objectContaining({ number: 11, reason: "already claimed (dispatch:working)" }),
    ]);
    expect(t.spawns).toHaveLength(1);
  });

  it("honours the concurrency cap, oldest first, and the interval between polls", async () => {
    const open: Issue[] = [];
    const t = watcher({ open, config: { enabled: true, maxConcurrent: 2, intervalMinutes: 30 } });
    await t.enrol();
    for (const n of [12, 11, 13]) open.push(issue(n, { createdAt: new Date(T0 + n * 1000).toISOString() }));
    t.clock.now = T0 + 10 * 60_000;
    // Ten minutes in: not due on the timer path...
    expect((await t.w.sweep())[0]!.skipped).toBe("not-due");
    // ...but "poll now" reads regardless.
    const r = await t.w.pollNow("p1");
    expect(r.taken).toEqual([11, 12]);
    expect(r.seen.find((s) => s.number === 13)?.reason).toBe("at capacity (2 in flight)");
    // Next poll: still full, nothing more taken.
    t.clock.now = T0 + HOUR;
    expect((await t.w.pollNow("p1")).skipped).toBe("at-capacity");
  });

  it("filters by the project's policy and says why for each issue", async () => {
    const open: Issue[] = [];
    const t = watcher({ open, config: { enabled: true, filters: { labels: ["agent"] } } });
    await t.enrol();
    open.push(
      issue(20, { createdAt: new Date(T0 + 1).toISOString() }),
      issue(21, { createdAt: new Date(T0 + 2).toISOString(), labels: ["agent"], author: "mallory", authorTrust: "none" }),
      issue(22, { createdAt: new Date(T0 + 3).toISOString(), labels: ["agent"] }),
    );
    t.clock.now = T0 + HOUR;
    const r = await t.w.pollNow("p1");
    expect(r.taken).toEqual([22]);
    expect(r.seen.find((s) => s.number === 20)?.reason).toContain("missing a required label");
    expect(r.seen.find((s) => s.number === 21)?.reason).toContain("mallory is none");
  });

  it("does nothing when the project is not enrolled, the master switch is off, or this instance is dev", async () => {
    const open = [issue(1)];
    expect((await watcher({ open, config: null }).w.pollNow("p1")).skipped).toBe("disabled");
    expect((await watcher({ open, settings: { issueWatcher: { enabled: false } } }).w.pollNow("p1")).skipped).toBe("disabled");
    const dev = watcher({ open, active: false });
    expect((await dev.w.pollNow("p1")).skipped).toBe("inactive");
    expect(dev.tracker.list).not.toHaveBeenCalled();
  });

  it("gives an issue back when the chat cannot be started — label off, row marked failed", async () => {
    const open: Issue[] = [];
    const t = watcher({ open, spawn: async () => null });
    await t.enrol();
    open.push(issue(30, { createdAt: new Date(T0 + 1).toISOString() }));
    t.clock.now = T0 + HOUR;
    const r = await t.w.pollNow("p1");
    expect(r.taken).toEqual([]);
    expect(t.labels.get(30)?.size ?? 0).toBe(0);
    expect(t.claims.get("github:acme/api#30")).toMatchObject({ state: "failed" });
  });

  it("releases a deleted chat's claims and takes the label back, without re-taking the issue", async () => {
    const open: Issue[] = [];
    const t = watcher({ open });
    t.w.start();
    await t.enrol();
    open.push(issue(40, { createdAt: new Date(T0 + 1).toISOString() }));
    t.clock.now = T0 + HOUR;
    expect((await t.w.pollNow("p1")).taken).toEqual([40]);
    t.bus.publish({ type: "chat-deleted", chatId: "chat-1" });
    await t.w.drain();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.claims.get("github:acme/api#40")).toMatchObject({ state: "released", note: "chat deleted" });
    expect(t.labels.get(40)?.has("dispatch:working")).toBe(false);
    t.clock.now = T0 + 2 * HOUR;
    const r = await t.w.pollNow("p1");
    expect(r.taken).toEqual([]);
    expect(r.seen[0]?.reason).toBe("released by this instance");
    t.w.dispose();
  });

  it("settles a working claim as done once its issue closes, and frees a slot for the next", async () => {
    const open: Issue[] = [];
    const t = watcher({ open, config: { enabled: true, maxConcurrent: 1 } });
    await t.enrol();
    open.push(issue(50, { createdAt: new Date(T0 + 1).toISOString() }));
    t.clock.now = T0 + HOUR;
    expect((await t.w.pollNow("p1")).taken).toEqual([50]);
    open[0] = issue(50, { state: "closed" });
    open.push(issue(51, { createdAt: new Date(T0 + 2).toISOString() }));
    t.clock.now = T0 + 2 * HOUR;
    const r = await t.w.pollNow("p1");
    expect(t.claims.get("github:acme/api#50")?.state).toBe("done");
    expect(r.taken).toEqual([51]);
  });

  it("drops a claim whose chat vanished without an event, so it stops holding a slot", async () => {
    const open: Issue[] = [];
    const t = watcher({ open, config: { enabled: true, maxConcurrent: 1 }, chatExists: async () => false });
    await t.enrol();
    open.push(issue(60, { createdAt: new Date(T0 + 1).toISOString() }));
    t.clock.now = T0 + HOUR;
    expect((await t.w.pollNow("p1")).taken).toEqual([60]);
    open.push(issue(61, { createdAt: new Date(T0 + 2).toISOString() }));
    t.clock.now = T0 + 2 * HOUR;
    expect((await t.w.pollNow("p1")).taken).toEqual([61]);
    expect(t.claims.get("github:acme/api#60")).toMatchObject({ state: "released", note: "chat gone" });
  });

  it("drops a claim a restart left at claimed with no chat, and takes the issue again", async () => {
    const open: Issue[] = [];
    // A spawn that never returns: the process restarted mid-claim.
    const t = watcher({ open, config: { enabled: true, maxConcurrent: 1 }, spawn: () => new Promise(() => {}) });
    await t.enrol();
    open.push(issue(70, { createdAt: new Date(T0 + 1).toISOString() }));
    t.clock.now = T0 + HOUR;
    void t.w.pollNow("p1");
    await new Promise((r) => setTimeout(r, 5));
    expect(t.claims.get("github:acme/api#70")).toMatchObject({ state: "claimed" });
    expect(t.labels.get(70)?.has("dispatch:working")).toBe(true);
    // A fresh watcher over the same store (the restarted process) reaps it once
    // the grace has passed — the slot frees, the label comes off, and it is retried.
    const spawns: IssueWatcherSpawn[] = [];
    const w2 = new IssueWatcher({
      store: t.store,
      bus: t.bus,
      configFor: () => ({ enabled: true, maxConcurrent: 1 }),
      trackerFor: async () => t.tracker,
      spawn: async (s) => {
        spawns.push(s);
        return { chatId: "chat-after-restart" };
      },
      now: () => T0 + HOUR + CLAIM_GRACE_MS + 1,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    const r = await w2.pollNow("p1");
    expect(r.taken).toEqual([70]);
    expect(spawns).toHaveLength(1);
    expect(t.claims.get("github:acme/api#70")).toMatchObject({ state: "working", chatId: "chat-after-restart" });
  });

  it("does not reap a fresh claimed row — a slow spawn is not a dead one", async () => {
    const open: Issue[] = [];
    const t = watcher({ open, config: { enabled: true, maxConcurrent: 1 }, spawn: () => new Promise(() => {}) });
    await t.enrol();
    open.push(issue(71, { createdAt: new Date(T0 + 1).toISOString() }));
    t.clock.now = T0 + HOUR;
    void t.w.pollNow("p1");
    await new Promise((r) => setTimeout(r, 5));
    const w2 = new IssueWatcher({
      store: t.store,
      bus: t.bus,
      configFor: () => ({ enabled: true, maxConcurrent: 1 }),
      trackerFor: async () => t.tracker,
      spawn: async () => ({ chatId: "x" }),
      now: () => T0 + HOUR + 1000,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    const r = await w2.pollNow("p1");
    expect(r.taken).toEqual([]);
    expect(r.seen[0]?.reason).toBe("claimed by this instance");
    expect(t.claims.get("github:acme/api#71")).toMatchObject({ state: "claimed" });
    expect(t.labels.get(71)?.has("dispatch:working")).toBe(true);
  });

  it("records a tracker failure on the watch row and warns, rather than throwing out of the sweep", async () => {
    const t = watcher({ open: [] });
    await t.enrol();
    (t.tracker.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("HTTP 401: Bad credentials"));
    t.clock.now = T0 + HOUR;
    const r = await t.w.pollNow("p1");
    expect(r.error).toContain("Bad credentials");
    expect(t.watches.get("p1")?.lastError).toContain("Bad credentials");
    expect(t.notices[0]).toContain("Issue poll failed");
  });
});
