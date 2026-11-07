import { describe, expect, it } from "vitest";
import { metricRequest, metricWindow } from "./metrics-window.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 6, 12);

describe("metricWindow", () => {
  it("sends an explicit window for a preset", () => {
    expect(metricWindow("7d", null, NOW)).toEqual({ from: NOW - 7 * DAY, to: NOW + 1 });
  });

  // The bug this exists for: "All time" used to send `{}`, which the usage and
  // span services read as the last 30 days.
  it("starts All time at the ledger's oldest row, not 30 days ago", () => {
    const oldest = NOW - 400 * DAY;
    expect(metricWindow("all", oldest, NOW)).toEqual({ from: oldest, to: NOW + 1 });
  });

  it("still sends an explicit from for All time when the oldest row is unknown", () => {
    const w = metricWindow("all", null, NOW);
    expect(w.from).toBe(0);
    expect(w.to).toBe(NOW + 1);
  });
});

describe("metricRequest", () => {
  it("coarsens an hourly pick over 30 days and reports it", () => {
    const r = metricRequest("30d", "hour", null, NOW);
    expect(r.bucket).toBe("day");
    expect(r.coarsened).toMatchObject({ shown: "day", wanted: "hour" });
  });

  it("sizes the All time bucket from the ledger's age", () => {
    // Two weeks of ledger fits daily; two years does not.
    expect(metricRequest("all", "day", NOW - 14 * DAY, NOW).coarsened).toBeNull();
    expect(metricRequest("all", "day", NOW - 730 * DAY, NOW).bucket).toBe("week");
  });

  it("leaves auto for the server to choose", () => {
    expect(metricRequest("all", "auto", NOW - 730 * DAY, NOW)).toMatchObject({
      bucket: "auto",
      coarsened: null,
    });
  });
});
