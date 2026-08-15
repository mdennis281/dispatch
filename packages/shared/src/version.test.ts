import { describe, it, expect } from "vitest";
import { buildVersion, compareBuildVersions, isBuildVersion } from "./version.js";

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

describe("isBuildVersion", () => {
  it("accepts a stamp with or without the tag's leading v", () => {
    expect(isBuildVersion("2026.08.14.81160")).toBe(true);
    expect(isBuildVersion("v2026.08.14.81160")).toBe(true);
  });

  it("rejects semver and anything unpadded", () => {
    expect(isBuildVersion("v0.1.0")).toBe(false);
    expect(isBuildVersion("2026.8.14.81160")).toBe(false);
    expect(isBuildVersion("2026.08.14.8116")).toBe(false);
    expect(isBuildVersion("")).toBe(false);
  });
});

describe("compareBuildVersions", () => {
  it("orders two stamps from the same day", () => {
    expect(compareBuildVersions("2026.08.14.81160", "2026.08.14.85068")).toBe(-1);
    expect(compareBuildVersions("2026.08.14.85068", "2026.08.14.81160")).toBe(1);
  });

  it("orders across days and years", () => {
    expect(compareBuildVersions("2026.08.14.85068", "2026.08.15.00005")).toBe(-1);
    expect(compareBuildVersions("2025.12.31.86399", "2026.01.01.00000")).toBe(-1);
  });

  it("treats an identical stamp as equal, tag prefix or not", () => {
    expect(compareBuildVersions("2026.08.14.81160", "2026.08.14.81160")).toBe(0);
    expect(compareBuildVersions("v2026.08.14.81160", "2026.08.14.81160")).toBe(0);
  });

  it("returns null when either side is not a build stamp", () => {
    // The update check reads null as "no update known". Answering 1 here would
    // offer an install that could be a downgrade.
    expect(compareBuildVersions("2026.08.14.81160", "v0.1.0")).toBeNull();
    expect(compareBuildVersions("v0.1.0", "2026.08.14.81160")).toBeNull();
    expect(compareBuildVersions("", "")).toBeNull();
  });

  it("does not fall for the unpadded lexicographic trap", () => {
    // "2026.8.4.5" < "2026.08.14.81160" is false as strings; a raw string
    // compare would call the stale build the newer one.
    expect(compareBuildVersions("2026.8.4.5", "2026.08.14.81160")).toBeNull();
  });
});
