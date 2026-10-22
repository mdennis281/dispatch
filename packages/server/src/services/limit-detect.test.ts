import { describe, it, expect } from "vitest";
import { claudeWindowOf } from "@dispatch/shared";
import { classifyStep, readingChanged, resetMoveTolerance } from "./limit-detect.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 22, 10, 0, 0);
const FIVE_H = 300;
const WEEK = 10080;

const at = (ts: number, percent: number, resetsAt: number | null) => ({ ts, percent, resetsAt });

describe("classifyStep", () => {
  it("ordinary use is nothing", () => {
    expect(classifyStep(at(T0, 20, T0 + 3 * HOUR), at(T0 + 5 * MIN, 24, T0 + 3 * HOUR), FIVE_H)).toBeNull();
  });

  it("a window emptying after its announced reset is a scheduled reset", () => {
    const prev = at(T0, 80, T0 + 10 * MIN);
    const next = at(T0 + 12 * MIN, 0, T0 + 5 * HOUR + 10 * MIN);
    expect(classifyStep(prev, next, FIVE_H)).toBe("reset");
  });

  it("a read just before the reset (inside the slack) still counts as past it", () => {
    const prev = at(T0, 80, T0 + 10 * MIN);
    const next = at(T0 + 9 * MIN, 0, null);
    expect(classifyStep(prev, next, FIVE_H)).toBe("reset");
  });

  it("a gap that spans the reset and refills past the old figure is still a reset", () => {
    const prev = at(T0, 30, T0 + 10 * MIN);
    const next = at(T0 + 2 * HOUR, 45, T0 + 5 * HOUR + 10 * MIN);
    expect(classifyStep(prev, next, FIVE_H)).toBe("reset");
  });

  it("an empty window rolling over is not worth a row", () => {
    expect(classifyStep(at(T0, 0, T0 + MIN), at(T0 + 5 * MIN, 0, T0 + 5 * HOUR), FIVE_H)).toBeNull();
  });

  it("past the reset but not yet rolled by the provider is nothing (yet)", () => {
    expect(classifyStep(at(T0, 50, T0 + MIN), at(T0 + 5 * MIN, 50, T0 + MIN), FIVE_H)).toBeNull();
  });

  it("emptying BEFORE the announced reset, with a new reset time, is an early reset", () => {
    // The weekly window halfway through the week.
    const prev = at(T0, 55, T0 + 3 * 24 * HOUR);
    const next = at(T0 + 15 * MIN, 0, T0 + 7 * 24 * HOUR);
    expect(classifyStep(prev, next, WEEK)).toBe("early_reset");
  });

  it("an early reset to an unopened 5-hour window (no reset time) is an early reset", () => {
    expect(classifyStep(at(T0, 70, T0 + 2 * HOUR), at(T0 + 5 * MIN, 0, null), FIVE_H)).toBe(
      "early_reset",
    );
  });

  it("80% → 20% inside the same window is a drop", () => {
    const r = T0 + 2 * HOUR;
    expect(classifyStep(at(T0, 80, r), at(T0 + 5 * MIN, 20, r), FIVE_H)).toBe("drop");
  });

  it("a one-point wobble is rounding, not a drop", () => {
    const r = T0 + 2 * HOUR;
    expect(classifyStep(at(T0, 41, r), at(T0 + 5 * MIN, 40, r), FIVE_H)).toBeNull();
  });

  it("the reset time moving without usage falling is reset_moved", () => {
    const prev = at(T0, 30, T0 + 2 * HOUR);
    const next = at(T0 + 5 * MIN, 31, T0 + 4 * HOUR);
    expect(classifyStep(prev, next, FIVE_H)).toBe("reset_moved");
  });

  it("a weekly reset sliding by under its tolerance is not news", () => {
    const prev = at(T0, 30, T0 + 3 * 24 * HOUR);
    const next = at(T0 + 5 * MIN, 31, T0 + 3 * 24 * HOUR + 2 * HOUR);
    expect(resetMoveTolerance(WEEK)).toBeGreaterThan(2 * HOUR);
    expect(classifyStep(prev, next, WEEK)).toBeNull();
  });

  it("a window opening (no reset time → one) is not a move", () => {
    expect(classifyStep(at(T0, 0, null), at(T0 + 5 * MIN, 3, T0 + 5 * HOUR), FIVE_H)).toBeNull();
  });
});

describe("readingChanged", () => {
  it("any percent change, a null flip, or a reset moving by over a minute", () => {
    expect(readingChanged(at(T0, 1, null), at(T0, 2, null))).toBe(true);
    expect(readingChanged(at(T0, 1, null), at(T0, 1, T0))).toBe(true);
    expect(readingChanged(at(T0, 1, T0), at(T0, 1, T0 + 30_000))).toBe(false);
    expect(readingChanged(at(T0, 1, T0), at(T0, 1, T0 + 2 * MIN))).toBe(true);
  });
});

describe("claudeWindowOf", () => {
  it("names the known keys and still parses ones it has never seen", () => {
    expect(claudeWindowOf("five_hour")).toEqual({
      windowId: "five_hour",
      title: "5-hour session",
      windowMinutes: 300,
    });
    expect(claudeWindowOf("seven_day")).toMatchObject({ title: "Weekly", windowMinutes: 10080 });
    expect(claudeWindowOf("seven_day_opus")).toMatchObject({ title: "Weekly · Opus" });
    expect(claudeWindowOf("seven_day_oauth_apps")).toMatchObject({ title: "Weekly · OAuth Apps" });
    expect(claudeWindowOf("one_day")).toMatchObject({ title: "1-day window", windowMinutes: 1440 });
    expect(claudeWindowOf("mystery")).toEqual({
      windowId: "mystery",
      title: "mystery",
      windowMinutes: null,
    });
  });
});
