import { describe, expect, it } from "vitest";
import { formatLocalTime, isoLocalTime } from "./local-time.js";

describe("local time", () => {
  // 2026-10-29 19:03:12Z — CDT (UTC-5) on that date; CST (UTC-6) a week later.
  const summer = Date.UTC(2026, 9, 29, 19, 3, 12);
  const winter = Date.UTC(2026, 10, 5, 19, 3, 12);

  it("labels the zone in the human string, across a DST change", () => {
    expect(formatLocalTime(summer, "America/Chicago")).toBe("2026-10-29 14:03:12 CDT");
    expect(formatLocalTime(winter, "America/Chicago")).toBe("2026-11-05 13:03:12 CST");
  });

  it("renders ISO with the zone's offset, never a Z-shifted instant", () => {
    expect(isoLocalTime(summer, "America/Chicago")).toBe("2026-10-29T14:03:12-05:00");
    expect(isoLocalTime(winter, "America/Chicago")).toBe("2026-11-05T13:03:12-06:00");
    expect(isoLocalTime(summer, "UTC")).toBe("2026-10-29T19:03:12+00:00");
    expect(Date.parse(isoLocalTime(summer, "America/Chicago"))).toBe(summer);
  });
});
