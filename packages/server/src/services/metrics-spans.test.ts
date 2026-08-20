import { describe, it, expect } from "vitest";
import {
  SPAN_COLUMN,
  bucketEnd,
  bucketIndex,
  bucketStart,
  distributeSpan,
  spanKey,
  unionByGroup,
  unionUnder,
  type UnionRow,
} from "./metrics-spans.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 2026-08-18T12:34:56Z — a Tuesday, so the week anchor is visible. */
const T = Date.UTC(2026, 7, 18, 12, 34, 56);

describe("metrics-spans — bucket boundaries", () => {
  it("snaps to the start of the hour, day and month in UTC", () => {
    expect(bucketStart(T, "hour")).toBe(Date.UTC(2026, 7, 18, 12));
    expect(bucketStart(T, "day")).toBe(Date.UTC(2026, 7, 18));
    expect(bucketStart(T, "month")).toBe(Date.UTC(2026, 7, 1));
  });

  it("anchors weeks on Monday, matching SQLite's `weekday 1, -7 days`", () => {
    // 2026-08-18 is a Tuesday; its week starts Monday the 17th.
    expect(bucketStart(T, "week")).toBe(Date.UTC(2026, 7, 17));
    // A Monday is its own week start, not the previous week's.
    expect(bucketStart(Date.UTC(2026, 7, 17), "week")).toBe(Date.UTC(2026, 7, 17));
    // A Sunday belongs to the week that began six days earlier.
    expect(bucketStart(Date.UTC(2026, 7, 23, 23, 59), "week")).toBe(Date.UTC(2026, 7, 17));
  });

  it("steps a month by the calendar, not by 30 days", () => {
    // February, so a fixed-width step would land in the wrong month.
    expect(bucketEnd(Date.UTC(2026, 1, 1), "month")).toBe(Date.UTC(2026, 2, 1));
    expect(bucketEnd(Date.UTC(2026, 11, 1), "month")).toBe(Date.UTC(2027, 0, 1));
  });

  it("finds the containing bucket, clamped at both ends", () => {
    const buckets = [0, DAY, 2 * DAY];
    expect(bucketIndex(buckets, DAY + 5)).toBe(1);
    expect(bucketIndex(buckets, DAY)).toBe(1);
    // Out of range lands in the edge bucket rather than dropping the time.
    expect(bucketIndex(buckets, -1)).toBe(0);
    expect(bucketIndex(buckets, 99 * DAY)).toBe(2);
    expect(bucketIndex([], 5)).toBe(-1);
  });
});

describe("metrics-spans — distributing a span across buckets", () => {
  const buckets = [0, DAY, 2 * DAY, 3 * DAY];

  it("splits an overnight span across the days it actually covers", () => {
    const out = [0, 0, 0, 0];
    // 23:00 on day 0 to 03:00 on day 1: one hour, then three.
    distributeSpan(23 * HOUR, DAY + 3 * HOUR, buckets, "day", out);
    expect(out).toEqual([HOUR, 3 * HOUR, 0, 0]);
  });

  it("conserves the total no matter how many buckets it crosses", () => {
    const out = [0, 0, 0, 0];
    const s = 5 * HOUR;
    const e = 2 * DAY + 11 * HOUR;
    distributeSpan(s, e, buckets, "day", out);
    expect(out.reduce((a, b) => a + b, 0)).toBe(e - s);
  });

  it("adds nothing for an empty or inverted span", () => {
    const out = [0, 0, 0, 0];
    distributeSpan(DAY, DAY, buckets, "day", out);
    distributeSpan(2 * DAY, DAY, buckets, "day", out);
    expect(out).toEqual([0, 0, 0, 0]);
  });

  it("closes the final bucket at its calendar end, not at the list's end", () => {
    const months = [Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1)];
    const out = [0, 0];
    const s = Date.UTC(2026, 0, 31, 12);
    const e = Date.UTC(2026, 1, 2);
    distributeSpan(s, e, months, "month", out);
    expect(out[0]).toBe(Date.UTC(2026, 1, 1) - s);
    expect(out[1]).toBe(e - Date.UTC(2026, 1, 1));
  });
});

describe("metrics-spans — union", () => {
  const row = (g: string, c: string, r: string, s: number, e: number): UnionRow => ({
    g,
    c,
    r,
    s,
    e,
  });

  it("merges overlapping intervals of ONE actor into one stretch", () => {
    // Five tool calls open at once are one stretch of that agent's time.
    const ms = unionByGroup([
      row("a", "c1", "", 0, 100),
      row("a", "c1", "", 10, 40),
      row("a", "c1", "", 50, 160),
    ]).get("a");
    expect(ms).toBe(160);
  });

  it("keeps a gap between disjoint intervals", () => {
    const ms = unionByGroup([
      row("a", "c1", "", 0, 100),
      row("a", "c1", "", 500, 600),
    ]).get("a");
    expect(ms).toBe(200);
  });

  it("does NOT merge two actors — concurrent chats are two agent-hours", () => {
    const ms = unionByGroup([
      row("a", "c1", "", 0, 100),
      row("a", "c2", "", 0, 100),
    ]).get("a");
    expect(ms).toBe(200);
  });

  it("treats a subagent run as its own actor within the same chat", () => {
    // The parent waits on the child for the whole stretch; that is two actors
    // busy, not one, or a fleet of subagents would cost nothing.
    const ms = unionByGroup([
      row("a", "c1", "", 0, 100),
      row("a", "c1", "run-1", 10, 90),
    ]).get("a");
    expect(ms).toBe(180);
  });

  it("resets between groups", () => {
    const out = unionByGroup([
      row("a", "c1", "", 0, 100),
      row("b", "c1", "", 50, 200),
    ]);
    expect(out.get("a")).toBe(100);
    expect(out.get("b")).toBe(150);
  });

  it("re-unions a folded subset instead of summing its groups", () => {
    // One actor appearing under two folded groups must be counted once. Summing
    // the groups' wall clocks would report 200 for 100 ms of real time.
    const rows = [
      row("keep", "c1", "", 0, 50),
      row("x", "c1", "", 0, 100),
      row("y", "c1", "", 0, 100),
    ];
    expect(unionUnder(rows, "other", (g) => g !== "keep")).toBe(100);
    // And every row together is still just that one actor's 100 ms.
    expect(unionUnder(rows, "")).toBe(100);
  });
});

describe("metrics-spans — keys", () => {
  it("prefers the tool id, so a re-import re-derives the same span", () => {
    const a = spanKey({ state: "shell", chatId: "c1", identifier: "Bash", startTs: 1 }, "tu-1");
    const b = spanKey({ state: "shell", chatId: "c1", identifier: "Bash", startTs: 999 }, "tu-1");
    expect(a).toBe(b);
  });

  it("keeps two states of the same call apart", () => {
    // One tool call produces a permission wait AND an execution; they are not
    // the same stretch of time and must not collapse onto one row.
    const wait = spanKey({ state: "waiting_human", chatId: "c1", startTs: 1 }, "tu-1");
    const run = spanKey({ state: "shell", chatId: "c1", startTs: 2 }, "tu-1");
    expect(wait).not.toBe(run);
  });

  it("falls back to coordinates plus the start time", () => {
    const base = { state: "generating" as const, chatId: "c1", identifier: "turn" };
    expect(spanKey({ ...base, startTs: 1 })).not.toBe(spanKey({ ...base, startTs: 2 }));
    expect(spanKey({ ...base, startTs: 1, runId: "r1" })).not.toBe(spanKey({ ...base, startTs: 1 }));
  });
});

describe("metrics-spans — the class expression", () => {
  it("covers every state, so none can silently fall through to the ELSE", () => {
    // The ELSE arm exists for a database written by a newer build; it must never
    // be what a state this build knows about lands on.
    for (const state of ["generating", "tool", "shell", "sleeping", "queued"]) {
      expect(SPAN_COLUMN.class).toContain(`WHEN '${state}' THEN '`);
    }
    expect(SPAN_COLUMN.class).toContain("WHEN 'generating' THEN 'thinking'");
    expect(SPAN_COLUMN.class).toContain("WHEN 'shell' THEN 'working'");
    expect(SPAN_COLUMN.class).toContain("WHEN 'sleeping' THEN 'blocked'");
  });
});
