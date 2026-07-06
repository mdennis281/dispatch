/**
 * ProjectConfigArchive — export/import a project's self-contained
 * `.claude-manager/` directory as a portable `.cm` archive, and SCAFFOLD a fresh
 * one from a project's existing `.data` record.
 *
 * The `.cm` format is just a standard ZIP of the `.claude-manager/` tree (see
 * {@link zipSync}) — dependency-free, openable in any unzipper, and a clean
 * template/portable unit:
 *   - EXPORT: zip the repo's real `.claude-manager/` when it exists, else
 *     synthesize the scaffold (so you can export a template even before adopting).
 *   - IMPORT: unzip a `.cm` back into the repo's `.claude-manager/` (path-guarded
 *     against traversal), then reload so every consumer picks it up live.
 *   - SCAFFOLD: derive a `project.yaml` from the stored Project (the inverse of
 *     the loader's manifest→Project mapping) + copy the `.data` memories into
 *     `memory/`, writing them into the repo (untracked, for the owner to review).
 *
 * The manifest mapping is the mirror of `project-config.ts`'s `load`:
 * `SubApp.path → cwd`, `dockerCompose → docker`, and the `mcpServers` record →
 * an array of `{ name, transport }` with the transport un-flattened.
 */
import { join, sep } from "node:path";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import {
  CONFIG_DIR_NAME,
  MANIFEST_FILE,
  type Project,
  type ProjectManifest,
  type ManifestSubApp,
  type ManifestMcpServer,
  type ManifestMcpTransport,
  type McpServerConfig,
  type ProjectConfigResult,
} from "@cm/shared";
import type { Store } from "../store/index.js";
import { zipSync, unzipSync, type ZipEntry } from "./zip.js";

/** The minimal slice of ProjectConfigService the archive needs (reload seam). */
export interface ArchiveProjectConfig {
  reload(projectId: string): Promise<ProjectConfigResult>;
  watchProject(project: Project): void;
}

export interface ProjectConfigArchiveOptions {
  store: Store;
  projectConfig: ArchiveProjectConfig;
}

/* ------------------------------------------------------------ pure mapping */

/** Un-flatten a stored {@link McpServerConfig} back into a manifest transport. */
export function mcpConfigToTransport(cfg: McpServerConfig): ManifestMcpTransport {
  if (cfg.type === "stdio") {
    return {
      type: "stdio",
      command: cfg.command ?? "",
      ...(cfg.args ? { args: cfg.args } : {}),
      ...(cfg.env ? { env: cfg.env } : {}),
    };
  }
  return {
    type: cfg.type === "sse" ? "sse" : "http",
    url: cfg.url ?? "",
    ...(cfg.headers ? { headers: cfg.headers } : {}),
  };
}

/** Drop `undefined` values so the emitted YAML stays clean (no `key: null`). */
function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}

/**
 * Derive a `.claude-manager/` manifest from a stored Project — the inverse of the
 * loader's manifest→Project mapping. Identity/runtime fields (id, repoPath,
 * createdAt, defaultBranch) are intentionally omitted: they belong to `.data`,
 * not the committable authored config.
 */
export function projectToManifest(project: Project): ProjectManifest {
  const subApps: ManifestSubApp[] | undefined = project.subApps.length
    ? project.subApps.map((s) =>
        pruneUndefined<ManifestSubApp>({
          id: s.id,
          name: s.name,
          cwd: s.path,
          install: s.install,
          dev: s.dev,
          build: s.build,
          test: s.test,
          ports: s.ports,
          url: s.url,
          docker: s.dockerCompose,
        }),
      )
    : undefined;

  const mcpEntries = Object.entries(project.mcpServers ?? {});
  const mcpServers: ManifestMcpServer[] | undefined = mcpEntries.length
    ? mcpEntries.map(([name, cfg]) => ({ name, transport: mcpConfigToTransport(cfg) }))
    : undefined;

  return pruneUndefined<ProjectManifest>({
    name: project.name,
    worktreeRoot: project.worktreeRoot || undefined,
    worktree: project.worktreeCmd,
    ship: project.shipCmd,
    subApps,
    mcpServers,
  });
}

/** Render a manifest to `project.yaml` text with a self-describing header. */
export function renderManifestYaml(manifest: ProjectManifest): string {
  const header = [
    "# .claude-manager/ — self-contained, committable claude-manager config for this repo.",
    "# Discovered + loaded by claude-manager as the SOURCE OF TRUTH for authored config;",
    "# .data keeps only runtime state (chats, sessions, checkpoints). Safe to commit.",
    "",
  ].join("\n");
  return header + stringifyYaml(manifest);
}

/**
 * Build the scaffold file set for a project: `project.yaml` derived from the
 * stored record, plus the given memory files copied verbatim under `memory/`.
 * Pure (no fs) so it's directly unit-testable.
 */
export function buildScaffoldEntries(
  project: Project,
  memoryFiles: { name: string; content: string }[],
): ZipEntry[] {
  const entries: ZipEntry[] = [
    {
      path: MANIFEST_FILE,
      data: Buffer.from(renderManifestYaml(projectToManifest(project)), "utf8"),
    },
  ];
  for (const m of memoryFiles) {
    entries.push({ path: `memory/${m.name}`, data: Buffer.from(m.content, "utf8") });
  }
  return entries;
}

/* --------------------------------------------------------------- fs helpers */

/**
 * Guard an archive entry path: forward-slashed, no absolute/drive/`..` segment.
 * Returns the normalized safe relative path, or null when it must be rejected.
 */
export function safeArchivePath(name: string): string | null {
  const norm = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm || norm.length > 1024) return null;
  const segments = norm.split("/");
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") return null;
    if (/^[a-zA-Z]:$/.test(s)) return null; // drive letter
    if (s.includes("\0")) return null;
  }
  return segments.join("/");
}

/** Recursively read a directory into forward-slashed zip entries. */
async function readDirEntries(dir: string, baseRel = ""): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  const dirents = await readdir(dir, { withFileTypes: true });
  for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, d.name);
    const rel = baseRel ? `${baseRel}/${d.name}` : d.name;
    if (d.isDirectory()) {
      out.push(...(await readDirEntries(abs, rel)));
    } else if (d.isFile()) {
      out.push({ path: rel, data: await readFile(abs) });
    }
  }
  return out;
}

/** List a project's `.data` memory markdown files (name + raw content). */
async function readDataMemoryFiles(
  memoryDir: string,
): Promise<{ name: string; content: string }[]> {
  if (!existsSync(memoryDir)) return [];
  const dirents = await readdir(memoryDir, { withFileTypes: true });
  const out: { name: string; content: string }[] = [];
  for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (d.isFile() && d.name.endsWith(".md")) {
      out.push({ name: d.name, content: await readFile(join(memoryDir, d.name), "utf8") });
    }
  }
  return out;
}

/* ------------------------------------------------------- ProjectConfigArchive */

export interface ExportResult {
  filename: string;
  buffer: Buffer;
  /** Whether the zip came from a real on-disk `.claude-manager/` (vs synthesized). */
  fromDisk: boolean;
}

export interface ScaffoldResult {
  /** True when files were written; false when a `.claude-manager/` already existed. */
  created: boolean;
  sourceDir: string;
  files: string[];
  result: ProjectConfigResult;
}

export interface ImportResult {
  sourceDir: string;
  files: string[];
  result: ProjectConfigResult;
}

export class ProjectConfigArchive {
  private readonly store: Store;
  private readonly projectConfig: ArchiveProjectConfig;

  constructor(opts: ProjectConfigArchiveOptions) {
    this.store = opts.store;
    this.projectConfig = opts.projectConfig;
  }

  private configDir(project: Project): string {
    return join(project.repoPath, CONFIG_DIR_NAME);
  }

  private filenameFor(project: Project): string {
    const slug =
      project.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || project.id;
    return `${slug}.cm`;
  }

  /**
   * The scaffold entries for a project synthesized from `.data` (manifest +
   * copied memories). Shared by scaffold + export-when-no-dir.
   */
  private async synthesize(project: Project): Promise<ZipEntry[]> {
    const memoryFiles = await readDataMemoryFiles(
      this.store.projectMemoryDir(project.id),
    );
    return buildScaffoldEntries(project, memoryFiles);
  }

  /**
   * Export a project's `.claude-manager/` as a `.cm` zip. Uses the repo's real
   * dir when present; otherwise synthesizes the scaffold so a template is always
   * exportable. Returns null when the project doesn't exist.
   */
  async exportArchive(projectId: string): Promise<ExportResult | null> {
    const project = await this.store.getProject(projectId).catch(() => null);
    if (!project) return null;
    const dir = this.configDir(project);
    let entries: ZipEntry[];
    let fromDisk = false;
    if (existsSync(join(dir, MANIFEST_FILE))) {
      entries = await readDirEntries(dir);
      fromDisk = true;
    } else {
      entries = await this.synthesize(project);
    }
    return { filename: this.filenameFor(project), buffer: zipSync(entries), fromDisk };
  }

  /**
   * Write a set of entries into a project's `.claude-manager/` dir (creating
   * parent dirs), rejecting any traversal/absolute path. Returns the written
   * relative paths (sorted). Shared by scaffold + import.
   */
  private async writeEntries(dir: string, entries: ZipEntry[]): Promise<string[]> {
    const written: string[] = [];
    for (const entry of entries) {
      const rel = safeArchivePath(entry.path);
      if (!rel) throw new Error(`unsafe archive path: ${entry.path}`);
      const abs = join(dir, rel.split("/").join(sep));
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, entry.data);
      written.push(rel);
    }
    return written.sort();
  }

  /**
   * Scaffold a `.claude-manager/` for a project from its `.data` record. No-op
   * (created:false) when one already exists unless `force` is set. Writes the
   * files, (re)watches, reloads, and returns the fresh result.
   */
  async scaffold(
    projectId: string,
    opts: { force?: boolean } = {},
  ): Promise<ScaffoldResult | null> {
    const project = await this.store.getProject(projectId).catch(() => null);
    if (!project) return null;
    const dir = this.configDir(project);
    const exists = existsSync(join(dir, MANIFEST_FILE));
    if (exists && !opts.force) {
      const result = await this.projectConfig.reload(projectId);
      return { created: false, sourceDir: dir, files: [], result };
    }
    const entries = await this.synthesize(project);
    const files = await this.writeEntries(dir, entries);
    this.projectConfig.watchProject(project);
    const result = await this.projectConfig.reload(projectId);
    return { created: true, sourceDir: dir, files, result };
  }

  /**
   * Import a `.cm` archive into a project's `.claude-manager/` dir (overlaying
   * existing files), then reload so consumers pick it up. Throws on a corrupt
   * archive or an unsafe entry path.
   */
  async importArchive(projectId: string, buffer: Buffer): Promise<ImportResult | null> {
    const project = await this.store.getProject(projectId).catch(() => null);
    if (!project) return null;
    const entries = unzipSync(buffer);
    if (!entries.length) throw new Error("archive is empty");
    const dir = this.configDir(project);
    await mkdir(dir, { recursive: true });
    const files = await this.writeEntries(dir, entries);
    this.projectConfig.watchProject(project);
    const result = await this.projectConfig.reload(projectId);
    return { sourceDir: dir, files, result };
  }
}
