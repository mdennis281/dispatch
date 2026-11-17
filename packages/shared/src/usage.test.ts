import { describe, it, expect } from "vitest";
import { usageAtCap, usageWindowsOf } from "./usage.js";

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

describe("usageAtCap", () => {
  const w = (percent: number) => ({ percent });

  it("is false below 100%, so a reset can't be spent on nothing", () => {
    // Codex answers a reset spent below the cap with `nothingToReset`.
    expect(usageAtCap({ windows: [w(99), w(40)] })).toBe(false);
  });

  it("is true once any window reads 100%", () => {
    expect(usageAtCap({ windows: [w(12), w(100)] })).toBe(true);
  });

  it("is true when the provider flags the account, whatever the percentages", () => {
    // Codex sets `reached` from a spend cap the windows don't show.
    expect(usageAtCap({ windows: [w(30)], reached: true })).toBe(true);
  });

  it("never lights the button from stale or failed numbers", () => {
    expect(usageAtCap({ windows: [w(100)], stale: true })).toBe(false);
    expect(usageAtCap({ windows: [w(100)], reached: true, error: "rate_limited" })).toBe(false);
  });
});
