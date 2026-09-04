import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import type { Project } from "@dispatch/shared";
import { ProjectConfigService } from "./project-config.js";
import {
  ProjectConfigArchive,
  projectToManifest,
  renderManifestYaml,
  buildScaffoldEntries,
  safeArchivePath,
  mcpConfigToTransport,
} from "./project-config-archive.js";
import { unzipSync } from "./zip.js";

let dataDir: string;
let repoDir: string;
let store: Store;
let bus: EventBus;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cm-arch-data-"));
  repoDir = await mkdtemp(join(tmpdir(), "cm-arch-repo-"));
  store = new Store(dataDir);
  await store.init();
  bus = new EventBus();
});
afterEach(async () => {
  store.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function seedProject(over: Partial<Project> = {}): Promise<Project> {
  const project: Project = {
    id: "hivebreak",
    name: "Hivebreak",
    repoPath: repoDir,
    worktreeRoot: "C:/wt",
    worktreeCmd: "pnpm worktree",
    shipCmd: "pnpm ship",
    defaultBranch: "main",
    subApps: [
      { id: "game", name: "game", path: "apps/client", dev: "pnpm dev", ports: [5173], url: "http://localhost:{port}" },
      { id: "metrics", name: "metrics", path: "services/metrics", dev: "docker compose up", dockerCompose: "docker-compose.yml", ports: [8080] },
    ],
    createdAt: 1,
    ...over,
  };
  return store.saveProject(project);
}

/** Write a `.data` memory file for the project. */
async function seedMemory(name: string, content: string): Promise<void> {
  const dir = store.projectMemoryDir("hivebreak");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), content, "utf8");
}

function makeArchive(): { archive: ProjectConfigArchive; svc: ProjectConfigService } {
  // A watch factory that never spawns a real watcher (deterministic tests).
  const svc = new ProjectConfigService({ store, bus, watch: () => null });
  const archive = new ProjectConfigArchive({ store, projectConfig: svc });
  return { archive, svc };
}

/* ------------------------------------------------------------- pure mapping */

describe("archive — pure mapping helpers", () => {
  it("projectToManifest is the inverse of the loader mapping", () => {
    const manifest = projectToManifest({
      id: "p",
      name: "Hivebreak",
      repoPath: "/repo",
      worktreeRoot: "C:/wt",
      worktreeCmd: "pnpm worktree",
      shipCmd: "pnpm ship",
      subApps: [
        { id: "game", name: "game", path: "apps/client", dev: "pnpm dev", ports: [5173] },
        { id: "m", name: "m", path: "services/m", dockerCompose: "docker-compose.yml" },
      ],
      mcpServers: { chrome: { type: "stdio", command: "npx", args: ["-y", "x"] } },
      defaultBranch: "main",
      createdAt: 1,
    });
    expect(manifest.name).toBe("Hivebreak");
    expect(manifest.worktree).toBe("pnpm worktree");
    expect(manifest.ship).toBe("pnpm ship");
    // subApp path→cwd, dockerCompose→docker.
    expect(manifest.subApps?.[0]).toMatchObject({ id: "game", cwd: "apps/client", dev: "pnpm dev" });
    expect(manifest.subApps?.[1]).toMatchObject({ id: "m", cwd: "services/m", docker: "docker-compose.yml" });
    // mcpServers record→array of { name, transport }.
    expect(manifest.mcpServers?.[0]).toMatchObject({
      name: "chrome",
      transport: { type: "stdio", command: "npx", args: ["-y", "x"] },
    });
    // Identity/runtime fields never leak into the manifest.
    expect(manifest).not.toHaveProperty("id");
    expect(manifest).not.toHaveProperty("repoPath");
    expect(manifest).not.toHaveProperty("defaultBranch");
  });

  it("mcpConfigToTransport handles http/sse", () => {
    expect(mcpConfigToTransport({ type: "http", url: "https://x", headers: { a: "b" } })).toEqual({
      type: "http",
      url: "https://x",
      headers: { a: "b" },
    });
    expect(mcpConfigToTransport({ type: "sse", url: "https://y" })).toEqual({ type: "sse", url: "https://y" });
  });

  it("renderManifestYaml parses back to the manifest", () => {
    const manifest = { name: "X", worktree: "pnpm worktree" };
    const yaml = renderManifestYaml(manifest);
    expect(yaml).toContain("# .dispatch/");
    expect(parseYaml(yaml)).toMatchObject({ name: "X", worktree: "pnpm worktree" });
  });

  it("buildScaffoldEntries emits project.yaml + memory files", () => {
    const entries = buildScaffoldEntries(
      { id: "p", name: "X", repoPath: "/r", worktreeRoot: "", subApps: [], createdAt: 1 },
      [{ name: "a.md", content: "hello" }],
    );
    expect(entries.map((e) => e.path)).toEqual(["project.yaml", "memory/a.md"]);
  });

  it("safeArchivePath rejects traversal / absolute / drive paths", () => {
    expect(safeArchivePath("memory/a.md")).toBe("memory/a.md");
    expect(safeArchivePath("a\\b.md")).toBe("a/b.md");
    expect(safeArchivePath("../escape.md")).toBeNull();
    expect(safeArchivePath("/abs.md")).toBe("abs.md"); // leading slash stripped
    expect(safeArchivePath("a/../../b")).toBeNull();
    expect(safeArchivePath("C:/x")).toBeNull();
    expect(safeArchivePath("")).toBeNull();
  });
});

/* ---------------------------------------------------------------- scaffold */

describe("ProjectConfigArchive — scaffold", () => {
  it("writes a project.yaml + copies .data memories, then the config loads back", async () => {
    // Pinned to `repo`: copying `.data` memories into the tree is what a
    // COMMITTED config dir is for. The default places config outside the repo,
    // where those memories already live and nothing needs copying.
    await seedProject({ configLocation: "repo" });
    await seedMemory("deploy-runbook.md", "---\nname: deploy-runbook\ndescription: ship\ntype: project\n---\nRun pnpm ship.");
    await seedMemory("MEMORY.md", "# Project memory\n\n- [deploy-runbook](deploy-runbook.md) — ship\n");

    const { archive, svc } = makeArchive();
    const out = await archive.scaffold("hivebreak");
    expect(out?.created).toBe(true);
    expect(out?.files).toContain("project.yaml");
    expect(out?.files).toContain("memory/deploy-runbook.md");

    // On disk under the repo's .dispatch/.
    const manifestPath = join(repoDir, ".dispatch", "project.yaml");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = parseYaml(await readFile(manifestPath, "utf8"));
    expect(manifest.name).toBe("Hivebreak");
    expect(manifest.subApps).toHaveLength(2);

    // The loader round-trips it: config now present + name authored.
    expect(out?.result.config?.name).toBe("Hivebreak");
    expect(svc.getConfig("hivebreak")?.subApps.map((s) => s.id).sort()).toEqual(["game", "metrics"]);
    // memoryDir points at the repo's committable dir.
    expect(svc.getConfig("hivebreak")?.memoryDir).toContain(".dispatch");
  });

  it("is a no-op (created:false) when a .dispatch/ already exists (no force)", async () => {
    await seedProject();
    const cfgDir = join(repoDir, ".dispatch");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(join(cfgDir, "project.yaml"), "name: Existing\n", "utf8");

    const { archive } = makeArchive();
    const out = await archive.scaffold("hivebreak");
    expect(out?.created).toBe(false);
    // The existing manifest is untouched.
    expect(parseYaml(await readFile(join(cfgDir, "project.yaml"), "utf8")).name).toBe("Existing");
  });

  it("places config OUTSIDE the repo by default, leaving the working tree clean", async () => {
    await seedProject();
    await seedMemory("note.md", "---\nname: note\ndescription: n\ntype: project\n---\nbody");

    const { archive, svc } = makeArchive();
    const out = await archive.scaffold("hivebreak");

    expect(out?.created).toBe(true);
    expect(out?.sourceDir).toBe(store.projectConfigDir("hivebreak"));
    // The whole point: nothing appeared in the repo to be committed.
    expect(existsSync(join(repoDir, ".dispatch"))).toBe(false);
    // And the memories were not re-copied, because `<dir>/memory` IS the dir
    // they already live in — a copy here would be a rewrite of live files.
    expect(out?.files).toEqual(["project.yaml"]);
    expect(svc.getConfig("hivebreak")?.memoryDir).toBe(store.projectMemoryDir("hivebreak"));
    expect(svc.getConfig("hivebreak")?.name).toBe("Hivebreak");
  });

  it("keeps a COMMITTED .dispatch/ even though the default is external", async () => {
    // The back-compat rule that makes the new default safe to ship: a config dir
    // someone put under version control outranks any app-wide preference.
    await seedProject();
    const cfgDir = join(repoDir, ".dispatch");
    await mkdir(cfgDir, { recursive: true });
    await writeFile(join(cfgDir, "project.yaml"), "name: Committed\n", "utf8");

    const { archive, svc } = makeArchive();
    const out = await archive.scaffold("hivebreak");
    expect(out?.created).toBe(false);
    expect(out?.sourceDir).toBe(cfgDir);
    expect(svc.getConfig("hivebreak")?.name).toBe("Committed");
  });

  it("scaffolds into the repo when the app default says so", async () => {
    await seedProject();
    await store.saveSettings({ theme: "dark", projectConfigLocation: "repo" });

    const { archive } = makeArchive();
    const out = await archive.scaffold("hivebreak");
    expect(out?.sourceDir).toBe(join(repoDir, ".dispatch"));
    expect(existsSync(join(repoDir, ".dispatch", "project.yaml"))).toBe(true);
  });

  it("does not create a repo dir under a repoPath that does not exist", async () => {
    // The guard that used to live at the route. It only applies to a REPO
    // placement — an external dir is inside the install and has no such hazard.
    await seedProject({ repoPath: join(repoDir, "gone"), configLocation: "repo" });
    const { archive } = makeArchive();
    const out = await archive.scaffold("hivebreak");
    expect(out?.created).toBe(false);
    expect(existsSync(join(repoDir, "gone"))).toBe(false);
  });

  it("returns null for an unknown project", async () => {
    const { archive } = makeArchive();
    expect(await archive.scaffold("nope")).toBeNull();
  });
});

/* ---------------------------------------------------------------- relocate */

describe("ProjectConfigArchive — relocate", () => {
  it("moves a committed .dispatch/ out of the repo, memories and all", async () => {
    await seedProject();
    const cfgDir = join(repoDir, ".dispatch");
    await mkdir(join(cfgDir, "memory"), { recursive: true });
    await mkdir(join(cfgDir, "instructions"), { recursive: true });
    await writeFile(
      join(cfgDir, "project.yaml"),
      "name: Hivebreak\ninstructions:\n  - file: house.md\n",
      "utf8",
    );
    await writeFile(join(cfgDir, "instructions", "house.md"), "House rules.", "utf8");
    await writeFile(join(cfgDir, "memory", "a.md"), "remembered", "utf8");

    const { archive, svc } = makeArchive();
    const out = await archive.relocate("hivebreak", "external");

    expect(out?.moved).toBe(true);
    expect(out?.sourceDir).toBe(store.projectConfigDir("hivebreak"));
    expect(out?.files).toEqual(["instructions/house.md", "memory/a.md", "project.yaml"]);
    // The config is live from its new home…
    expect(svc.getConfig("hivebreak")?.instructionsText).toContain("House rules.");
    expect(
      await readFile(join(store.projectMemoryDir("hivebreak"), "a.md"), "utf8"),
    ).toBe("remembered");
    // …and the originals are left for the human to `git rm` in a real commit.
    expect(existsSync(join(cfgDir, "project.yaml"))).toBe(true);
    expect((await store.getProject("hivebreak"))?.configLocation).toBe("external");
  });

  it("moves an external config into the repo", async () => {
    await seedProject();
    const ext = store.projectConfigDir("hivebreak");
    await mkdir(ext, { recursive: true });
    await writeFile(join(ext, "project.yaml"), "name: Moved\n", "utf8");

    const { archive, svc } = makeArchive();
    const out = await archive.relocate("hivebreak", "repo");

    expect(out?.moved).toBe(true);
    expect(out?.sourceDir).toBe(join(repoDir, ".dispatch"));
    expect(svc.getConfig("hivebreak")?.name).toBe("Moved");
  });

  it("does not carry runtime telemetry into the repo", async () => {
    // `memory-stats.json` shares the external dir but is machine-local access
    // counts. Committing one person's recall counts is exactly the churn the
    // external placement exists to avoid.
    await seedProject();
    const ext = store.projectConfigDir("hivebreak");
    await mkdir(ext, { recursive: true });
    await writeFile(join(ext, "project.yaml"), "name: Moved\n", "utf8");
    await writeFile(join(ext, "memory-stats.json"), '{"a":1}', "utf8");

    const { archive } = makeArchive();
    const out = await archive.relocate("hivebreak", "repo");
    expect(out?.files).toEqual(["project.yaml"]);
    expect(existsSync(join(repoDir, ".dispatch", "memory-stats.json"))).toBe(false);
  });

  it("is a no-op when the project is already pinned there", async () => {
    await seedProject({ configLocation: "external" });
    const { archive } = makeArchive();
    const out = await archive.relocate("hivebreak", "external");
    expect(out?.moved).toBe(false);
    expect(out?.files).toEqual([]);
  });

  it("pins the location even when there is no config to move", async () => {
    await seedProject();
    const { archive } = makeArchive();
    const out = await archive.relocate("hivebreak", "repo");
    expect(out?.moved).toBe(false);
    expect((await store.getProject("hivebreak"))?.configLocation).toBe("repo");
  });

  it("refuses to move into a repoPath that is empty or gone", async () => {
    // Regression: `configDirFor("")` is the RELATIVE string `.dispatch`, so this
    // used to mkdir a config dir inside the SERVER'S OWN working directory —
    // silently, and reported as a successful move.
    await seedProject({ repoPath: "" });
    const ext = store.projectConfigDir("hivebreak");
    await mkdir(ext, { recursive: true });
    await writeFile(join(ext, "project.yaml"), "name: Stray\n", "utf8");

    const { archive } = makeArchive();
    await expect(archive.relocate("hivebreak", "repo")).rejects.toThrow(/does not exist/);
    expect(existsSync(".dispatch")).toBe(false);

    await seedProject({ repoPath: join(repoDir, "deleted-checkout") });
    await expect(archive.relocate("hivebreak", "repo")).rejects.toThrow(/does not exist/);
  });

  it("still allows moving OUT of a repo that has vanished", async () => {
    // The guard is one-directional on purpose: rescuing config from a checkout
    // that is no longer there is exactly when you most want the move.
    await seedProject({ repoPath: join(repoDir, "deleted-checkout") });
    const { archive } = makeArchive();
    const out = await archive.relocate("hivebreak", "external");
    expect(out?.sourceDir).toBe(store.projectConfigDir("hivebreak"));
  });

  it("refuses a RELATIVE repoPath that would resolve against the server cwd", async () => {
    // `existsSync` is not the guard — it is exactly what SUCCEEDS for a relative
    // path resolved against the process cwd. The path here is built to exist
    // relative to wherever the runner is, so a test that only checked existence
    // would pass with the fix removed.
    const rel = relative(process.cwd(), repoDir);
    expect(isAbsolute(rel)).toBe(false);
    await seedProject({ repoPath: rel });
    const ext = store.projectConfigDir("hivebreak");
    await mkdir(ext, { recursive: true });
    await writeFile(join(ext, "project.yaml"), "name: Stray\n", "utf8");

    const { archive } = makeArchive();
    await expect(archive.relocate("hivebreak", "repo")).rejects.toThrow(/does not exist/);
    expect(existsSync(join(repoDir, ".dispatch"))).toBe(false);
  });

  it("returns null for an unknown project", async () => {
    const { archive } = makeArchive();
    expect(await archive.relocate("nope", "repo")).toBeNull();
  });
});

/* ------------------------------------------------------------ export/import */

describe("ProjectConfigArchive — export/import round-trip", () => {
  it("exports the real dir when present and re-imports it into a fresh repo", async () => {
    await seedProject();
    const cfgDir = join(repoDir, ".dispatch");
    await mkdir(join(cfgDir, "instructions"), { recursive: true });
    await writeFile(
      join(cfgDir, "project.yaml"),
      "name: Hivebreak\nworktree: pnpm worktree\ninstructions:\n  - file: instructions/house.md\n",
      "utf8",
    );
    await writeFile(join(cfgDir, "instructions", "house.md"), "House rules.", "utf8");

    const { archive } = makeArchive();
    const exp = await archive.exportArchive("hivebreak");
    expect(exp?.fromDisk).toBe(true);
    expect(exp?.filename).toBe("hivebreak.dispatch");
    const names = unzipSync(exp!.buffer).map((e) => e.path).sort();
    expect(names).toEqual(["instructions/house.md", "project.yaml"]);

    // Import into a DIFFERENT project/repo.
    const otherRepo = await mkdtemp(join(tmpdir(), "cm-arch-repo2-"));
    try {
      await store.saveProject({
        id: "other",
        name: "Other",
        // Pinned for the same reason: this case is about landing an archive in a
        // REPO. The external destination has its own test below.
        configLocation: "repo",
        repoPath: otherRepo,
        worktreeRoot: "",
        subApps: [],
        defaultBranch: "main",
        createdAt: 2,
      });
      const imp = await archive.importArchive("other", exp!.buffer);
      expect(imp?.files.sort()).toEqual(["instructions/house.md", "project.yaml"]);
      expect(existsSync(join(otherRepo, ".dispatch", "instructions", "house.md"))).toBe(true);
      // Reloaded: the imported manifest is live.
      expect(imp?.result.config?.name).toBe("Hivebreak");
      expect(imp?.result.config?.instructionsText).toContain("House rules.");
    } finally {
      await rm(otherRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("synthesizes a scaffold on export when no .dispatch/ exists", async () => {
    await seedProject();
    await seedMemory("note.md", "---\nname: note\ndescription: n\ntype: project\n---\nbody");
    const { archive } = makeArchive();
    const exp = await archive.exportArchive("hivebreak");
    expect(exp?.fromDisk).toBe(false);
    const names = unzipSync(exp!.buffer).map((e) => e.path).sort();
    expect(names).toEqual(["memory/note.md", "project.yaml"]);
  });

  it("rejects a corrupt archive on import", async () => {
    await seedProject();
    const { archive } = makeArchive();
    await expect(archive.importArchive("hivebreak", Buffer.from("garbage"))).rejects.toThrow();
  });

  it("returns null exporting/importing an unknown project", async () => {
    const { archive } = makeArchive();
    expect(await archive.exportArchive("nope")).toBeNull();
    expect(await archive.importArchive("nope", Buffer.alloc(0))).toBeNull();
  });
});
