import { describe, it, expect } from "vitest";
import { windowLabel } from "./usage.js";

describe("windowLabel", () => {
  it("names the windows Codex actually reports", () => {
    expect(windowLabel(10080, "Secondary window")).toBe("Weekly");
    expect(windowLabel(300, "Primary window")).toBe("5-hour window");
  });

  it("uses the largest whole unit, and minutes only when nothing divides", () => {
    expect(windowLabel(2 * 24 * 60, "x")).toBe("2-day window");
    expect(windowLabel(90, "x")).toBe("90-minute window");
  });

  it("falls back when the length is missing or nonsense", () => {
    expect(windowLabel(undefined, "Primary window")).toBe("Primary window");
    expect(windowLabel(0, "Primary window")).toBe("Primary window");
  });
});
