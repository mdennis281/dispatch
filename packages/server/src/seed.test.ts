/**
 * seedDefaultsIfEmpty — seeds an empty dataDir once, no-ops thereafter.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store/index.js";
import { seedDefaultsIfEmpty } from "./seed.js";

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-seed-"));
  store = new Store(dir);
  await store.init();
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("seedDefaultsIfEmpty", () => {
  it("seeds modes and agents into an empty store", async () => {
    expect(await seedDefaultsIfEmpty(store)).toBe(true);

    const modes = await store.listModes();
    expect(modes.map((m) => m.id).sort()).toEqual(["auto", "edit", "plan"]);

    const agents = await store.listAgents();
    expect(agents.map((a) => a.id).sort()).toEqual(["build", "reviewer"]);
    // Nothing seeded may name a project: every agent here is global, because a
    // project-scoped one would be scoped to a project that no longer exists.
    expect(agents.every((a) => a.scope === "global")).toBe(true);
  });

  /**
   * The regression this file exists for. A seeded example project ("Hivebreak")
   * pointed at `C:/Users/Michael/projects/zombie` — a path on exactly one
   * machine — so every new install opened onto an unreadable project it had
   * never heard of. A first project is made through the setup wizard now.
   */
  it("seeds NO project", async () => {
    expect(await seedDefaultsIfEmpty(store)).toBe(true);
    expect(await store.listProjects()).toEqual([]);
  });

  it("is idempotent — a second run is a no-op", async () => {
    expect(await seedDefaultsIfEmpty(store)).toBe(true);
    const before = (await store.listAgents()).length;
    expect(await seedDefaultsIfEmpty(store)).toBe(false);
    expect(await store.listAgents()).toHaveLength(before);
  });

  it("skips when the store already has a project", async () => {
    await store.saveProject({
      id: "other",
      name: "Other",
      repoPath: dir,
      worktreeRoot: "wt",
      subApps: [],
      createdAt: Date.now(),
    });
    expect(await seedDefaultsIfEmpty(store)).toBe(false);
    expect(await store.listModes()).toHaveLength(0);
  });
});
