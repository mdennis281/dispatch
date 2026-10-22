import { describe, expect, it } from "vitest";
import { migrateStorageKeys, renamedKey } from "./storageKeyMigration.js";

/** Just enough of `Storage` for the migration — the client suite runs in node. */
function memoryStorage(init: Record<string, string>): Storage {
  const map = new Map(Object.entries(init));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe("storage key migration", () => {
  it("maps both old prefixes to dispatch:", () => {
    expect(renamedKey("cm:draft:abc")).toBe("dispatch:draft:abc");
    expect(renamedKey("cm.workspace.view")).toBe("dispatch:workspace.view");
    expect(renamedKey("dispatch:theme")).toBeNull();
    expect(renamedKey("cmx:other")).toBeNull();
  });

  it("moves every old key, keeps unrelated ones, and runs once", () => {
    const store = memoryStorage({
      "cm:draft:c1": "unsent text",
      "cm:last-project": "p1",
      "cm.workspace.view": "grid",
      "dispatch:theme": "dark",
      "other-app": "x",
    });
    expect(migrateStorageKeys(store)).toBe(3);
    expect(store.getItem("dispatch:draft:c1")).toBe("unsent text");
    expect(store.getItem("dispatch:last-project")).toBe("p1");
    expect(store.getItem("dispatch:workspace.view")).toBe("grid");
    expect(store.getItem("cm:draft:c1")).toBeNull();
    expect(store.getItem("other-app")).toBe("x");
    expect(store.getItem("dispatch:theme")).toBe("dark");
    expect(migrateStorageKeys(store)).toBe(0);
  });

  it("never overwrites a value the new build already wrote", () => {
    const store = memoryStorage({ "cm:last-project": "old", "dispatch:last-project": "new" });
    migrateStorageKeys(store);
    expect(store.getItem("dispatch:last-project")).toBe("new");
    expect(store.getItem("cm:last-project")).toBeNull();
  });

  it("tolerates missing or throwing storage", () => {
    expect(migrateStorageKeys(undefined)).toBe(0);
    const broken = memoryStorage({ "cm:a": "1" });
    broken.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => migrateStorageKeys(broken)).not.toThrow();
  });
});
