import { describe, expect, it } from "vitest";
import type { Chat, ChatStatus, Project, Schedule, ScheduleState } from "@dispatch/shared";
import {
  ScheduleRunner,
  scheduleRunParts,
  type ScheduleRunnerOptions,
  type ScheduleSpawn,
} from "./schedule-runner.js";

const at = (iso: string): number => new Date(iso).getTime();

function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: "audit",
    name: "Morning audit",
    cron: "0 9 * * *",
    timezone: "UTC",
    prompt: "Check the dependency report.",
    enabled: true,
    catchUp: true,
    file: "audit.md",
    ...over,
  };
}

/** An in-memory store, a settable clock, and a spawn that records its calls. */
function harness(opts: { schedules?: Schedule[]; now: number; active?: boolean; spawnFails?: string }) {
  let now = opts.now;
  const states = new Map<string, ScheduleState>();
  const chats = new Map<string, Chat>();
  const spawned: ScheduleSpawn[] = [];
  let schedules = opts.schedules ?? [schedule()];
  const project = { id: "p1", name: "Repo", repoPath: "/repo" } as Project;

  const store: ScheduleRunnerOptions["store"] = {
    listProjects: async () => [project],
    listChats: async () => [...chats.values()],
    getChat: async (id: string) => chats.get(id) ?? null,
    listScheduleStates: async () => [...states.values()],
    getScheduleState: async (_p: string, sid: string) => states.get(sid) ?? null,
    saveScheduleState: async (s: ScheduleState) => {
      states.set(s.scheduleId, s);
      return s;
    },
  } as unknown as ScheduleRunnerOptions["store"];

  const runner = new ScheduleRunner({
    store,
    schedulesFor: () => schedules,
    active: () => opts.active ?? true,
    now: () => now,
    // Never let a real interval run under test; sweeps are driven by hand.
    setTimer: () => 0,
    clearTimer: () => {},
    spawn: async (input) => {
      if (opts.spawnFails) throw new Error(opts.spawnFails);
      spawned.push(input);
      const id = `chat-${spawned.length}`;
      chats.set(id, {
        id,
        projectId: input.projectId,
        title: `run ${spawned.length}`,
        status: "running",
        scheduleId: input.schedule.id,
        createdAt: now,
        updatedAt: now,
      } as Chat);
      return { chatId: id };
    },
  });

  return {
    runner,
    states,
    spawned,
    setNow: (t: number) => (now = t),
    setStatus: (id: string, status: ChatStatus) => {
      chats.get(id)!.status = status;
    },
    setSchedules: (s: Schedule[]) => (schedules = s),
  };
}

describe("ScheduleRunner", () => {
  it("only starts the clock on first sight, then fires when the slot comes due", async () => {
    const h = harness({ now: at("2026-11-04T08:00:00Z") });
    expect((await h.runner.sweep())[0]).toMatchObject({ action: "seen" });
    expect(h.spawned).toHaveLength(0);

    h.setNow(at("2026-11-04T08:30:00Z"));
    expect((await h.runner.sweep())[0]).toMatchObject({ action: "wait" });

    h.setNow(at("2026-11-04T09:00:10Z"));
    expect((await h.runner.sweep())[0]).toMatchObject({ action: "fired", chatId: "chat-1" });
    expect(h.spawned[0]).toMatchObject({ trigger: "schedule", runNumber: 1, previous: [] });
    expect(h.states.get("audit")).toMatchObject({
      lastFireAt: at("2026-11-04T09:00:00Z"),
      lastChatId: "chat-1",
      lastTrigger: "schedule",
    });

    // Same slot, next tick: nothing new.
    h.setNow(at("2026-11-04T09:00:40Z"));
    expect((await h.runner.sweep())[0]).toMatchObject({ action: "wait" });
    expect(h.spawned).toHaveLength(1);
  });

  it("makes one catch-up run after downtime, and briefs it with the earlier run", async () => {
    const h = harness({ now: at("2026-11-01T08:00:00Z") });
    await h.runner.sweep(); // seen
    h.setNow(at("2026-11-01T09:00:05Z"));
    await h.runner.sweep(); // fired chat-1
    h.setStatus("chat-1", "idle");

    // "Off" for three days.
    h.setNow(at("2026-11-04T12:00:00Z"));
    const [out] = await h.runner.sweep();
    expect(out).toMatchObject({ action: "fired", chatId: "chat-2" });
    expect(h.spawned).toHaveLength(2);
    expect(h.spawned[1]).toMatchObject({ trigger: "catch-up", runNumber: 2 });
    expect(h.spawned[1]!.previous.map((r) => r.chatId)).toEqual(["chat-1"]);
    expect(h.states.get("audit")!.lastFireAt).toBe(at("2026-11-04T09:00:00Z"));
  });

  it("with catch-up off, consumes missed slots without running", async () => {
    const h = harness({ now: at("2026-11-01T08:00:00Z"), schedules: [schedule({ catchUp: false })] });
    await h.runner.sweep();
    h.setNow(at("2026-11-04T12:00:00Z"));
    const [out] = await h.runner.sweep();
    expect(out).toMatchObject({ action: "skipped" });
    expect(out!.reason).toMatch(/missed 4 runs/);
    expect(h.spawned).toHaveLength(0);
    // The next slot is an ordinary fire.
    h.setNow(at("2026-11-05T09:00:05Z"));
    expect((await h.runner.sweep())[0]).toMatchObject({ action: "fired" });
  });

  it("passes a slot over while the previous run is still going", async () => {
    const h = harness({ now: at("2026-11-03T08:00:00Z") });
    await h.runner.sweep();
    h.setNow(at("2026-11-03T09:00:05Z"));
    await h.runner.sweep(); // chat-1, still running
    h.setStatus("chat-1", "awaiting-input");

    h.setNow(at("2026-11-04T09:00:05Z"));
    const [out] = await h.runner.sweep();
    expect(out).toMatchObject({ action: "skipped", reason: "the previous run was still going" });
    expect(h.spawned).toHaveLength(1);
    expect(h.states.get("audit")!.lastFireAt).toBe(at("2026-11-04T09:00:00Z"));
  });

  it("lets a disabled schedule's slots pass, so re-enabling it doesn't fire a catch-up", async () => {
    const h = harness({ now: at("2026-11-01T08:00:00Z"), schedules: [schedule({ enabled: false })] });
    await h.runner.sweep();
    h.setNow(at("2026-11-03T12:00:00Z"));
    expect((await h.runner.sweep())[0]).toMatchObject({ action: "skipped", reason: "disabled" });

    h.setSchedules([schedule({ enabled: true })]);
    h.setNow(at("2026-11-03T12:00:30Z"));
    expect((await h.runner.sweep())[0]).toMatchObject({ action: "wait" });
    expect(h.spawned).toHaveLength(0);
  });

  it("records a failed launch against the slot instead of retrying every tick", async () => {
    const h = harness({ now: at("2026-11-04T08:00:00Z"), spawnFails: "persona \"gone\" not found" });
    await h.runner.sweep();
    h.setNow(at("2026-11-04T09:00:05Z"));
    expect((await h.runner.sweep())[0]).toMatchObject({ action: "failed" });
    expect(h.states.get("audit")).toMatchObject({
      lastFireAt: at("2026-11-04T09:00:00Z"),
      lastError: 'persona "gone" not found',
    });
    h.setNow(at("2026-11-04T09:00:35Z"));
    expect((await h.runner.sweep())[0]).toMatchObject({ action: "wait" });
  });

  it("does nothing on the timer when this instance is not the active one", async () => {
    const h = harness({ now: at("2026-11-04T08:00:00Z"), active: false });
    expect(await h.runner.sweep()).toEqual([]);
    expect(h.states.size).toBe(0);
  });

  it("runs now on request — even when inactive or disabled — without moving the schedule", async () => {
    const h = harness({
      now: at("2026-11-04T08:00:00Z"),
      active: false,
      schedules: [schedule({ enabled: false })],
    });
    expect(await h.runner.runNow("p1", "audit")).toEqual({ chatId: "chat-1" });
    expect(h.spawned[0]).toMatchObject({ trigger: "manual" });
    expect(h.states.get("audit")).toMatchObject({ lastChatId: "chat-1", lastTrigger: "manual" });
    expect(h.states.get("audit")!.lastFireAt).toBeUndefined();
    await expect(h.runner.runNow("p1", "nope")).rejects.toThrow(/no schedule/);
  });

  it("lists next fire and past runs newest first", async () => {
    const h = harness({ now: at("2026-11-04T08:00:00Z") });
    await h.runner.runNow("p1", "audit");
    h.setNow(at("2026-11-04T08:10:00Z"));
    await h.runner.runNow("p1", "audit");
    const [view] = await h.runner.list("p1");
    expect(view!.nextRunAt).toBe(at("2026-11-04T09:00:00Z"));
    expect(view!.runs.map((r) => r.chatId)).toEqual(["chat-2", "chat-1"]);
  });
});

describe("scheduleRunParts", () => {
  const base: ScheduleSpawn = {
    projectId: "p1",
    schedule: schedule(),
    trigger: "schedule",
    previous: [],
    runNumber: 1,
  };

  it("frames the run as Dispatch talking and keeps the prompt as authored", () => {
    const parts = scheduleRunParts(base);
    expect(parts.map((p) => p.kind)).toEqual(["brief", "instructions"]);
    expect(parts[1]!.text).toBe("Check the dependency report.");
    expect(parts[0]!.text).toMatch(/first run of this schedule/);
  });

  it("names earlier runs and how to search them", () => {
    const parts = scheduleRunParts({
      ...base,
      runNumber: 3,
      previous: [
        { chatId: "c2", title: "t", status: "idle", createdAt: at("2026-11-03T09:00:00Z") },
        { chatId: "c1", title: "t", status: "idle", createdAt: at("2026-11-02T09:00:00Z") },
      ],
    });
    const brief = parts[0]!.text;
    expect(brief).toMatch(/run #3/);
    expect(brief).toContain("`c2`");
    expect(brief).toContain("`c1`");
    expect(brief).toContain('chat_find({ project: "p1", schedule: "audit" })');
    expect(brief).toContain("chat_read");
  });
});
