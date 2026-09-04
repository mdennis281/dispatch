import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import { resolveWorkflow, type Project } from "@dispatch/shared";
import { ProjectConfigService } from "./project-config.js";
import {
  isManifestBacked,
  saveProjectShellFilter,
  saveProjectWorkflow,
} from "./workflow-writer.js";

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
  store.close();
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

  it("overwrites a key the caller sent, without touching one it didn't", async () => {
    await writeManifest(
      "name: Seed\nworkflow:\n  profile: review\n  autoMerge: on-green\n  guard: deny\n",
    );
    await seedProject();

    await saveProjectWorkflow(deps(), "p1", { profile: "review", autoMerge: "off" });

    const yaml = await readFile(join(repoDir, ".dispatch", "project.yaml"), "utf8");
    expect(yaml).toContain("autoMerge: off");
    expect(yaml).not.toContain("on-green");
    // Absent ≠ "delete it" — see `saveProjectWorkflow`'s docblock.
    expect(yaml).toContain("guard: deny");
  });

  /**
   * The regression that turned this writer from a replace into a merge.
   *
   * `workflow.pr` is authored from a DIFFERENT settings pane than the rest of
   * the block, and `pr.requireReview` / `requireChecks` / `draft` have no editor
   * anywhere. So when the Workflow pane saved a block that — correctly, for it —
   * said nothing about `pr`, the entire `pr:` node was deleted out of a
   * COMMITTED file: reviewers, review requirements and the reviewer agent, gone
   * silently, with no UI able to put any of it back.
   */
  it("leaves an authored pr block alone when the caller only touches the workflow section", async () => {
    await writeManifest(
      [
        "name: Seed",
        "workflow:",
        "  profile: review",
        "  pr:",
        "    reviewers:",
        "      - copilot-pull-request-reviewer[bot]",
        "    requireReview: true",
        "    requireChecks: true",
        "    reviewAgent:",
        "      enabled: true",
        "      identity: dedicated",
        "",
      ].join("\n"),
    );
    await seedProject();

    await saveProjectWorkflow(deps(), "p1", { profile: "review", guard: "warn" });

    const yaml = await readFile(join(repoDir, ".dispatch", "project.yaml"), "utf8");
    expect(yaml).toContain("guard: warn");
    expect(yaml).toContain("- copilot-pull-request-reviewer[bot]");
    expect(yaml).toContain("requireReview: true");
    expect(yaml).toContain("requireChecks: true");
    expect(resolveWorkflow(await store.getProject("p1")).pr.reviewAgent).toMatchObject({
      enabled: true,
      identity: "dedicated",
    });
  });

  it("makes the same promise to a project with no manifest", async () => {
    await seedProject({
      workflow: {
        profile: "review",
        pr: { reviewers: ["someone"], reviewAgent: { enabled: true } },
      },
    });

    await saveProjectWorkflow(deps(), "p1", { profile: "review", guard: "warn" });

    expect(resolveWorkflow(await store.getProject("p1"))).toMatchObject({
      guard: "warn",
      pr: { reviewers: ["someone"], reviewAgent: { enabled: true } },
    });
  });

  it("merges INTO a nested block rather than replacing the whole node", async () => {
    await writeManifest(
      "name: Seed\nworkflow:\n  profile: review\n  pr:\n    requireChecks: true\n",
    );
    await seedProject();

    // What the Reviewer pane sends: a `pr` block holding only the half it owns.
    await saveProjectWorkflow(deps(), "p1", {
      profile: "review",
      pr: { reviewAgent: { enabled: true } },
    });

    const yaml = await readFile(join(repoDir, ".dispatch", "project.yaml"), "utf8");
    expect(yaml).toContain("requireChecks: true");
    expect(yaml).toContain("enabled: true");
  });

  it("writes an empty reviewer list as the decision it is, not as an unset key", async () => {
    await writeManifest("name: Seed\nworkflow:\n  profile: review\n");
    await seedProject();

    await saveProjectWorkflow(deps(), "p1", { profile: "review", pr: { reviewers: [] } });

    // `resolveWorkflow` reads `[]` as "ask nobody" rather than falling back to
    // the profile's Copilot default — the write has to preserve that distinction.
    expect(resolveWorkflow(await store.getProject("p1")).pr.reviewers).toEqual([]);
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
    const external = store.projectConfigDir(p.id);
    expect(isManifestBacked(p, external)).toBe(false);
    await writeManifest("name: Seed\n");
    expect(isManifestBacked(p, external)).toBe(true);
  });

  it("isManifestBacked sees a manifest that lives OUTSIDE the repo", async () => {
    // The case the repo-relative walk-up used to miss entirely: config in the
    // install's own dir, and a `.data` write that a manifest nothing looked
    // for would silently override on the next load.
    const p = await seedProject({ configLocation: "external" });
    const external = store.projectConfigDir(p.id);
    expect(isManifestBacked(p, external)).toBe(false);
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "project.yaml"), "name: Seed\n", "utf8");
    expect(isManifestBacked(p, external)).toBe(true);
  });

  it("stores a shell filter on projects without a manifest and can reset it", async () => {
    await seedProject();
    await saveProjectShellFilter(deps(), "p1", ["shell", "memory"]);
    expect((await store.getProject("p1"))?.shellFilter).toEqual(["shell", "memory"]);

    await saveProjectShellFilter(deps(), "p1", undefined);
    expect((await store.getProject("p1"))?.shellFilter).toBeUndefined();
  });

  it("writes and removes the manifest shell filter without leaving a stale project override", async () => {
    await writeManifest("name: Seed\ndefaults:\n  model: test-model\n");
    await seedProject({ shellFilter: ["memory"] });

    await saveProjectShellFilter(deps(), "p1", ["shell", "wait"]);
    let yaml = await readFile(join(repoDir, ".dispatch", "project.yaml"), "utf8");
    expect(yaml).toContain("shellFilter:");
    expect(yaml).toContain("- wait");
    expect((await store.getProject("p1"))?.shellFilter).toEqual(["shell", "wait"]);

    await saveProjectShellFilter(deps(), "p1", undefined);
    yaml = await readFile(join(repoDir, ".dispatch", "project.yaml"), "utf8");
    expect(yaml).not.toContain("shellFilter");
    expect(yaml).toContain("model: test-model");
    expect((await store.getProject("p1"))?.shellFilter).toBeUndefined();
  });
});
