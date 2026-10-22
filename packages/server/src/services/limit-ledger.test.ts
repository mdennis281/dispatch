import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LimitReading } from "@dispatch/shared";
import { Store } from "../store/index.js";
import { HOLD_MS, LimitLedger, REMOVE_AFTER_MISSES } from "./limit-ledger.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 22, 10, 0, 0);
const label = (id: string) => id;

let dir: string;
let store: Store;
let ledger: LimitLedger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-limits-"));
  store = new Store(dir);
  ledger = new LimitLedger(store.stateDb, () => T0 + 100 * HOUR);
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const fiveHour = (percent: number, resetsAt: number | null): LimitReading => ({
  windowId: "five_hour",
  title: "5-hour session",
  windowMinutes: 300,
  percent,
  resetsAt,
});
const weekly = (percent: number, resetsAt: number | null): LimitReading => ({
  windowId: "seven_day",
  title: "Weekly",
  windowMinutes: 10080,
  percent,
  resetsAt,
});

const read = (ts: number, readings: LimitReading[], extra: object = {}) =>
  ledger.observe({ ts, subscriptionId: "claude1", provider: "claude", readings, ...extra });

const points = () =>
  ledger.windows({}, label).map((w) => [w.windowId, w.points.map((p) => [p.ts - T0, p.percent])]);

describe("LimitLedger", () => {
  it("the first read of an account is inventory, not news", () => {
    expect(read(T0, [fiveHour(10, T0 + HOUR), weekly(40, T0 + 50 * HOUR)])).toEqual([]);
    expect(ledger.stats().rows).toBe(2);
  });

  it("compresses an unchanged run, but writes its last reading before the change", () => {
    read(T0, [fiveHour(10, T0 + 4 * HOUR)]);
    read(T0 + 5 * MIN, [fiveHour(10, T0 + 4 * HOUR)]);
    read(T0 + 10 * MIN, [fiveHour(10, T0 + 4 * HOUR)]);
    expect(ledger.stats().rows).toBe(1);
    read(T0 + 15 * MIN, [fiveHour(30, T0 + 4 * HOUR)]);
    // The hold point at +10m keeps the line flat-then-jump, not a ramp.
    expect(points()).toEqual([
      [
        "five_hour",
        [
          [0, 10],
          [10 * MIN, 10],
          [15 * MIN, 30],
        ],
      ],
    ]);
  });

  it("still writes an unchanged reading every HOLD_MS", () => {
    read(T0, [fiveHour(10, T0 + 4 * HOUR)]);
    read(T0 + HOLD_MS, [fiveHour(10, T0 + 4 * HOUR)]);
    expect(ledger.stats().rows).toBe(2);
  });

  it("records an early weekly reset and a mid-window drop", () => {
    read(T0, [fiveHour(80, T0 + 2 * HOUR), weekly(55, T0 + 72 * HOUR)]);
    const events = read(T0 + 5 * MIN, [fiveHour(20, T0 + 2 * HOUR), weekly(0, T0 + 168 * HOUR)]);
    expect(events.map((e) => [e.windowId, e.kind, e.fromPercent, e.toPercent])).toEqual([
      ["five_hour", "drop", 80, 20],
      ["seven_day", "early_reset", 55, 0],
    ]);
    // Bracketed by the previous read, not stamped as an instant.
    expect(events[0]!.prevTs).toBe(T0);
    expect(ledger.events({}).map((e) => e.kind)).toEqual(["early_reset", "drop"]);
  });

  it("survives a restart: the first read after it compares against the table", () => {
    read(T0, [fiveHour(70, T0 + HOUR)]);
    const fresh = new LimitLedger(store.stateDb, () => T0 + 100 * HOUR);
    const events = fresh.observe({
      ts: T0 + 2 * HOUR,
      subscriptionId: "claude1",
      provider: "claude",
      readings: [fiveHour(5, T0 + 6 * HOUR)],
    });
    expect(events.map((e) => e.kind)).toEqual(["reset"]);
  });

  it("a window appearing on a known account is news; vanishing takes several polls", () => {
    read(T0, [fiveHour(10, T0 + HOUR)]);
    expect(read(T0 + 5 * MIN, [fiveHour(10, T0 + HOUR), weekly(1, T0 + 99 * HOUR)]).map((e) => e.kind)).toEqual([
      "window_added",
    ]);
    const kinds: string[] = [];
    for (let i = 1; i <= REMOVE_AFTER_MISSES; i++) {
      kinds.push(...read(T0 + (5 + 5 * i) * MIN, [fiveHour(10, T0 + HOUR)]).map((e) => e.kind));
    }
    expect(kinds).toEqual(["window_removed"]);
    // And a restart doesn't resurrect it only to remove it again.
    const fresh = new LimitLedger(store.stateDb);
    const later: string[] = [];
    for (let i = 0; i < REMOVE_AFTER_MISSES + 1; i++) {
      later.push(
        ...fresh
          .observe({
            ts: T0 + (60 + 5 * i) * MIN,
            subscriptionId: "claude1",
            provider: "claude",
            readings: [fiveHour(10, T0 + HOUR)],
          })
          .map((e) => e.kind),
      );
    }
    expect(later).toEqual([]);
  });

  it("a push carrying one bucket never counts the others as missing", () => {
    read(T0, [fiveHour(10, T0 + HOUR), weekly(5, T0 + 99 * HOUR)]);
    const kinds: string[] = [];
    for (let i = 1; i <= REMOVE_AFTER_MISSES + 1; i++) {
      kinds.push(
        ...read(T0 + i * MIN, [fiveHour(10 + i, T0 + HOUR)], { source: "push" }).map((e) => e.kind),
      );
    }
    expect(kinds).toEqual([]);
  });

  it("plan and reset-credit changes are account events", () => {
    read(T0, [weekly(10, T0 + 99 * HOUR)], { planType: "pro", resetCredits: 2 });
    const events = read(T0 + 5 * MIN, [weekly(10, T0 + 99 * HOUR)], { planType: "max", resetCredits: 1 });
    expect(events.map((e) => [e.kind, e.detail])).toEqual([
      ["plan_changed", "pro → max"],
      ["credits_changed", "2 → 1"],
    ]);
  });

  it("a line starts at the range's left edge with the last earlier reading", () => {
    read(T0, [fiveHour(10, T0 + 4 * HOUR)]);
    read(T0 + 2 * HOUR, [fiveHour(30, T0 + 4 * HOUR)]);
    const w = ledger.windows({ from: T0 + HOUR }, label);
    expect(w[0]!.points.map((p) => p.percent)).toEqual([10, 30]);
  });
});
