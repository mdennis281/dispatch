import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionLimit, type Chat } from "@dispatch/shared";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import { ResumeScheduler, RESUME_PROMPT } from "./resume-scheduler.js";

/** The sentence the SDK actually ends the turn with (verbatim from a transcript). */
const LIMIT = "You've hit your session limit · resets 4:50pm (America/Chicago)";

describe("parseSessionLimit", () => {
  // 2026-08-01T18:00:00Z = 1:00pm America/Chicago (CDT, UTC-5).
  const NOON_CT = Date.parse("2026-08-01T18:00:00.000Z");

  it("resolves the named zone's next occurrence of the clock time", () => {
    const limit = parseSessionLimit(LIMIT, NOON_CT)!;
    expect(limit).not.toBeNull();
    expect(limit.timeZone).toBe("America/Chicago");
    expect(limit.clock).toBe("4:50pm");
    // 4:50pm CDT the same day.
    expect(limit.resetsAt).toBe(Date.parse("2026-08-01T21:50:00.000Z"));
  });

  it("rolls to TOMORROW when the clock time has already passed today", () => {
    // 11pm CT — 4:50pm is behind us, so the next 4:50pm is the next day.
    const lateNight = Date.parse("2026-08-02T04:00:00.000Z");
    const limit = parseSessionLimit(LIMIT, lateNight)!;
    expect(limit.resetsAt).toBe(Date.parse("2026-08-02T21:50:00.000Z"));
    expect(limit.resetsAt).toBeGreaterThan(lateNight);
  });

  it("handles a 24h clock, a bare hour, and midnight/noon meridiems", () => {
    const at = (s: string) => parseSessionLimit(s, NOON_CT)?.resetsAt;
    // 16:50 with no zone → the host zone; assert only that it parsed + is ahead.
    expect(at("You've hit your usage limit · resets at 23:30")).toBeGreaterThan(NOON_CT);
    expect(at("You've reached your weekly limit · resets 5pm (America/Chicago)")).toBe(
      Date.parse("2026-08-01T22:00:00.000Z"),
    );
    // 12am is midnight, not noon.
    expect(at("You've hit your session limit · resets 12am (America/Chicago)")).toBe(
      Date.parse("2026-08-02T05:00:00.000Z"),
    );
    expect(at("You've hit your session limit · resets 12pm (America/Chicago)")).toBe(
      Date.parse("2026-08-02T17:00:00.000Z"),
    );
  });

  it("returns null for anything that isn't a limit notice with a time", () => {
    expect(parseSessionLimit(undefined, NOON_CT)).toBeNull();
    expect(parseSessionLimit("Error: connection reset", NOON_CT)).toBeNull();
    // A limit sentence with no reset time can't be scheduled.
    expect(parseSessionLimit("You've hit your session limit", NOON_CT)).toBeNull();
    // Garbage clock values don't produce a bogus instant.
    expect(parseSessionLimit("You've hit your session limit · resets 99:99", NOON_CT)).toBeNull();
  });

  it("survives an unrecognised zone instead of throwing", () => {
    const limit = parseSessionLimit(
      "You've hit your session limit · resets 4:50pm (Mars/Olympus)",
      NOON_CT,
    );
    expect(limit?.resetsAt).toBeGreaterThan(NOON_CT);
  });
});

describe("ResumeScheduler", () => {
  let dir: string;
  let store: Store;
  let bus: EventBus;
  /** Pending fake timers: fire them by hand so nothing waits on wall-clock. */
  let timers: { id: number; fn: () => void; ms: number }[];
  let clock: number;
  let sent: { chatId: string; text: string }[];
  let sendFails: string | null;

  const NOW = Date.parse("2026-08-01T18:00:00.000Z");

  function makeScheduler() {
    let nextId = 1;
    return new ResumeScheduler({
      store,
      bus,
      send: async (chatId, text) => {
        if (sendFails) throw new Error(sendFails);
        sent.push({ chatId, text });
      },
      deps: {
        now: () => clock,
        setTimer: (fn, ms) => {
          const id = nextId++;
          timers.push({ id, fn, ms });
          return id;
        },
        clearTimer: (h) => {
          timers = timers.filter((t) => t.id !== h);
        },
        genId: () => `n${nextId++}`,
      },
    });
  }

  /** Run every armed timer (like the wall clock reaching them) and let it land. */
  async function tick(s: ResumeScheduler) {
    const due = timers;
    timers = [];
    for (const t of due) t.fn();
    await s.drain();
  }

  function chat(id: string): Chat {
    return {
      id,
      projectId: "p1",
      title: "Work",
      modeId: "auto",
      effort: "medium",
      worktrees: [],
      prs: [],
      createdAt: NOW - 60_000,
    };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cm-resume-"));
    store = new Store(dir);
    bus = new EventBus();
    timers = [];
    clock = NOW;
    sent = [];
    sendFails = null;
    await store.saveChat(chat("c1"));
  });

  it("ignores an error that isn't a usage limit", async () => {
    const s = makeScheduler();
    expect(await s.onTurnError("c1", "Error: ECONNRESET")).toBeNull();
    expect(s.isArmed("c1")).toBe(false);
    expect((await store.getChat("c1"))?.resume).toBeUndefined();
  });

  /* ------------------------------------------------------ the resume path */

  it("plans, persists, and fires the continuation when the limit lifts", async () => {
    const s = makeScheduler();
    const updates: Chat[] = [];
    bus.on("chat-update", (e) => updates.push(e.chat));

    const plan = await s.onTurnError("c1", LIMIT);
    expect(plan).toMatchObject({ reason: LIMIT, prompt: RESUME_PROMPT });
    expect(plan!.at).toBe(Date.parse("2026-08-01T21:50:00.000Z"));
    // Persisted (a restart must be able to re-arm it) and broadcast.
    expect((await store.getChat("c1"))?.resume?.at).toBe(plan!.at);
    expect(updates.at(-1)?.resume?.at).toBe(plan!.at);
    expect(s.isArmed("c1")).toBe(true);
    // Armed for exactly the remaining wait, not some fixed retry interval.
    expect(timers[0]!.ms).toBe(plan!.at - NOW);

    clock = plan!.at;
    await tick(s);

    expect(sent).toEqual([{ chatId: "c1", text: RESUME_PROMPT }]);
    // Marked fired so a later restore() can't send it a second time.
    expect((await store.getChat("c1"))?.resume?.firedAt).toBe(clock);
    // …and the transcript explains where the new turn came from.
    const rows = await store.readMessages("c1");
    expect(rows.at(-1)).toMatchObject({
      kind: "notice",
      level: "info",
      text: "Usage limit lifted — continuing automatically.",
    });
  });

  it("re-sleeps instead of firing early when the timer wakes ahead of time", async () => {
    const s = makeScheduler();
    await s.onTurnError("c1", LIMIT);
    // Wake with an hour still to go (the clamped-long-sleep case).
    clock = Date.parse("2026-08-01T20:50:00.000Z");
    await tick(s);
    expect(sent).toEqual([]);
    expect(s.isArmed("c1")).toBe(true);
    expect((await store.getChat("c1"))?.resume?.firedAt).toBeUndefined();
  });

  it("reports a failed continuation in the transcript instead of failing silently", async () => {
    const s = makeScheduler();
    const plan = await s.onTurnError("c1", LIMIT);
    sendFails = "session is gone";
    clock = plan!.at;
    await tick(s);
    const rows = await store.readMessages("c1");
    expect(rows.at(-1)).toMatchObject({
      kind: "notice",
      level: "error",
      text: "Could not continue automatically: session is gone",
    });
  });

  /* ------------------------------------------------------ the cancel path */

  it("cancels: disarms the timer, records it, and never sends", async () => {
    const s = makeScheduler();
    const plan = await s.onTurnError("c1", LIMIT);

    const saved = await s.cancel("c1");
    expect(saved?.resume).toMatchObject({ at: plan!.at, cancelledAt: NOW });
    expect(s.isArmed("c1")).toBe(false);
    expect(timers).toHaveLength(0);

    // Even if a stray timer did fire, the persisted cancel is the gate.
    clock = plan!.at;
    await tick(s);
    expect(sent).toEqual([]);
  });

  it("cancel is a no-op (409-able) with nothing pending, or after firing", async () => {
    const s = makeScheduler();
    expect(await s.cancel("c1")).toBeNull();

    const plan = await s.onTurnError("c1", LIMIT);
    clock = plan!.at;
    await tick(s);
    expect(sent).toHaveLength(1);
    // Already fired → nothing left to cancel.
    expect(await s.cancel("c1")).toBeNull();
    // …and cancelling twice doesn't re-write the record.
    await s.onTurnError("c1", LIMIT);
    expect(await s.cancel("c1")).not.toBeNull();
    expect(await s.cancel("c1")).toBeNull();
  });

  /* ------------------------------------------------------------- restart */

  it("re-arms pending plans on restore and skips cancelled/fired ones", async () => {
    await store.saveChat({
      ...chat("c2"),
      resume: { at: NOW + 5_000, reason: LIMIT, prompt: RESUME_PROMPT },
    });
    await store.saveChat({
      ...chat("c3"),
      resume: { at: NOW + 5_000, reason: LIMIT, prompt: RESUME_PROMPT, cancelledAt: NOW },
    });
    await store.saveChat({
      ...chat("c4"),
      resume: { at: NOW - 5_000, reason: LIMIT, prompt: RESUME_PROMPT, firedAt: NOW },
    });

    const s = makeScheduler();
    await s.restore();
    expect(s.isArmed("c2")).toBe(true);
    expect(s.isArmed("c3")).toBe(false);
    expect(s.isArmed("c4")).toBe(false);

    clock = NOW + 5_000;
    await tick(s);
    expect(sent).toEqual([{ chatId: "c2", text: RESUME_PROMPT }]);
  });

  it("fires straight away for a plan whose reset passed while the server was down", async () => {
    await store.saveChat({
      ...chat("c5"),
      resume: { at: NOW - 60 * 60_000, reason: LIMIT, prompt: RESUME_PROMPT },
    });
    const s = makeScheduler();
    await s.restore();
    expect(timers.find((t) => t.ms === 0)).toBeTruthy();
    await tick(s);
    expect(sent).toEqual([{ chatId: "c5", text: RESUME_PROMPT }]);
  });

  it("dispose drops every armed timer", async () => {
    const s = makeScheduler();
    await s.onTurnError("c1", LIMIT);
    s.dispose();
    expect(timers).toHaveLength(0);
    expect(s.isArmed("c1")).toBe(false);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));
});
