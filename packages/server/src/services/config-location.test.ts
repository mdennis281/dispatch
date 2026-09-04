/**
 * Tests for the config-dir precedence chain.
 *
 * This is the one place that decides whether Dispatch writes into somebody's
 * working tree, so each rung gets its own case — especially the back-compat one.
 * A repo that has committed a `.dispatch/` must keep using it no matter what the
 * app-wide default says: getting that wrong strands every instruction and memory
 * in that directory, silently, on upgrade.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@dispatch/shared";
import { resolveConfigDir, resolvePlacementDir, findRepoConfigDir } from "./config-location.js";

let repo: string;
let external: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "cm-loc-repo-"));
  external = await mkdtemp(join(tmpdir(), "cm-loc-ext-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(external, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  name: "P",
  repoPath: repo,
  worktreeRoot: "",
  subApps: [],
  createdAt: 1,
  ...over,
});

/** Write a manifest into `dir`, creating it. */
async function seedManifest(dir: string, body = "name: Seeded\n"): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "project.yaml"), body, "utf8");
}

describe("findRepoConfigDir", () => {
  it("is null for a repo with no manifest — an empty dir does not count", async () => {
    await mkdir(join(repo, ".dispatch"), { recursive: true });
    expect(findRepoConfigDir(repo)).toBeNull();
  });

  it("finds the current dir name", async () => {
    await seedManifest(join(repo, ".dispatch"));
    expect(findRepoConfigDir(repo)).toBe(join(repo, ".dispatch"));
  });

  it("still finds a pre-rename .claude-manager/", async () => {
    await seedManifest(join(repo, ".claude-manager"));
    expect(findRepoConfigDir(repo)).toBe(join(repo, ".claude-manager"));
  });

  it("prefers .dispatch/ when a checkout carries both", async () => {
    await seedManifest(join(repo, ".claude-manager"), "name: Old\n");
    await seedManifest(join(repo, ".dispatch"), "name: New\n");
    expect(findRepoConfigDir(repo)).toBe(join(repo, ".dispatch"));
  });
});

describe("resolveConfigDir", () => {
  it("defaults to the external dir when nothing exists anywhere", () => {
    const r = resolveConfigDir(project(), external);
    expect(r).toEqual({ dir: external, location: "external", exists: false });
  });

  it("uses a COMMITTED .dispatch/ over the external default", async () => {
    await seedManifest(join(repo, ".dispatch"));
    const r = resolveConfigDir(project(), external);
    expect(r).toEqual({ dir: join(repo, ".dispatch"), location: "repo", exists: true });
  });

  it("uses the external dir once it holds a manifest", async () => {
    await seedManifest(external);
    const r = resolveConfigDir(project(), external);
    expect(r).toEqual({ dir: external, location: "external", exists: true });
  });

  it("prefers the repo when BOTH exist — the committed one is the deliberate one", async () => {
    await seedManifest(join(repo, ".dispatch"));
    await seedManifest(external);
    expect(resolveConfigDir(project(), external).location).toBe("repo");
  });

  it("an explicit override wins over a config dir that exists", async () => {
    await seedManifest(join(repo, ".dispatch"));
    await seedManifest(external);
    // This is what MOVING a project means: the override has to outrank the
    // evidence, or a repo that ever committed a `.dispatch/` could never leave.
    const r = resolveConfigDir(project({ configLocation: "external" }), external);
    expect(r).toEqual({ dir: external, location: "external", exists: true });
  });

  it("an override to repo points at the repo even before the dir is there", () => {
    const r = resolveConfigDir(project({ configLocation: "repo" }), external);
    expect(r).toEqual({ dir: join(repo, ".dispatch"), location: "repo", exists: false });
  });
});

describe("resolvePlacementDir", () => {
  it("places a brand-new config externally by default", () => {
    expect(resolvePlacementDir(project(), external, undefined)).toEqual({
      dir: external,
      location: "external",
      exists: false,
    });
  });

  it("places it in the repo when the app default says repo", () => {
    expect(resolvePlacementDir(project(), external, "repo")).toEqual({
      dir: join(repo, ".dispatch"),
      location: "repo",
      exists: false,
    });
  });

  it("never relocates a config dir that already exists", async () => {
    await seedManifest(join(repo, ".dispatch"));
    // The app default disagrees with where this project's config already is, and
    // loses: a placement decision is only ever made once, for the first dir.
    const r = resolvePlacementDir(project(), external, "external");
    expect(r).toEqual({ dir: join(repo, ".dispatch"), location: "repo", exists: true });
  });

  it("honours a per-project override over the app default", () => {
    const r = resolvePlacementDir(project({ configLocation: "repo" }), external, "external");
    expect(r.location).toBe("repo");
  });
});
