import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Project } from "@dispatch/shared";

/** In-memory Storage stand-in — the node test env has no localStorage. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

// Installed before the import only for tidiness: the store reads storage lazily,
// inside `hydrate` / `setActiveProject`, so nothing is captured at module load.
globalThis.localStorage = memoryStorage();

const { useProjects } = await import("./projects.js");

const KEY = "cm:last-project";

function project(id: string): Project {
  return {
    id,
    name: `Project ${id}`,
    repoPath: `/repos/${id}`,
    worktreeRoot: `/repos/${id}/.worktrees`,
    subApps: [],
    createdAt: 1,
  };
}

function hydrate(projects: Project[]): void {
  useProjects.getState().hydrate({ projects, agents: [], modes: [] });
}

const THREE = [project("p1"), project("p2"), project("p3")];

beforeEach(() => {
  localStorage.clear();
  useProjects.setState({ projects: [], agents: [], modes: [], activeProjectId: null });
});

describe("last-project memory", () => {
  it("opens on the first project when nothing is remembered", () => {
    hydrate(THREE);
    expect(useProjects.getState().activeProjectId).toBe("p1");
    // …and starts remembering from there, rather than staying blank until the
    // user's first manual switch.
    expect(localStorage.getItem(KEY)).toBe("p1");
  });

  it("re-opens the remembered project on the next hydrate", () => {
    hydrate(THREE);
    useProjects.getState().setActiveProject("p3");
    expect(localStorage.getItem(KEY)).toBe("p3");

    // A refresh: fresh store, same browser storage.
    useProjects.setState({ projects: [], agents: [], modes: [], activeProjectId: null });
    hydrate(THREE);
    expect(useProjects.getState().activeProjectId).toBe("p3");
  });

  it("survives the list coming back in a different order", () => {
    localStorage.setItem(KEY, "p2");
    hydrate([project("p3"), project("p2"), project("p1")]);
    expect(useProjects.getState().activeProjectId).toBe("p2");
  });

  it("falls back to the first project when the remembered one is gone", () => {
    localStorage.setItem(KEY, "deleted");
    hydrate(THREE);
    expect(useProjects.getState().activeProjectId).toBe("p1");
    // The stale entry is replaced, not left to be re-checked every load.
    expect(localStorage.getItem(KEY)).toBe("p1");
  });

  it("keeps the remembered project when the roster comes back empty", () => {
    localStorage.setItem(KEY, "p2");
    hydrate([]);
    expect(useProjects.getState().activeProjectId).toBeNull();
    // An empty roster is not evidence that p2 is gone — forgetting here would
    // lose it for good.
    expect(localStorage.getItem(KEY)).toBe("p2");
    hydrate(THREE);
    expect(useProjects.getState().activeProjectId).toBe("p2");
  });
});

describe("without usable storage", () => {
  const real = globalThis.localStorage;
  afterEach(() => {
    // `defineProperty`, not assignment: the throwing case below installs a
    // getter-only property, and assigning over one of those throws in strict
    // mode — which every ESM module is.
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: real,
    });
  });

  it("still hydrates when localStorage is absent", () => {
    // @ts-expect-error — deleting the global is the point of the test.
    delete globalThis.localStorage;
    expect(() => hydrate(THREE)).not.toThrow();
    expect(useProjects.getState().activeProjectId).toBe("p1");
    expect(() => useProjects.getState().setActiveProject("p2")).not.toThrow();
    expect(useProjects.getState().activeProjectId).toBe("p2");
  });

  it("still hydrates when localStorage throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked by cookie policy");
      },
    });
    expect(() => hydrate(THREE)).not.toThrow();
    expect(useProjects.getState().activeProjectId).toBe("p1");
  });
});
