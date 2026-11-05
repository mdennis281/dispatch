import { describe, expect, it } from "vitest";
import {
  checkCron,
  cronToPreset,
  describeCron,
  nextFireAfter,
  presetToCron,
  scheduleDue,
  SCHEDULE_FIRE_GRACE_MS,
  MISSED_COUNT_CAP,
  type SchedulePreset,
} from "./schedules.js";

// A fixed UTC zone keeps every expectation independent of the machine's clock.
const TZ = "UTC";
const at = (iso: string): number => new Date(iso).getTime();

describe("checkCron", () => {
  it("accepts five-field crons", () => {
    expect(checkCron("0 9 * * 1-5", TZ)).toEqual({ ok: true });
  });

  it("refuses a six-field (seconds-first) pattern rather than misreading it", () => {
    const r = checkCron("0 0 9 * * *", TZ);
    expect(r.ok).toBe(false);
  });

  it("refuses garbage with the parser's reason", () => {
    const r = checkCron("not a cron x", TZ);
    expect(r.ok).toBe(false);
  });

  it("refuses anything firing more often than every five minutes", () => {
    expect(checkCron("* * * * *", TZ).ok).toBe(false);
    expect(checkCron("*/2 * * * *", TZ).ok).toBe(false);
    expect(checkCron("*/5 * * * *", TZ).ok).toBe(true);
  });

  it("judges spacing over the whole hour, not from whenever it is asked", () => {
    // Two fires three minutes apart once an hour: the next-two-fires check
    // accepted this at :01 (57 min to the next pair) and refused it at :04.
    expect(checkCron("0,3 * * * *", TZ).ok).toBe(false);
    // The wrap from :58 to the next hour's :01 is a 3-minute gap too…
    expect(checkCron("1,58 * * * *", TZ).ok).toBe(false);
    // …but only when consecutive hours both fire.
    expect(checkCron("1,58 9,15 * * *", TZ).ok).toBe(true);
    expect(checkCron("1,58 9-10 * * *", TZ).ok).toBe(false);
    expect(checkCron("0,30 * * * *", TZ).ok).toBe(true);
    expect(checkCron("10-20/5 * * * *", TZ).ok).toBe(true);
    expect(checkCron("10-14 * * * *", TZ).ok).toBe(false);
  });

  it("refuses an unknown timezone", () => {
    expect(checkCron("0 9 * * *", "Not/AZone").ok).toBe(false);
  });
});

describe("presets", () => {
  const cases: Array<[SchedulePreset, string, string]> = [
    [{ kind: "minutes", every: 15 }, "*/15 * * * *", "Every 15 minutes"],
    [{ kind: "hours", every: 1, minute: 5 }, "5 * * * *", "Hourly at :05"],
    [{ kind: "hours", every: 6, minute: 0 }, "0 */6 * * *", "Every 6 hours at :00"],
    [{ kind: "daily", hour: 9, minute: 30 }, "30 9 * * *", "Daily at 09:30"],
    [{ kind: "weekdays", hour: 8, minute: 0 }, "0 8 * * 1-5", "Weekdays at 08:00"],
    [{ kind: "weekly", day: 1, hour: 17, minute: 0 }, "0 17 * * 1", "Mondays at 17:00"],
    [{ kind: "monthly", date: 1, hour: 6, minute: 0 }, "0 6 1 * *", "Monthly on the 1st at 06:00"],
  ];

  it.each(cases)("%j ⇄ %s", (preset, cron, text) => {
    expect(presetToCron(preset)).toBe(cron);
    expect(cronToPreset(cron)).toEqual(preset);
    expect(describeCron(cron)).toBe(text);
  });

  it("does not 'simplify' a cron that isn't a preset shape", () => {
    // Two hours in one field: no preset says this, so it must reopen as raw cron.
    expect(cronToPreset("0 9,17 * * *")).toBeNull();
    expect(describeCron("0 9,17 * * *")).toBe("cron 0 9,17 * * *");
    // A minute step outside the offered list would round-trip to a different one.
    expect(cronToPreset("*/7 * * * *")).toBeNull();
    // Day 31 doesn't exist in every month — not offered as a monthly preset.
    expect(cronToPreset("0 6 31 * *")).toBeNull();
  });
});

describe("nextFireAfter", () => {
  it("is strictly after — a slot exactly at `after` is not the next one", () => {
    expect(nextFireAfter("0 9 * * *", at("2026-11-04T09:00:00Z"), TZ)).toBe(at("2026-11-05T09:00:00Z"));
    expect(nextFireAfter("0 9 * * *", at("2026-11-04T08:59:00Z"), TZ)).toBe(at("2026-11-04T09:00:00Z"));
  });

  it("reads the cron in the schedule's zone", () => {
    // 09:00 in Chicago (CST, UTC-6 in November) is 15:00Z.
    expect(nextFireAfter("0 9 * * *", at("2026-11-04T00:00:00Z"), "America/Chicago")).toBe(
      at("2026-11-04T15:00:00Z"),
    );
  });
});

describe("scheduleDue", () => {
  const daily = { cron: "0 9 * * *", timezone: TZ, catchUp: true };

  it("waits when nothing has come due since the last slot", () => {
    const state = { firstSeenAt: at("2026-11-01T00:00:00Z"), lastFireAt: at("2026-11-04T09:00:00Z") };
    expect(scheduleDue(daily, state, at("2026-11-04T20:00:00Z"))).toEqual({ action: "wait" });
  });

  it("never counts slots before the schedule was first seen as missed", () => {
    // Authored at 10:00 — 09:00 that day already passed, but was never ours.
    const state = { firstSeenAt: at("2026-11-04T10:00:00Z") };
    expect(scheduleDue(daily, state, at("2026-11-04T10:00:30Z"))).toEqual({ action: "wait" });
  });

  it("fires a slot that just came due", () => {
    const state = { firstSeenAt: at("2026-11-01T00:00:00Z"), lastFireAt: at("2026-11-03T09:00:00Z") };
    const now = at("2026-11-04T09:00:20Z");
    expect(scheduleDue(daily, state, now)).toEqual({ action: "fire", slot: at("2026-11-04T09:00:00Z"), missed: 1 });
  });

  it("fires a slot due exactly now", () => {
    const state = { firstSeenAt: at("2026-11-01T00:00:00Z"), lastFireAt: at("2026-11-03T09:00:00Z") };
    const now = at("2026-11-04T09:00:00Z");
    expect(scheduleDue(daily, state, now)).toMatchObject({ action: "fire", slot: now });
  });

  it("makes ONE catch-up for many missed slots, at the newest one", () => {
    // Off for a week.
    const state = { firstSeenAt: at("2026-10-01T00:00:00Z"), lastFireAt: at("2026-10-28T09:00:00Z") };
    const now = at("2026-11-04T12:00:00Z");
    expect(scheduleDue(daily, state, now)).toEqual({
      action: "catch-up",
      slot: at("2026-11-04T09:00:00Z"),
      missed: 7,
    });
  });

  it("treats a single slot that is older than the grace as missed, not punctual", () => {
    const state = { firstSeenAt: at("2026-11-01T00:00:00Z"), lastFireAt: at("2026-11-03T09:00:00Z") };
    const now = at("2026-11-04T09:00:00Z") + SCHEDULE_FIRE_GRACE_MS + 1;
    expect(scheduleDue(daily, state, now)).toMatchObject({ action: "catch-up", missed: 1 });
  });

  it("skips missed slots (recording the newest) when catch-up is off", () => {
    const state = { firstSeenAt: at("2026-10-01T00:00:00Z"), lastFireAt: at("2026-10-28T09:00:00Z") };
    const now = at("2026-11-04T12:00:00Z");
    expect(scheduleDue({ ...daily, catchUp: false }, state, now)).toEqual({
      action: "skip",
      slot: at("2026-11-04T09:00:00Z"),
      missed: 7,
    });
  });

  it("stays bounded on a tight cron missed for a long time", () => {
    const state = { firstSeenAt: 0, lastFireAt: at("2026-10-04T00:00:00Z") };
    const now = at("2026-11-04T00:02:00Z");
    const due = scheduleDue({ cron: "*/5 * * * *", timezone: TZ, catchUp: true }, state, now);
    expect(due).toMatchObject({ action: "catch-up", slot: at("2026-11-04T00:00:00Z") });
    // Counted only up to the cap — it is display text, and counting is a walk.
    expect(due.action !== "wait" && due.missed).toBe(MISSED_COUNT_CAP);
  });
});
