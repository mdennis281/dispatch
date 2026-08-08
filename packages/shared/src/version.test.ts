import { describe, it, expect } from "vitest";
import { buildVersion } from "./version.js";

describe("buildVersion", () => {
  it("pads the seconds field to five digits", () => {
    expect(buildVersion(new Date("2026-08-08T00:00:05Z"))).toBe("2026.08.08.00005");
  });

  it("counts up to the last second of the day", () => {
    expect(buildVersion(new Date("2026-08-08T23:59:59Z"))).toBe("2026.08.08.86399");
  });

  it("starts the day at zero", () => {
    expect(buildVersion(new Date("2026-01-01T00:00:00Z"))).toBe("2026.01.01.00000");
  });

  it("reads the clock in UTC, not local time", () => {
    // 23:30 UTC — in any zone west of Greenwich this is still the previous
    // local day, and the stamp must not follow the local calendar.
    expect(buildVersion(new Date("2026-08-08T23:30:00Z"))).toBe("2026.08.08.84600");
  });

  it("sorts lexicographically in build order", () => {
    const early = buildVersion(new Date("2026-08-08T00:00:05Z"));
    const late = buildVersion(new Date("2026-08-08T12:00:00Z"));
    expect([late, early].sort()).toEqual([early, late]);
  });
});
