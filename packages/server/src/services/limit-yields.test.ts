import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { limitPeriodEnd, limitPeriodStart, type LimitReading } from "@dispatch/shared";
import { Store } from "../store/index.js";
import { LimitLedger } from "./limit-ledger.js";
import { TokenLedger } from "./metrics-tokens.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
// Local time on purpose: periods align to LOCAL midnight, so the fixtures must
// too or the test would pass in one timezone and fail in another.
const at = (h: number, m = 0) => new Date(2026, 9, 22, h, m).getTime();
const label = (id: string) => id;

let dir: string;
let store: Store;
let limits: LimitLedger;
let tokens: TokenLedger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-yields-"));
  store = new Store(dir);
  limits = new LimitLedger(store.stateDb, () => at(23, 59));
  tokens = new TokenLedger(store.stateDb, () => at(23, 59));
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const weekly = (percent: number, resetsAt: number): LimitReading => ({
  windowId: "seven_day",
  title: "Weekly",
  windowMinutes: 10080,
  percent,
  resetsAt,
});
const fiveHour = (percent: number, resetsAt: number | null): LimitReading => ({
  windowId: "five_hour",
  title: "5-hour session",
  windowMinutes: 300,
  percent,
  resetsAt,
});
const read = (ts: number, readings: LimitReading[]) =>
  limits.observe({ ts, subscriptionId: "claude1", provider: "claude", readings });
const turn = (end: number, durationMs: number | undefined, total: number, cost: number | null, id: string) =>
  tokens.record([
    {
      ts: end,
      resultId: id,
      chatId: "c1",
      subscriptionId: "claude1",
      model: "claude-opus-5-5",
      input: 0,
      output: total / 10,
      cacheRead: total - total / 10,
      cacheWrite: 0,
      ...(cost === null ? {} : { costUsd: cost }),
      ...(durationMs ? { durationMs } : {}),
    },
  ]);

describe("LimitLedger.yields", () => {
  it("sums rises, counts a reset's post-reset figure, and ignores a drop", () => {
    const W = at(23, 0) + 3 * 24 * HOUR;
    read(at(9), [weekly(40, W), fiveHour(10, at(11))]);
    read(at(10), [weekly(44, W), fiveHour(30, at(11))]); // +4 weekly, +20 5h
    read(at(11, 5), [weekly(45, W), fiveHour(5, at(16))]); // +1, reset → +5
    read(at(12), [weekly(47, W), fiveHour(12, at(16))]); // +2, +7
    read(at(13), [weekly(47, W), fiveHour(3, at(16))]); // drop: +0
    const [day] = limits.yields({}, label, "1d");
    expect(Object.fromEntries(day!.windows.map((w) => [w.windowId, w.points]))).toEqual({
      five_hour: 32,
      seven_day: 7,
    });
  });

  it("spreads a turn's tokens over the hours it ran", () => {
    read(at(9), [weekly(10, at(23))]);
    read(at(13), [weekly(14, at(23))]);
    // Two hours, 11:00–13:00, booked at its end.
    turn(at(13), 2 * HOUR, 1_000_000, 10, "r1");
    const hours = limits.yields({}, label, "1h").filter((y) => y.tokens.total > 0);
    expect(hours.map((y) => [new Date(y.start).getHours(), y.tokens.total, y.tokens.costUsd])).toEqual([
      [12, 500_000, 5],
      [11, 500_000, 5],
    ]);
    // The day still sees all of it, once.
    const [day] = limits.yields({}, label, "1d");
    expect(day!.tokens).toMatchObject({ total: 1_000_000, costUsd: 10, turns: 1 });
  });

  it("counts no spend from before the account's first reading", () => {
    turn(at(8), undefined, 5_000_000, 50, "before");
    // Half of this turn ran before tracking began.
    turn(at(10), 2 * HOUR, 2_000_000, 20, "straddles");
    read(at(9), [weekly(10, at(23))]);
    read(at(11), [weekly(12, at(23))]);
    const [day] = limits.yields({}, label, "1d");
    expect(day!.tokens.total).toBe(1_000_000);
    expect(day!.tokens.costUsd).toBe(10);
  });

  it("an unpriced turn is counted as such, not as free", () => {
    read(at(9), [weekly(10, at(23))]);
    turn(at(10), undefined, 1_000, null, "codex");
    const [day] = limits.yields({}, label, "1d");
    expect(day!.tokens).toMatchObject({ costUsd: null, unpriced: 1, turns: 1 });
  });
});

describe("LimitLedger.yields — coverage", () => {
  const W = at(23, 0) + 3 * 24 * HOUR;
  // Read every 20 minutes 09:00–12:00, nothing 12:00–15:00 (the app was off),
  // then 15:00–15:55 with the window moving 2 points.
  const morningThenGap = () => {
    for (let t = at(9); t <= at(12); t += 20 * MIN) read(t, [weekly(10, W)]);
    for (const [t, p] of [
      [at(15), 12],
      [at(15, 20), 12],
      [at(15, 40), 12],
      [at(15, 55), 14],
    ] as const) {
      read(t, [weekly(p, W)]);
    }
  };

  it("gives a watched idle hour a row, and an unwatched one none", () => {
    morningThenGap();
    const hours = limits.yields({}, label, "1h");
    expect(hours.map((y) => [new Date(y.start).getHours(), y.coverage, y.windows[0]!.points])).toEqual([
      // The 10→12 rise that happened somewhere in the outage lands here, on
      // the read that saw it — which is exactly why this hour must say it was
      // only partly watched.
      [15, 55 / 60, 4],
      [11, 1, 0],
      [10, 1, 0],
      [9, 1, 0],
    ]);
    expect(hours.map((y) => y.partial)).toEqual([true, false, false, false]);
  });

  it("marks a day the app was off for most of as partial", () => {
    morningThenGap();
    const [day] = limits.yields({}, label, "1d");
    // 09–12 and 15–15:55, of a day that has run to 23:59.
    expect(day!.coverage).toBeCloseTo((3 + 55 / 60) / (23 + 59 / 60), 3);
    expect(day!.partial).toBe(true);
  });

  it("cuts at a whole period when capped, and says where", () => {
    morningThenGap();
    limits.observe({ ts: at(11, 30), subscriptionId: "codex1", provider: "codex", readings: [weekly(5, W)] });
    limits.observe({ ts: at(11, 50), subscriptionId: "codex1", provider: "codex", readings: [weekly(6, W)] });
    // Newest first: 15 (claude1), 11 (claude1, codex1), 10, 9. A cap of 2 lands
    // inside hour 11 — so ALL of hour 11 goes, not just one account's row, and
    // the client is told everything up to 12:00 is unknown rather than unwatched.
    const { rows, truncatedBefore } = limits.yieldPeriods({}, label, "1h", 2);
    expect(rows.map((y) => [new Date(y.start).getHours(), y.subscriptionId])).toEqual([[15, "claude1"]]);
    expect(truncatedBefore).toBe(at(12));
    expect(limits.yieldPeriods({}, label, "1h").truncatedBefore).toBeNull();
  });

  it("counts the running period as covered up to now while reads are fresh", () => {
    limits = new LimitLedger(store.stateDb, () => at(16, 30));
    morningThenGap();
    const now = limits.yields({}, label, "1h").find((y) => new Date(y.start).getHours() === 16);
    expect(now).toMatchObject({ coverage: 1, partial: false });
  });
});

describe("periods", () => {
  it("align to local midnight", () => {
    expect(limitPeriodStart(at(14, 37), 6)).toBe(at(12));
    expect(limitPeriodStart(at(14, 37), 24)).toBe(at(0));
    expect(limitPeriodEnd(at(18), 6)).toBe(new Date(2026, 9, 23, 0).getTime());
  });
});
