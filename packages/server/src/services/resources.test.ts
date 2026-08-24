import { describe, expect, it } from "vitest";
import { ProcTableCache } from "./proc-table-cache.js";
import { ResourceService } from "./resources.js";
import type { ProcRow } from "./processes.js";

/** A clock the test drives by hand, so windows are exact rather than flaky. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** One core's worth of `os.cpus()`, with the tick counts a test wants. */
function cores(n: number, idle: number, busy: number) {
  return Array.from({ length: n }, () => ({
    model: "test",
    speed: 1,
    times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
  }));
}

interface Harness {
  svc: ResourceService;
  advance: (ms: number) => void;
  /** Replace the table the next scan will see. */
  setTable: (rows: ProcRow[]) => void;
  /** Add tick counts to the fake cores: `burn(idle, busy)` per core. */
  burn: (idle: number, busy: number) => void;
}

function harness(
  rows: ProcRow[],
  opts: {
    sessionPids?: Map<string, number>;
    terminals?: { chatId: string; name: string; terminalId: string; pid: number }[];
    serverPid?: number;
  } = {},
): Harness {
  const c = clock();
  let table = rows;
  let idle = 1000;
  let busy = 1000;
  const cache = new ProcTableCache({
    read: async () => table,
    now: c.now,
    // No caching: each test call should see the table it just set.
    ttlMs: 0,
  });
  const svc = new ResourceService({
    procTable: cache,
    sessionPids: () => opts.sessionPids ?? new Map(),
    terminals: opts.terminals ? { livePids: () => opts.terminals! } : undefined,
    serverPid: opts.serverPid ?? 1,
    now: c.now,
    cpus: () => cores(4, idle, busy),
    freemem: () => 4_000,
    totalmem: () => 10_000,
  });
  return {
    svc,
    advance: c.advance,
    setTable: (r) => (table = r),
    burn: (i, b) => {
      idle += i;
      busy += b;
    },
  };
}

const row = (pid: number, ppid: number, over: Partial<ProcRow> = {}): ProcRow => ({
  pid,
  ppid,
  name: `p${pid}`,
  rssBytes: 100,
  cpuMs: 0,
  ...over,
});

describe("ResourceService.system", () => {
  it("reports no CPU percent until there is a baseline to difference", () => {
    const h = harness([]);
    // The first reading has nothing behind it. `null` is "not measured"; a 0
    // here would be a claim that the machine is idle.
    expect(h.svc.system().cpuPct).toBeNull();
    // Three ticks busy, one idle → 75%.
    h.burn(1, 3);
    expect(h.svc.system().cpuPct).toBeCloseTo(75);
  });

  it("reports nothing rather than 0 before anything has been measured", () => {
    // Two reads in the same scheduler tick have no window to divide by. With
    // nothing measured yet that is unmeasurable, not idle — and "0%" on a
    // pegged machine is the reading that would make somebody stop looking.
    const h = harness([]);
    h.svc.system();
    expect(h.svc.system().cpuPct).toBeNull();
  });

  it("holds the last reading when two callers land in the same millisecond", () => {
    // The header widget polls every 2 s and every snapshot() also comes
    // through here, so they collide occasionally. Without this the page's CPU
    // tile flickered to "—" while the header beside it read 11%.
    const h = harness([]);
    h.svc.system();
    h.burn(1, 3);
    expect(h.svc.system().cpuPct).toBeCloseTo(75);
    // Same instant, no ticks elapsed — serve the last real figure.
    expect(h.svc.system().cpuPct).toBeCloseTo(75);
  });

  it("reports memory without touching the process table", () => {
    const { svc } = harness([]);
    const sys = svc.system();
    expect(sys).toMatchObject({ totalBytes: 10_000, freeBytes: 4_000, usedBytes: 6_000 });
    expect(sys.logicalCores).toBe(4);
  });
});

describe("ResourceService.snapshot", () => {
  it("attributes a session subtree and its shells to the chat, split by kind", async () => {
    const h = harness(
      [
        row(1, 0), // the server
        row(10, 1), // session root
        row(11, 10), // an MCP server under it
        row(20, 1), // a background shell
        row(21, 20), // a dev server under the shell
      ],
      {
        sessionPids: new Map([["chat-a", 10]]),
        terminals: [{ chatId: "chat-a", name: "dev", terminalId: "chat-a::dev", pid: 20 }],
      },
    );

    const snap = await h.svc.snapshot();
    expect(snap.chats).toHaveLength(1);
    const chat = snap.chats[0];
    expect(chat.session).toMatchObject({ procs: 2, rssBytes: 200 });
    expect(chat.shells).toMatchObject({ procs: 2, rssBytes: 200 });
    expect(chat.procs).toBe(4);
    expect(chat.rssBytes).toBe(400);
  });

  it("counts a shell the session itself started ONCE, on the session side", async () => {
    // Both root sets reach pid 21, so a naive sum of two subtree sizes would
    // report five processes for a chat that holds four.
    const h = harness([row(1, 0), row(10, 1), row(20, 10), row(21, 20)], {
      sessionPids: new Map([["chat-a", 10]]),
      terminals: [{ chatId: "chat-a", name: "dev", terminalId: "chat-a::dev", pid: 20 }],
    });
    const chat = (await h.svc.snapshot()).chats[0];
    expect(chat.procs).toBe(3);
    expect(chat.session.procs).toBe(3);
    expect(chat.shells.procs).toBe(0);
  });

  it("turns cumulative CPU counters into a rate over the elapsed window", async () => {
    const h = harness([row(1, 0), row(10, 1, { cpuMs: 0 })], {
      sessionPids: new Map([["chat-a", 10]]),
    });

    // First snapshot: no baseline, so no rate.
    const first = await h.svc.snapshot();
    expect(first.chats[0].cpuPct).toBeNull();
    expect(first.windowMs).toBe(0);

    // 1000 ms later the process has burned 500 ms of CPU — half a core.
    h.advance(1000);
    h.setTable([row(1, 0), row(10, 1, { cpuMs: 500 })]);
    const second = await h.svc.snapshot();
    expect(second.windowMs).toBe(1000);
    expect(second.chats[0].cpuPct).toBeCloseTo(50);
  });

  it("does not charge a brand-new process its entire lifetime CPU", async () => {
    const h = harness([row(1, 0)], { sessionPids: new Map([["chat-a", 10]]) });
    await h.svc.snapshot();

    // pid 10 appears for the first time, already holding 9 seconds of CPU from
    // before we were watching. Billing that to a 1 s window would render a
    // just-spawned `tsc` at 900%.
    h.advance(1000);
    h.setTable([row(1, 0), row(10, 1, { cpuMs: 9000 })]);
    const snap = await h.svc.snapshot();
    expect(snap.chats[0].cpuPct).toBeNull();
  });

  it("discards a backwards CPU delta rather than reporting it", async () => {
    const h = harness([row(1, 0), row(10, 1, { cpuMs: 5000 })], {
      sessionPids: new Map([["chat-a", 10]]),
    });
    await h.svc.snapshot();

    // The counter went DOWN: pid 10 was recycled onto a different process.
    h.advance(1000);
    h.setTable([row(1, 0), row(10, 1, { cpuMs: 12 })]);
    expect((await h.svc.snapshot()).chats[0].cpuPct).toBeNull();
  });

  it("suppresses rates when two scans land too close together", async () => {
    const h = harness([row(1, 0), row(10, 1, { cpuMs: 0 })], {
      sessionPids: new Map([["chat-a", 10]]),
    });
    await h.svc.snapshot();

    // 40 ms apart, one scheduling quantum of drift: dividing by that window
    // yields percentages in the hundreds for a process that did nothing.
    h.advance(40);
    h.setTable([row(1, 0), row(10, 1, { cpuMs: 20 })]);
    const tooSoon = await h.svc.snapshot();
    expect(tooSoon.chats[0].cpuPct).toBeNull();
    expect(tooSoon.windowMs).toBe(0);

    // ...but the baseline still advanced, so the next poll is clean rather
    // than inheriting the bad window.
    h.advance(1000);
    h.setTable([row(1, 0), row(10, 1, { cpuMs: 520 })]);
    expect((await h.svc.snapshot()).chats[0].cpuPct).toBeCloseTo(50);
  });

  it("does not let a second reader steal the first one's CPU baseline", async () => {
    // THE REGRESSION. The baseline used to advance on every call, so a reading
    // was something a caller CONSUMED. With the page polling at 5 s, any second
    // reader — another browser tab, the header dropdown, a curl — landed just
    // after it, differenced against a baseline 100 ms old, and got null for
    // every CPU figure. Two tabs blanked the CPU column for both.
    const h = harness([row(1, 0), row(10, 1, { cpuMs: 0 })], {
      sessionPids: new Map([["chat-a", 10]]),
    });
    await h.svc.snapshot();

    h.advance(4000);
    h.setTable([row(1, 0), row(10, 1, { cpuMs: 2000 })]);
    const pagePoll = await h.svc.snapshot();
    expect(pagePoll.chats[0].cpuPct).toBeCloseTo(50);

    // A second client 100 ms behind the first must still get a real number,
    // differenced against the SAME baseline rather than against the poll that
    // just happened.
    h.advance(100);
    const secondTab = await h.svc.snapshot();
    expect(secondTab.chats[0].cpuPct).not.toBeNull();
    expect(secondTab.windowMs).toBeGreaterThan(0);
  });

  it("advances the baseline once it has aged, so windows stay bounded", async () => {
    const h = harness([row(1, 0), row(10, 1, { cpuMs: 0 })], {
      sessionPids: new Map([["chat-a", 10]]),
    });
    await h.svc.snapshot();

    // Past the refresh age → this reading becomes the new baseline...
    h.advance(4000);
    h.setTable([row(1, 0), row(10, 1, { cpuMs: 4000 })]);
    expect((await h.svc.snapshot()).windowMs).toBe(4000);

    // ...so the next window is measured from HERE, not from the very first
    // sample. Without that, `windowMs` would grow without bound.
    h.advance(4000);
    h.setTable([row(1, 0), row(10, 1, { cpuMs: 6000 })]);
    const next = await h.svc.snapshot();
    expect(next.windowMs).toBe(4000);
    expect(next.chats[0].cpuPct).toBeCloseTo(50);
  });

  it("keeps a tree's CPU when only some of its processes are measurable", async () => {
    const h = harness([row(1, 0), row(10, 1, { cpuMs: 0 }), row(11, 10, { cpuMs: 0 })], {
      sessionPids: new Map([["chat-a", 10]]),
    });
    await h.svc.snapshot();

    // pid 12 is new (unmeasurable); pid 11 burned 250 ms. One unmeasurable
    // process must not blank the whole tree's figure.
    h.advance(1000);
    h.setTable([
      row(1, 0),
      row(10, 1, { cpuMs: 0 }),
      row(11, 10, { cpuMs: 250 }),
      row(12, 10, { cpuMs: 9999 }),
    ]);
    expect((await h.svc.snapshot()).chats[0].cpuPct).toBeCloseTo(25);
  });
});

describe("ResourceService dispatch tree", () => {
  it("totals the server's whole tree and separates what no chat explains", async () => {
    const h = harness(
      [
        row(1, 0, { rssBytes: 300 }), // the server itself
        row(10, 1), // chat-a's session
        row(11, 10), // an MCP server under it
        row(50, 1, { rssBytes: 400 }), // a sub-app runner — no chat owns it
      ],
      { sessionPids: new Map([["chat-a", 10]]), serverPid: 1 },
    );

    const snap = await h.svc.snapshot();
    expect(snap.dispatch).toMatchObject({
      pid: 1,
      procs: 4,
      rssBytes: 900,
      serverRssBytes: 300,
    });
    // The server (300) plus the unowned runner (400); the chat's 200 is not.
    expect(snap.dispatch?.unattributed).toEqual({ procs: 2, rssBytes: 700 });
  });

  it("is absent, not zeroed, when the server pid is missing from the table", async () => {
    // A failed scan or a table that doesn't list us must not render as
    // "Dispatch is using nothing" — that is a number somebody would act on.
    const h = harness([row(10, 9)], { serverPid: 999 });
    expect((await h.svc.snapshot()).dispatch).toBeNull();
  });

  it("never reports negative unattributed when a chat sits outside the tree", async () => {
    // A session the server adopted across a restart is the chat's, but is not
    // in the server's subtree; subtracting it wholesale would go negative.
    const h = harness([row(1, 0, { rssBytes: 300 }), row(77, 2, { rssBytes: 500 })], {
      sessionPids: new Map([["orphaned", 77]]),
      serverPid: 1,
    });
    const snap = await h.svc.snapshot();
    expect(snap.dispatch?.unattributed).toEqual({ procs: 1, rssBytes: 300 });
  });
});

describe("ResourceService.chatDetail", () => {
  it("lists each process with its kind, biggest first", async () => {
    const h = harness(
      [row(1, 0), row(10, 1, { rssBytes: 50 }), row(11, 10, { rssBytes: 900 }), row(20, 1)],
      {
        sessionPids: new Map([["chat-a", 10]]),
        terminals: [{ chatId: "chat-a", name: "dev", terminalId: "chat-a::dev", pid: 20 }],
      },
    );
    const detail = await h.svc.chatDetail("chat-a");
    expect(detail.procs.map((p) => p.pid)).toEqual([11, 20, 10]);
    expect(detail.procs.find((p) => p.pid === 20)?.kind).toBe("shell");
    expect(detail.procs.find((p) => p.pid === 11)?.kind).toBe("session");
  });

  it("does not consume the snapshot's CPU baseline", async () => {
    const h = harness([row(1, 0), row(10, 1, { cpuMs: 0 })], {
      sessionPids: new Map([["chat-a", 10]]),
    });
    await h.svc.snapshot();

    h.advance(1000);
    h.setTable([row(1, 0), row(10, 1, { cpuMs: 500 })]);
    // Opening a drill-down alongside the main poll must not leave the main
    // view differencing against a zero-length window and blank its CPU column.
    await h.svc.chatDetail("chat-a");
    expect((await h.svc.snapshot()).chats[0].cpuPct).toBeCloseTo(50);
  });

  it("returns nothing for a chat that holds no processes", async () => {
    const h = harness([row(1, 0)]);
    expect((await h.svc.chatDetail("ghost")).procs).toEqual([]);
  });
});

describe("ProcTableCache", () => {
  it("serves one scan to concurrent callers", async () => {
    let scans = 0;
    const cache = new ProcTableCache({
      read: async () => {
        scans++;
        return [row(1, 0)];
      },
    });
    await Promise.all([cache.read(), cache.read(), cache.read()]);
    expect(scans).toBe(1);
  });

  it("keeps the last real reading when a scan comes back empty", async () => {
    // An empty table is a FAILED table. Serving it would tell every chat it
    // holds nothing — plausible, uniformly wrong, indistinguishable from real.
    let rows = [row(1, 0), row(2, 1)];
    const c = clock();
    const cache = new ProcTableCache({ read: async () => rows, now: c.now, ttlMs: 10 });
    expect((await cache.read()).rows).toHaveLength(2);

    rows = [];
    c.advance(100);
    expect((await cache.read()).rows).toHaveLength(2);

    // ...and the gap was not cached, so the next call retries rather than
    // serving the stale answer for a full TTL.
    rows = [row(1, 0)];
    c.advance(1);
    expect((await cache.read()).rows).toHaveLength(1);
  });

  it("bypasses the cache when a caller demands a fresh read", async () => {
    let rows = [row(1, 0)];
    const c = clock();
    const cache = new ProcTableCache({ read: async () => rows, now: c.now, ttlMs: 60_000 });
    await cache.read();
    rows = [row(1, 0), row(2, 1)];
    // Cached — still the old answer.
    expect((await cache.read()).rows).toHaveLength(1);
    // A kill path must never signal pids off that. `fresh` re-scans.
    expect((await cache.read(true)).rows).toHaveLength(2);
  });

  it("re-scans after an invalidate", async () => {
    let rows = [row(1, 0), row(2, 1)];
    const c = clock();
    const cache = new ProcTableCache({ read: async () => rows, now: c.now, ttlMs: 60_000 });
    await cache.read();
    rows = [row(1, 0)];
    cache.invalidate();
    expect((await cache.read()).rows).toHaveLength(1);
  });
});
