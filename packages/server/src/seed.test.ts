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
  it("seeds modes, agents, and the Hivebreak project into an empty store", async () => {
    expect(await seedDefaultsIfEmpty(store)).toBe(true);

    const modes = await store.listModes();
    expect(modes.map((m) => m.id).sort()).toEqual(["auto", "edit", "plan"]);

    const agents = await store.listAgents();
    expect(agents.map((a) => a.id)).toContain("build");

    const projects = await store.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe("hivebreak");
    expect(projects[0].subApps.map((s) => s.id)).toContain("metrics-server");
  });

  it("is idempotent — a second run is a no-op", async () => {
    expect(await seedDefaultsIfEmpty(store)).toBe(true);
    expect(await seedDefaultsIfEmpty(store)).toBe(false);
    expect(await store.listProjects()).toHaveLength(1);
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
