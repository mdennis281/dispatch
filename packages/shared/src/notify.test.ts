import { describe, it, expect } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFS,
  NotificationPrefsSchema,
  inQuietHours,
  shouldNotify,
  type NotificationPrefs,
} from "./notify.js";

const at = (iso: string) => new Date(iso).getTime();

function prefs(p: Partial<NotificationPrefs> = {}): NotificationPrefs {
  return { ...DEFAULT_NOTIFICATION_PREFS, ...p };
}

describe("shouldNotify", () => {
  it("passes everything with default prefs", () => {
    for (const kind of ["permission", "question", "idle", "done", "review"] as const) {
      expect(shouldNotify(prefs(), { kind }, 0)).toBe(true);
    }
  });

  it("respects the master switch", () => {
    expect(shouldNotify(prefs({ enabled: false }), { kind: "permission" }, 0)).toBe(false);
  });

  it("mutes one kind without touching the others", () => {
    const p = prefs({ kinds: { done: false } });
    expect(shouldNotify(p, { kind: "done" }, 0)).toBe(false);
    expect(shouldNotify(p, { kind: "permission" }, 0)).toBe(true);
  });

  it("treats an unset kind as allowed, so a new kind is never born muted", () => {
    // `kinds: {}` is what every device that stored prefs before `review` existed
    // has on disk.
    expect(shouldNotify(prefs({ kinds: {} }), { kind: "review" }, 0)).toBe(true);
  });

  it("filters review items by sub-kind", () => {
    const p = prefs({ reviewKinds: { comment: false } });
    expect(shouldNotify(p, { kind: "review", reviewKinds: ["comment"] }, 0)).toBe(false);
    expect(shouldNotify(p, { kind: "review", reviewKinds: ["check"] }, 0)).toBe(true);
  });

  it("keeps a bundled round when ANY of its reasons is still wanted", () => {
    // The failure this prevents: one poll finds a red check AND a nit; muting
    // nits must not swallow the check.
    const p = prefs({ reviewKinds: { comment: false } });
    expect(shouldNotify(p, { kind: "review", reviewKinds: ["comment", "check"] }, 0)).toBe(true);
  });

  it("lets an untagged review item through — it isn't filterable", () => {
    const p = prefs({ reviewKinds: { comment: false, check: false, review: false, settled: false } });
    expect(shouldNotify(p, { kind: "review" }, 0)).toBe(true);
  });

  it("sub-kind filters do not apply to non-review kinds", () => {
    const p = prefs({ reviewKinds: { check: false } });
    expect(shouldNotify(p, { kind: "done", reviewKinds: ["check"] }, 0)).toBe(true);
  });
});

describe("inQuietHours", () => {
  const quiet = (over: Partial<NonNullable<NotificationPrefs["quietHours"]>> = {}) =>
    prefs({
      quietHours: { enabled: true, start: "22:00", end: "07:00", tz: "UTC", ...over },
    });

  it("is off unless enabled", () => {
    expect(inQuietHours(quiet({ enabled: false }), at("2026-08-18T23:00:00Z"))).toBe(false);
  });

  it("covers a window that wraps midnight, on both sides", () => {
    expect(inQuietHours(quiet(), at("2026-08-18T23:30:00Z"))).toBe(true);
    expect(inQuietHours(quiet(), at("2026-08-18T03:00:00Z"))).toBe(true);
    expect(inQuietHours(quiet(), at("2026-08-18T12:00:00Z"))).toBe(false);
  });

  it("is inclusive of start and exclusive of end", () => {
    expect(inQuietHours(quiet(), at("2026-08-18T22:00:00Z"))).toBe(true);
    expect(inQuietHours(quiet(), at("2026-08-18T07:00:00Z"))).toBe(false);
  });

  it("handles a same-day window", () => {
    const p = quiet({ start: "09:00", end: "17:00" });
    expect(inQuietHours(p, at("2026-08-18T12:00:00Z"))).toBe(true);
    expect(inQuietHours(p, at("2026-08-18T20:00:00Z"))).toBe(false);
  });

  it("treats start === end as an EMPTY window, not a silent day", () => {
    expect(inQuietHours(quiet({ start: "08:00", end: "08:00" }), at("2026-08-18T08:30:00Z"))).toBe(
      false,
    );
  });

  it("evaluates in the device's zone, not the server's", () => {
    // 23:00 UTC is 19:00 in New York (EDT): inside a 22:00–07:00 window on the
    // server's clock, well outside it on the device's. Evaluating in the wrong
    // zone silences four hours of the wrong evening.
    const utc = quiet();
    const ny = quiet({ tz: "America/New_York" });
    expect(inQuietHours(utc, at("2026-08-18T23:00:00Z"))).toBe(true);
    expect(inQuietHours(ny, at("2026-08-18T23:00:00Z"))).toBe(false);
  });

  it("fails open on an unknown zone rather than silencing everything", () => {
    expect(inQuietHours(quiet({ tz: "Mars/Olympus" }), at("2026-08-18T23:00:00Z"))).toBe(false);
  });

  it("suppresses an otherwise-wanted item", () => {
    expect(shouldNotify(quiet(), { kind: "permission" }, at("2026-08-18T23:00:00Z"))).toBe(false);
    expect(shouldNotify(quiet(), { kind: "permission" }, at("2026-08-18T12:00:00Z"))).toBe(true);
  });
});

describe("NotificationPrefsSchema", () => {
  it("accepts an empty object and fills the defaults", () => {
    const parsed = NotificationPrefsSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(shouldNotify(parsed, { kind: "review" }, 0)).toBe(true);
  });

  it("rejects a malformed time", () => {
    const bad = NotificationPrefsSchema.safeParse({
      quietHours: { enabled: true, start: "25:00", end: "07:00", tz: "UTC" },
    });
    expect(bad.success).toBe(false);
  });
});
