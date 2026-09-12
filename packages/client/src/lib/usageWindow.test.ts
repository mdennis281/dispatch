import { describe, expect, it } from "vitest";
import { windowTag } from "./usageWindow.js";

describe("windowTag", () => {
  it("names Claude's two windows", () => {
    expect(windowTag("5-hour session", "primary")).toBe("5H");
    expect(windowTag("Weekly", "secondary")).toBe("WK");
  });

  it("follows the length a Codex window actually reports", () => {
    expect(windowTag("1-hour window", "primary")).toBe("1H");
    expect(windowTag("3-day window", "secondary")).toBe("3D");
    expect(windowTag("90-minute window", "primary")).toBe("90M");
  });

  it("falls back to the label's first word, then to the slot", () => {
    expect(windowTag("Primary window", "primary")).toBe("PRI");
    expect(windowTag(undefined, "primary")).toBe("5H");
    expect(windowTag("", "secondary")).toBe("WK");
  });
});
