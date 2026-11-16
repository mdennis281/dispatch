import { describe, expect, it } from "vitest";
import { cacheRole, surveyWebStorage, webStorageBytes } from "./browserStorage.js";
import { dirtyAppSections } from "../stores/settingsDraft.js";
import type { AppSettings } from "./api.js";

function fakeStorage(entries: Record<string, string>) {
  const keys = Object.keys(entries);
  return {
    length: keys.length,
    key: (i: number) => keys[i] ?? null,
    getItem: (k: string) => entries[k] ?? null,
  };
}

describe("surveyWebStorage", () => {
  it("counts UTF-16 code units, largest key first", () => {
    const s = surveyWebStorage(fakeStorage({ a: "x", big: "y".repeat(100) }));
    expect(s.available).toBe(true);
    expect(s.keys.map((k) => k.key)).toEqual(["big", "a"]);
    // The browser's ~5 MB cap is in code units, so 2 bytes each.
    expect(s.keys[0]!.bytes).toBe(webStorageBytes("big", "y".repeat(100)));
    expect(s.bytes).toBe((3 + 100) * 2 + (1 + 1) * 2);
  });

  it("reports blocked storage as unavailable rather than throwing", () => {
    expect(surveyWebStorage(null)).toEqual({ available: false, bytes: 0, keys: [] });
    const throwing = {
      get length(): number {
        throw new DOMException("blocked", "SecurityError");
      },
      key: () => null,
      getItem: () => null,
    };
    expect(surveyWebStorage(throwing).available).toBe(false);
  });
});

describe("cacheRole", () => {
  it("recognises any shell version, and never offers the push id as the shell", () => {
    expect(cacheRole("dispatch-shell-v3")).toBe("shell");
    expect(cacheRole("dispatch-shell-v9")).toBe("shell");
    expect(cacheRole("dispatch-push-device")).toBe("push");
    expect(cacheRole("workbox-precache")).toBe("other");
  });
});

describe("dirtyAppSections — retention vs storage", () => {
  const base = { theme: "dark", retention: { toolImageDays: 3 } } as AppSettings;
  it("puts the cache budgets' dot on Browser storage, not Retention", () => {
    const draft = { ...base, retention: { ...base.retention, artifactCacheMb: 100 } } as AppSettings;
    expect([...dirtyAppSections({ saved: base, draft })]).toEqual(["storage"]);
  });
  it("and a deletion window's on Retention", () => {
    const draft = { ...base, retention: { toolImageDays: 9 } } as AppSettings;
    expect([...dirtyAppSections({ saved: base, draft })]).toEqual(["retention"]);
  });
});
