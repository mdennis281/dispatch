import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import { resolveWorkflow, type Project } from "@dispatch/shared";
import { ProjectConfigService } from "./project-config.js";
import { isManifestBacked, saveProjectWorkflow } from "./workflow-writer.js";

let dataDir: string;
let repoDir: string;
let store: Store;
let bus: EventBus;
let projectConfig: ProjectConfigService;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cm-wfw-data-"));
  repoDir = await mkdtemp(join(tmpdir(), "cm-wfw-repo-"));
  store = new Store(dataDir);
  await store.init();
  bus = new EventBus();
  projectConfig = new ProjectConfigService({ store, bus });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function seedProject(over: Partial<Project> = {}): Promise<Project> {
  return store.saveProject({
    id: "p1",
    name: "Seed",
    repoPath: repoDir,
    worktreeRoot: join(repoDir, "..", "wt"),
    defaultBranch: "main",
    subApps: [],
    createdAt: 1,
    ...over,
  });
}

async function writeManifest(body: string): Promise<string> {
  const dir = join(repoDir, ".dispatch");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "project.yaml");
  await writeFile(path, body, "utf8");
  return path;
}

const deps = () => ({ store, projectConfig });

describe("workflow-writer", () => {
  it("saves to the store when the repo has no manifest", async () => {
    await seedProject();
    const out = await saveProjectWorkflow(deps(), "p1", {
      profile: "review",
      autoMerge: "on-green",
    });

    expect(out?.target).toBe("store");
    expect(resolveWorkflow(await store.getProject("p1"))).toMatchObject({
      profile: "review",
      autoMerge: "on-green",
    });
  });

  it("writes into project.yaml when the repo has one", async () => {
    await writeManifest("name: Seed\n");
    await seedProject();

    const out = await saveProjectWorkflow(deps(), "p1", {
      profile: "review",
      autoMerge: "on-green",
      mergeMethod: "rebase",
    });

    expect(out?.target).toBe("manifest");
    const yaml = await readFile(join(repoDir, ".dispatch", "project.yaml"), "utf8");
    expect(yaml).toMatch(/profile: review/);
    expect(yaml).toMatch(/autoMerge: on-green/);
    expect(yaml).toMatch(/mergeMethod: rebase/);
  });

  it("survives a config reload — the regression that read as 'it didn't save'", async () => {
    // Writing a manifest-backed project to `.data` used to be reverted by the
    // next reload, because the manifest's workflow block overrides the record.
    await writeManifest("name: Seed\n");
    await seedProject();

    await saveProjectWorkflow(deps(), "p1", { profile: "review", autoMerge: "on-green" });
    await projectConfig.reload("p1");

    expect(resolveWorkflow(await store.getProject("p1"))).toMatchObject({
      profile: "review",
      autoMerge: "on-green",
    });
  });

  it("preserves comments, key order and unrelated keys in a hand-authored manifest", async () => {
    await writeManifest(
      [
        "# How this repo works",
        "name: Seed",
        "ship: pnpm ship",
        "workflow:",
        "  # keep the guard loud",
        "  profile: review",
        "  guard: deny",
        "subApps:",
        "  - id: web",
        "    name: Web",
        "    cwd: apps/web",
        "",
      ].join("\n"),
    );
    await seedProject();

    await saveProjectWorkflow(deps(), "p1", {
      profile: "review",
      guard: "warn",
      autoMerge: "on-green",
    });

    const yaml = await readFile(join(repoDir, ".dispatch", "project.yaml"), "utf8");
    expect(yaml).toContain("# How this repo works");
    expect(yaml).toContain("# keep the guard loud");
    expect(yaml).toContain("ship: pnpm ship");
    expect(yaml).toContain("- id: web");
    expect(yaml).toMatch(/guard: warn/);
    expect(yaml).not.toMatch(/guard: deny/);
  });

  it("removes a key the caller cleared rather than leaving the old value", async () => {
    await writeManifest("name: Seed\nworkflow:\n  profile: review\n  autoMerge: on-green\n");
    await seedProject();

    await saveProjectWorkflow(deps(), "p1", { profile: "review" });

    const yaml = await readFile(join(repoDir, ".dispatch", "project.yaml"), "utf8");
    expect(yaml).not.toContain("autoMerge");
  });

  it("refuses to write an invalid block instead of corrupting the manifest", async () => {
    await writeManifest("name: Seed\nworkflow:\n  profile: review\n");
    await seedProject();

    await expect(
      // `profile` is the one required field — an empty block must not land.
      saveProjectWorkflow(deps(), "p1", {} as never),
    ).rejects.toThrow();
    const yaml = await readFile(join(repoDir, ".dispatch", "project.yaml"), "utf8");
    expect(yaml).toContain("profile: review");
  });

  it("reports a missing project as null rather than throwing", async () => {
    expect(await saveProjectWorkflow(deps(), "nope", { profile: "none" })).toBeNull();
  });

  it("isManifestBacked reflects whether project.yaml exists", async () => {
    const p = await seedProject();
    expect(isManifestBacked(p)).toBe(false);
    await writeManifest("name: Seed\n");
    expect(isManifestBacked(p)).toBe(true);
  });
});
