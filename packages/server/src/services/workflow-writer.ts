/**
 * workflow-writer — persist a project's workflow block to the RIGHT place.
 *
 * A project's workflow settings have two possible homes, and picking the wrong
 * one is why an edit made in the UI could silently vanish:
 *
 *   - a repo WITH a `.dispatch/project.yaml` — the manifest is the source of
 *     truth, and `mergeProject` re-applies its `workflow:` block over the stored
 *     record on every config reload. Writing such a project's settings to `.data`
 *     "works" until the next reload (a watcher edit, a scaffold, a restart) and
 *     then reverts. So the write has to land in the YAML.
 *   - a repo WITHOUT one — there's nothing to override it, so the stored project
 *     record IS the source of truth.
 *
 * The manifest write goes through the CLI's `yaml` Document helpers (the same
 * ones `dispatch mcp` uses), so a hand-authored, commented `project.yaml` keeps
 * its comments, key order and blank lines — only the workflow keys actually
 * changed are rewritten. It is validated against `ProjectManifestSchema` and
 * written atomically before this returns.
 */
import { existsSync } from "node:fs";
import { loadManifest, saveManifest, resolveProjectPaths } from "@dispatch/cli/core";
import { WorkflowConfigSchema, type Project, type WorkflowConfig } from "@dispatch/shared";
import type { Store } from "../store/index.js";
import type { ProjectConfigService } from "./project-config.js";

/** Where a workflow save landed — surfaced to the UI so it can say so. */
export type WorkflowSaveTarget = "manifest" | "store";

export interface WorkflowSaveResult {
  target: WorkflowSaveTarget;
  /** The project record after the save (manifest saves re-sync it via reload). */
  project: Project;
  /** Absolute `project.yaml` path, when the manifest was the target. */
  manifestPath?: string;
}

/**
 * Which keys of a workflow block this writer manages. Anything the schema gains
 * later is picked up automatically — the list is derived from the schema, not
 * hand-maintained, so a new field can't be silently dropped on save.
 */
const WORKFLOW_KEYS = Object.keys(WorkflowConfigSchema.shape) as (keyof WorkflowConfig)[];

/**
 * True when this project's config is manifest-backed — i.e. a `project.yaml`
 * exists that would override anything written to `.data`.
 */
export function isManifestBacked(project: Project): boolean {
  if (!project.repoPath || !existsSync(project.repoPath)) return false;
  return resolveProjectPaths(project.repoPath).exists;
}

/**
 * Save `workflow` for a project, choosing the manifest or the store as above.
 *
 * The incoming block REPLACES the previous one rather than merging into it: the
 * UI always sends the complete block it's showing, and a merge would make
 * clearing a field (back to its profile default) impossible to express.
 */
export async function saveProjectWorkflow(
  deps: { store: Store; projectConfig: ProjectConfigService },
  projectId: string,
  workflow: WorkflowConfig,
): Promise<WorkflowSaveResult | null> {
  const project = await deps.store.getProject(projectId).catch(() => null);
  if (!project) return null;

  if (!isManifestBacked(project)) {
    const saved = await deps.store.saveProject({ ...project, workflow });
    return { target: "store", project: saved };
  }

  const loaded = await loadManifest(project.repoPath);
  // Set/delete key-by-key (rather than replacing the whole `workflow` node) so
  // comments attached to the keys we aren't touching survive the write.
  for (const key of WORKFLOW_KEYS) {
    const value = workflow[key];
    if (value === undefined) loaded.doc.deleteIn(["workflow", key]);
    else loaded.doc.setIn(["workflow", key], value);
  }
  const manifestPath = await saveManifest(loaded);

  // Re-read from disk so the store, the cached config and every WS client end up
  // agreeing with the file we just wrote — the same path a watcher edit takes.
  await deps.projectConfig.reload(projectId);
  const project2 = (await deps.store.getProject(projectId).catch(() => null)) ?? project;
  return { target: "manifest", project: project2, manifestPath };
}
