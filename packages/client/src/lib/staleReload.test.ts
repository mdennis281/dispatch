import { describe, expect, it } from "vitest";
import { MAX_STALE_RELOADS, planStaleReload } from "./staleReload.js";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}

const OLD = "2026.10.22.20126";
const NEW = "2026.10.22.57489";

describe("planStaleReload", () => {
  it("does nothing when the builds agree", () => {
    expect(planStaleReload(NEW, NEW, memoryStorage())).toBe("none");
  });

  it("does nothing for a source checkout, which reports no version", () => {
    expect(planStaleReload("dev", undefined, memoryStorage())).toBe("none");
  });

  it("reloads, then hard-reloads, then gives up — never a loop", () => {
    const s = memoryStorage();
    expect(planStaleReload(OLD, NEW, s)).toBe("reload");
    expect(planStaleReload(OLD, NEW, s)).toBe("hard-reload");
    for (let i = 0; i < 5; i++) expect(planStaleReload(OLD, NEW, s)).toBe("none");
    expect(MAX_STALE_RELOADS).toBe(2);
  });

  it("gives a newer server version a fresh budget", () => {
    const s = memoryStorage();
    planStaleReload(OLD, NEW, s);
    planStaleReload(OLD, NEW, s);
    expect(planStaleReload(OLD, "2026.10.23.00001", s)).toBe("reload");
  });

  it("forgets the attempts once a reload lands on the matching build", () => {
    const s = memoryStorage();
    planStaleReload(OLD, NEW, s);
    planStaleReload(NEW, NEW, s);
    // The next upgrade, served to the now-current tab, starts from scratch.
    expect(planStaleReload(NEW, "2026.10.23.00001", s)).toBe("reload");
  });

  it("refuses to reload when it cannot record the attempt", () => {
    // An unwritable store would come back from every reload with no memory of
    // having tried — that is exactly the loop the budget exists to prevent.
    const s = memoryStorage();
    s.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(planStaleReload(OLD, NEW, s)).toBe("none");
    expect(planStaleReload(OLD, NEW, undefined)).toBe("none");
  });
});
