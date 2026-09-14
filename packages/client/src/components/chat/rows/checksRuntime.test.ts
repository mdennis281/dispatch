import { describe, expect, it } from "vitest";
import type { CheckRun } from "@dispatch/shared";
import { checksRuntime } from "./PrStateView.js";

const T0 = Date.parse("2026-09-14T10:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const MIN = 60_000;

function job(start: number, end?: number, status: CheckRun["status"] = "completed"): CheckRun {
  return {
    name: `job-${start}`,
    status,
    conclusion: status === "completed" ? "success" : null,
    startedAt: at(start),
    ...(end !== undefined ? { completedAt: at(end) } : {}),
  };
}

describe("checksRuntime", () => {
  it("counts parallel jobs once, not summed", () => {
    expect(checksRuntime([job(0, 5), job(0, 3), job(1, 4)], null)).toEqual({
      ms: 5 * MIN,
      partial: false,
    });
  });

  it("drops the idle gap before a job re-run hours later", () => {
    // 10:00–10:05, then a re-run 14:00–14:03: 8 minutes of CI, not 4h 3m.
    expect(checksRuntime([job(0, 5), job(240, 243)], null)).toEqual({
      ms: 8 * MIN,
      partial: false,
    });
  });

  it("gives no total on a frozen snapshot while any job is unfinished", () => {
    expect(checksRuntime([job(0, 2), job(2, undefined, "queued")], null)).toBeUndefined();
    expect(checksRuntime([job(0, 2), job(2, undefined, "in_progress")], null)).toBeUndefined();
  });

  it("marks a live total partial while a job is still queued", () => {
    // Queued jobs carry a startedAt but have not run, so they add no time.
    const now = T0 + 10 * MIN;
    expect(checksRuntime([job(0, 2), job(2, undefined, "queued")], now)).toEqual({
      ms: 2 * MIN,
      partial: true,
    });
  });

  it("ticks an in-progress job up to now on a live row", () => {
    const now = T0 + 7 * MIN;
    expect(checksRuntime([job(0, 2), job(3, undefined, "in_progress")], now)).toEqual({
      ms: 6 * MIN,
      partial: true,
    });
  });
});
