/**
 * ProjectConfigArchive — export/import a project's self-contained config
 * directory as a portable `.dispatch` archive, SCAFFOLD a fresh one from a
 * project's existing `.data` record, and MOVE one between the repo and the
 * install's own config root.
 *
 * Everything here goes through `config-location.ts` rather than assuming the
 * repo: a config dir lives EITHER in the working tree (committable, shared with
 * the team) or outside it (private to this install), and which one is per
 * project. Reads use the dir that exists; the two writes that PLACE a dir —
 * scaffold and import — go where the app-wide default says.
 *
 * The archive is just a standard ZIP of the config tree (see {@link zipSync}) —
 * dependency-free, openable in any unzipper, and a clean template/portable unit:
 *   - EXPORT: zip the project's real config dir when it exists, else synthesize
 *     the scaffold (so you can export a template even before adopting).
 *   - IMPORT: unzip one back into the config dir (path-guarded against
 *     traversal), then reload so every consumer picks it up live. Import reads
 *     the bytes, never the extension, so archives exported as `.cm` before the
 *     rename still import unchanged.
 *   - SCAFFOLD: derive a `project.yaml` from the stored Project (the inverse of
 *     the loader's manifest→Project mapping), plus the `.data` memories copied
 *     into `memory/` when the destination is a repo (an external dir already IS
 *     where those memories live).
 *   - RELOCATE: copy the tree to the other location and re-pin the project.
 *
 * The manifest mapping is the mirror of `project-config.ts`'s `load`:
 * `SubApp.path → cwd`, `dockerCompose → docker`, and the `mcpServers` record →
 * an array of `{ name, transport }` with the transport un-flattened. It lives in
 * `@dispatch/shared` (and is re-exported here) because the new-project form
 * renders the SAME function's output as a live preview of the file this writes.
 */
import { join, sep } from "node:path";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  ARCHIVE_EXT,
  MANIFEST_FILE,
  projectToManifest,
  renderManifestYaml,
  type Project,
  type ProjectConfigLocation,
  type ProjectConfigResult,
} from "@dispatch/shared";
import { configDirFor } from "@dispatch/cli/core";
import { resolveConfigDir, resolvePlacementDir } from "./config-location.js";
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

// The Project→manifest mapping and the YAML render moved to `@dispatch/shared`
// so the new-project form can preview the exact file this writes. Re-exported
// here because this module is still where "the archive format" is documented,
// and every existing importer (and its tests) reaches for them by this path.
export { mcpConfigToTransport, projectToManifest, renderManifestYaml } from "@dispatch/shared";

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

/**
 * Runtime sidecars that share the EXTERNAL config dir but are not config.
 *
 * An external config dir is the project's own entity dir, so the store's
 * `memory-stats.json` (how often each memory gets recalled — machine-local
 * telemetry, deliberately never committed) sits right next to `project.yaml`.
 * An archive is a portable template someone may import into a REPO, so shipping
 * this install's access counts inside it would put exactly the file that dir
 * was chosen to keep out of git into the one artifact designed to travel.
 */
const RUNTIME_SIDECARS = new Set(["memory-stats.json"]);

function isRuntimeSidecar(rel: string): boolean {
  return RUNTIME_SIDECARS.has(rel);
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
  /** Whether the zip came from a real on-disk `.dispatch/` (vs synthesized). */
  fromDisk: boolean;
}

export interface ScaffoldResult {
  /** True when files were written; false when a `.dispatch/` already existed. */
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

/** Outcome of a {@link ProjectConfigArchive.relocate}. */
export interface RelocateResult {
  /** Whether any files were actually copied (false when there was no config). */
  moved: boolean;
  /** The dir the config came FROM — still on disk; nothing is deleted. */
  from: string;
  /** The dir the config now resolves to. */
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
    return resolveConfigDir(project, this.store.projectConfigDir(project.id)).dir;
  }

  private filenameFor(project: Project): string {
    const slug =
      project.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || project.id;
    return `${slug}${ARCHIVE_EXT}`;
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
   * Export a project's config dir as a `.dispatch` zip. Uses the real dir when
   * present; otherwise synthesizes the scaffold so a template is always
   * exportable. Returns null when the project doesn't exist.
   */
  async exportArchive(projectId: string): Promise<ExportResult | null> {
    const project = await this.store.getProject(projectId).catch(() => null);
    if (!project) return null;
    const dir = this.configDir(project);
    let entries: ZipEntry[];
    let fromDisk = false;
    if (existsSync(join(dir, MANIFEST_FILE))) {
      entries = (await readDirEntries(dir)).filter((e) => !isRuntimeSidecar(e.path));
      fromDisk = true;
    } else {
      entries = await this.synthesize(project);
    }
    return { filename: this.filenameFor(project), buffer: zipSync(entries), fromDisk };
  }

  /**
   * Write a set of entries into a project's `.dispatch/` dir (creating
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
   * Scaffold a config dir for a project from its `.data` record. No-op
   * (created:false) when one already exists unless `force` is set. Writes the
   * files, (re)watches, reloads, and returns the fresh result.
   *
   * WHERE it writes is `resolvePlacementDir`: the app-wide default for a project
   * with no config dir yet, and the project's existing dir otherwise — so
   * `force` re-derives a manifest in place and never relocates one.
   */
  async scaffold(
    projectId: string,
    opts: { force?: boolean } = {},
  ): Promise<ScaffoldResult | null> {
    const project = await this.store.getProject(projectId).catch(() => null);
    if (!project) return null;
    const settings = await this.store.getSettings().catch(() => null);
    const target = resolvePlacementDir(
      project,
      this.store.projectConfigDir(project.id),
      settings?.projectConfigLocation,
    );
    const dir = target.dir;
    // Writing into a repo means creating directories in the human's workspace, so
    // a mistyped `repoPath` must not materialize one. An EXTERNAL dir is inside
    // the install's own config root and has no such hazard — which is why this
    // guard lives here, where the placement is known, rather than at the caller.
    if (target.location === "repo" && !existsSync(project.repoPath)) {
      const result = await this.projectConfig.reload(projectId);
      return { created: false, sourceDir: dir, files: [], result };
    }
    const exists = existsSync(join(dir, MANIFEST_FILE));
    if (exists && !opts.force) {
      const result = await this.projectConfig.reload(projectId);
      return { created: false, sourceDir: dir, files: [], result };
    }
    let entries = await this.synthesize(project);
    // An EXTERNAL config dir is the project's entity dir, so `<dir>/memory` is
    // already `store.projectMemoryDir` — the very files `synthesize` just read.
    // Writing them back would be a truncate-and-rewrite of live memories for no
    // gain; the copy exists only to carry them INTO a repo.
    if (target.location === "external") {
      entries = entries.filter((e) => !e.path.startsWith("memory/"));
    }
    const files = await this.writeEntries(dir, entries);
    this.projectConfig.watchProject(project);
    const result = await this.projectConfig.reload(projectId);
    return { created: true, sourceDir: dir, files, result };
  }

  /**
   * MOVE a project's config between the repo and the install's own dir, copying
   * the tree so nothing is stranded, and persist the new location on the project.
   *
   * The copy is what makes the setting usable rather than a trapdoor. Flipping
   * the field alone re-points the loader at an empty directory: every
   * instruction, skill and memory is still on disk, and all of them are
   * instantly invisible — which reads exactly like data loss even though nothing
   * was deleted.
   *
   * The source is left in place, deliberately. Going repo → external means the
   * files are also tracked in git, and deleting tracked files behind someone's
   * back is not this function's call to make; `git rm` is one command and it
   * belongs in a commit the human writes. Going the other way the source is the
   * install's own dir, which costs nothing to keep.
   *
   * Returns null for an unknown project, and a no-op result when the project is
   * already there.
   */
  async relocate(
    projectId: string,
    to: ProjectConfigLocation,
  ): Promise<RelocateResult | null> {
    const project = await this.store.getProject(projectId).catch(() => null);
    if (!project) return null;

    const externalDir = this.store.projectConfigDir(project.id);
    const from = resolveConfigDir(project, externalDir);

    // A project record can carry an empty or stale `repoPath` (one typed wrong,
    // or a checkout since deleted). `configDirFor("")` is the RELATIVE string
    // `.dispatch`, which `mkdir` then resolves against the server's own working
    // directory — so this refused-to-be-a-move quietly created a config dir
    // inside the Dispatch install itself. Caught by the API round-trip, and the
    // reason this is a throw rather than a silent no-op: the human pressed a
    // button, and "nothing happened" is not an answer they can act on.
    if (to === "repo" && (!project.repoPath || !existsSync(project.repoPath))) {
      throw new Error(
        `cannot move config into the repo: ${project.repoPath || "(no repo path)"} does not exist`,
      );
    }
    const dir = to === "repo" ? configDirFor(project.repoPath) : externalDir;

    if (from.location === to && project.configLocation === to) {
      const result = await this.projectConfig.reload(projectId);
      return { moved: false, from: from.dir, sourceDir: dir, files: [], result };
    }

    // Copy only when there is something to copy AND we are not being asked to
    // copy a directory onto itself (`from.dir === dir` when the location was
    // already right and only the explicit pin was missing).
    let files: string[] = [];
    if (from.exists && from.dir !== dir) {
      const entries = (await readDirEntries(from.dir)).filter((e) => !isRuntimeSidecar(e.path));
      await mkdir(dir, { recursive: true });
      files = await this.writeEntries(dir, entries);
    }

    await this.store.saveProject({ ...project, configLocation: to });
    this.projectConfig.watchProject({ ...project, configLocation: to });
    const result = await this.projectConfig.reload(projectId);
    return { moved: files.length > 0, from: from.dir, sourceDir: dir, files, result };
  }

  /**
   * Import an archive into a project's config dir (overlaying existing files),
   * then reload so consumers pick it up. Throws on a corrupt archive or an
   * unsafe entry path.
   *
   * Placement follows the same rule as `scaffold` — into the dir the project
   * already has, else wherever the app-wide default puts a new one. Adopting a
   * config and generating one are the same decision, and splitting them would
   * let an import quietly plant a `.dispatch/` in a repo that has spent its
   * whole life keeping Dispatch out of the working tree.
   */
  async importArchive(projectId: string, buffer: Buffer): Promise<ImportResult | null> {
    const project = await this.store.getProject(projectId).catch(() => null);
    if (!project) return null;
    const entries = unzipSync(buffer);
    if (!entries.length) throw new Error("archive is empty");
    const settings = await this.store.getSettings().catch(() => null);
    const dir = resolvePlacementDir(
      project,
      this.store.projectConfigDir(project.id),
      settings?.projectConfigLocation,
    ).dir;
    await mkdir(dir, { recursive: true });
    const files = await this.writeEntries(dir, entries);
    this.projectConfig.watchProject(project);
    const result = await this.projectConfig.reload(projectId);
    return { sourceDir: dir, files, result };
  }
}
