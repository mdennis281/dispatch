import { describe, it, expect } from "vitest";
import { usageWindowsOf } from "./usage.js";

describe("usageWindowsOf", () => {
  it("lists Claude's two slots under their own labels, in order", () => {
    expect(
      usageWindowsOf({
        fiveHour: { percent: 12, resetsAt: 1 },
        sevenDay: { percent: 40, resetsAt: 2 },
        fetchedAt: 0,
        primaryLabel: "5-hour session",
        secondaryLabel: "Weekly",
      }).map((w) => [w.title, w.percent]),
    ).toEqual([
      ["5-hour session", 12],
      ["Weekly", 40],
    ]);
  });

  it("drops a window the provider did not report instead of drawing an empty row", () => {
    // Codex on this plan reports only its weekly window.
    const windows = usageWindowsOf({
      fiveHour: { percent: 100, resetsAt: null },
      sevenDay: null,
      fetchedAt: 0,
      primaryLabel: "Weekly",
    });
    expect(windows).toEqual([{ percent: 100, resetsAt: null, title: "Weekly" }]);
  });

  it("prefers an explicit window list, so a provider can report N", () => {
    const windows = [
      { title: "Hourly", percent: 1, resetsAt: null },
      { title: "Daily", percent: 2, resetsAt: null },
      { title: "Monthly", percent: 3, resetsAt: null },
    ];
    expect(
      usageWindowsOf({ fiveHour: null, sevenDay: null, fetchedAt: 0, windows }),
    ).toBe(windows);
  });
});
