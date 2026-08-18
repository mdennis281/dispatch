import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    await seedProject();
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

  it("returns null for an unknown project", async () => {
    const { archive } = makeArchive();
    expect(await archive.scaffold("nope")).toBeNull();
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
