/**
 * authored-project — the `project` scope of {@link AuthoredConfigService}'s
 * write surface: instructions and skills inside a repo's committed `.dispatch/`.
 *
 * Split from `authored-config.ts` because this half has a dependency that half
 * must not: the CLI's YAML document helpers. Writing a project INSTRUCTION is
 * two operations, not one —
 *
 *   1. write `.dispatch/instructions/<name>.md`, and
 *   2. add `{ file: instructions/<name>.md }` to `project.yaml`'s `instructions:`.
 *
 * — and step 2 is load-bearing. `ProjectConfigService` builds the system-prompt
 * append from the MANIFEST LIST, not from the directory, so a file written
 * without registering it is a file that is never injected and never errors. That
 * is the exact failure this module exists to make impossible: an instruction
 * authored through the config tools is active the moment the next turn starts.
 *
 * The manifest edit goes through the same `yaml` Document helpers `dispatch mcp`
 * and `workflow-writer` use, so a hand-authored, commented `project.yaml` keeps
 * its comments, key order and blank lines.
 *
 * No reload plumbing here either: `ProjectConfigService` watches `.dispatch/` and
 * debounce-reloads, so a write lands for the next turn exactly like a hand edit.
 */
import { join, relative, resolve } from "node:path";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadManifest, saveManifest, type LoadedManifest } from "@dispatch/cli/core";
import { isSeq, type Document } from "yaml";
import {
  DEFAULT_INSTRUCTIONS_DIR,
  DEFAULT_SKILLS_DIR,
  type AuthoredItem,
  type AuthoredKind,
  type ProjectConfig,
} from "@dispatch/shared";
import { assertName, readInstructionsDir, readSkillsDir, renderSkill } from "./authored-config.js";

/** What a project-scope write did, for the tool's receipt. */
export interface ProjectWriteResult {
  /** Absolute path written. */
  path: string;
  /** True when this call also added the entry to `project.yaml`. */
  registered: boolean;
  /** Absolute `project.yaml` path, when it was touched. */
  manifestPath?: string;
}

/**
 * A project's authored instructions + skills as {@link AuthoredItem}s.
 *
 * Read from the DIRECTORY rather than from the loaded `ProjectConfig`, even
 * though the config already holds a parsed `skills` list. The config is
 * refreshed by a debounced fs watcher, so a `config_list` issued immediately
 * after a `config_write` would not show the file it just created — which reads
 * as "the write didn't work" and invites a second one.
 *
 * Instructions are additionally cross-checked against the manifest, and an
 * unregistered file is reported with `active:false` rather than hidden. A file
 * sitting in `instructions/` doing nothing is a real state that happens (a
 * hand-placed file, a half-finished edit), and the honest answer to "what
 * instructions does this project have" names it and says it's inert.
 */
export async function listProjectItems(
  kind: AuthoredKind,
  config: ProjectConfig,
): Promise<AuthoredItem[]> {
  if (kind === "skill") {
    return readSkillsDir(config.skillsDir).map((s) => ({
      kind: "skill" as const,
      scope: "project" as const,
      name: s.dir,
      description: s.description,
      path: s.path,
      writable: true,
      active: true,
    }));
  }
  const registered = new Set(
    config.instructions
      .filter((i) => i.source === "file" && i.rel)
      .map((i) => resolve(config.sourceDir, i.rel as string)),
  );
  const files = await readInstructionsDir(config.instructionsDir);
  return files.map((f) => ({
    kind: "instruction" as const,
    scope: "project" as const,
    name: f.name,
    description: f.description,
    path: f.path,
    writable: true,
    active: registered.has(resolve(f.path)),
  }));
}

/**
 * Create or overwrite a project-scope item, registering an instruction in the
 * manifest when it isn't already listed.
 *
 * `repoPath` should be the project's MAIN working copy, not a session worktree:
 * `.dispatch/` is committed config, and an edit made in a throwaway tree would be
 * discarded with it — the same rule `mcp-config-editor` follows.
 */
export async function writeProjectItem(
  repoPath: string,
  kind: AuthoredKind,
  name: string,
  body: string,
  description?: string,
): Promise<ProjectWriteResult> {
  assertName(name);
  const loaded = await loadManifest(repoPath);
  const configDir = loaded.paths.configDir;

  if (kind === "skill") {
    const dir = join(configDir, skillsDirName(loaded.doc), name);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    await writeFile(path, renderSkill(name, description, body), "utf8");
    // A skill needs no manifest entry — the loader enumerates the directory. But
    // the manifest may not EXIST yet (a repo with no `.dispatch/`), in which case
    // `loadManifest` synthesized one and nothing would anchor the config dir.
    if (!loaded.existed) await saveManifest(loaded);
    return { path, registered: false, manifestPath: loaded.existed ? undefined : loaded.paths.manifestPath };
  }

  const dirName = instructionsDirName(loaded.doc);
  const dir = join(configDir, dirName);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  await writeFile(path, `${body.trimEnd()}\n`, "utf8");

  const rel = `${dirName}/${name}.md`;
  const registered = registerInstruction(loaded.doc, rel);
  if (registered || !loaded.existed) await saveManifest(loaded);
  return { path, registered, manifestPath: loaded.paths.manifestPath };
}

/**
 * Delete a project-scope item, and for an instruction also drop its manifest
 * entry — leaving one behind would make the next config load report a missing
 * file as a config error on every reload.
 */
export async function deleteProjectItem(
  repoPath: string,
  kind: AuthoredKind,
  name: string,
): Promise<boolean> {
  assertName(name);
  const loaded = await loadManifest(repoPath);
  if (!loaded.existed) return false;
  const configDir = loaded.paths.configDir;

  if (kind === "skill") {
    const dir = join(configDir, skillsDirName(loaded.doc), name);
    const flat = join(configDir, skillsDirName(loaded.doc), `${name}.md`);
    const target = existsSync(dir) ? dir : existsSync(flat) ? flat : null;
    if (!target) return false;
    await rm(target, { recursive: true, force: true });
    return true;
  }

  const dirName = instructionsDirName(loaded.doc);
  const path = join(configDir, dirName, `${name}.md`);
  const unregistered = unregisterInstruction(loaded.doc, `${dirName}/${name}.md`, `${name}.md`);
  const existed = existsSync(path);
  if (existed) await rm(path, { force: true });
  if (unregistered) await saveManifest(loaded);
  return existed || unregistered;
}

/** Read one project-scope item's raw file. Null when it isn't there. */
export async function readProjectItem(
  repoPath: string,
  kind: AuthoredKind,
  name: string,
): Promise<{ path: string; text: string } | null> {
  assertName(name);
  const loaded = await loadManifest(repoPath);
  const configDir = loaded.paths.configDir;
  const candidates =
    kind === "skill"
      ? [
          join(configDir, skillsDirName(loaded.doc), name, "SKILL.md"),
          join(configDir, skillsDirName(loaded.doc), `${name}.md`),
        ]
      : [join(configDir, instructionsDirName(loaded.doc), `${name}.md`)];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    return { path, text: await readFile(path, "utf8") };
  }
  return null;
}

/* ----------------------------------------------------------------- manifest */

/** `instructionsDir:` override, else the default. */
function instructionsDirName(doc: Document): string {
  const v = doc.get("instructionsDir");
  return typeof v === "string" && v.trim() ? v.trim() : DEFAULT_INSTRUCTIONS_DIR;
}

/** `skills:` dir override, else the default. */
function skillsDirName(doc: Document): string {
  const v = doc.get("skills");
  return typeof v === "string" && v.trim() ? v.trim() : DEFAULT_SKILLS_DIR;
}

/**
 * Ensure `instructions:` lists `rel`. Returns false when it already did, so the
 * caller can skip a no-op manifest rewrite (and its git churn).
 *
 * The existing-entry check accepts BOTH spellings the loader resolves — the
 * dir-relative `instructions/house.md` and the bare `house.md` — because adding
 * a second entry for a file already listed under its other name would inject the
 * same text twice.
 */
export function registerInstruction(doc: Document, rel: string): boolean {
  const bare = rel.slice(rel.lastIndexOf("/") + 1);
  const node = doc.get("instructions");
  const entries = isSeq(node) ? node.items : [];
  for (const item of entries) {
    const file = fileOf(item);
    if (file === rel || file === bare) return false;
  }
  if (!isSeq(node)) {
    doc.set("instructions", [{ file: rel }]);
    return true;
  }
  doc.addIn(["instructions"], { file: rel });
  return true;
}

/** Drop `instructions:` entries pointing at either spelling of a file. */
export function unregisterInstruction(doc: Document, rel: string, bare: string): boolean {
  const node = doc.get("instructions");
  if (!isSeq(node)) return false;
  const keep = node.items.filter((item) => {
    const file = fileOf(item);
    return file !== rel && file !== bare;
  });
  if (keep.length === node.items.length) return false;
  if (keep.length) doc.set("instructions", keep);
  else doc.delete("instructions");
  return true;
}

/** The `file:` of a manifest instruction entry, whether it's a node or a plain object. */
function fileOf(item: unknown): string | undefined {
  const get = (item as { get?: (k: string) => unknown } | null)?.get;
  const value =
    typeof get === "function"
      ? get.call(item, "file")
      : (item as { file?: unknown } | null)?.file;
  return typeof value === "string" ? value.replace(/\\/g, "/") : undefined;
}

/** Config-dir-relative, forward-slashed — the form the UI and errors speak. */
export function relToConfig(configDir: string, abs: string): string {
  return relative(configDir, abs).replace(/\\/g, "/");
}

export type { LoadedManifest };
