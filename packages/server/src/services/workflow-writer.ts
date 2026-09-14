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
import { loadManifest, saveManifest, type LoadedManifest } from "@dispatch/cli/core";
import * as z from "zod";
import { isMap } from "yaml";
import {
  EffortSchema,
  HarnessKindSchema,
  ShellTranscriptFilterSchema,
  WorkflowConfigSchema,
  type Project,
  type ShellTranscriptFilter,
  type WorkflowConfig,
} from "@dispatch/shared";
import type { Store } from "../store/index.js";
import type { ProjectConfigService } from "./project-config.js";
import { configPathsFor, resolveConfigDir } from "./config-location.js";

/** Where a workflow save landed — surfaced to the UI so it can say so. */
export type WorkflowSaveTarget = "manifest" | "store";

export interface WorkflowSaveResult {
  target: WorkflowSaveTarget;
  /** The project record after the save (manifest saves re-sync it via reload). */
  project: Project;
  /** Absolute `project.yaml` path, when the manifest was the target. */
  manifestPath?: string;
}

export type ProjectSettingSaveResult = WorkflowSaveResult;

/**
 * Which keys of a workflow block this writer manages. Anything the schema gains
 * later is picked up automatically — the list is derived from the schema, not
 * hand-maintained, so a new field can't be silently dropped on save.
 */
const WORKFLOW_KEYS = Object.keys(WorkflowConfigSchema.shape) as (keyof WorkflowConfig)[];

/**
 * True when this project's config is manifest-backed — i.e. a `project.yaml`
 * exists that would override anything written to `.data`.
 *
 * Asks the resolver rather than walking up from `repoPath`, so a project whose
 * manifest lives OUTSIDE the repo still counts as manifest-backed. Getting this
 * wrong is silent and lasting: a workflow save would go to `.data` and then be
 * overridden on the next load by the manifest it never touched.
 *
 * The old `existsSync(repoPath)` precondition is gone with it. It stood in for
 * "nothing to walk up from", which no longer decides anything — an external
 * config dir exists whether or not the checkout does.
 */
export function isManifestBacked(project: Project, externalDir: string): boolean {
  return resolveConfigDir(project, externalDir).exists;
}

/**
 * The store-backed twin of {@link applyAuthored} — same merge rule, applied to a
 * plain object instead of a YAML document.
 */
function mergeWorkflow(prev: WorkflowConfig | undefined, next: WorkflowConfig): WorkflowConfig {
  return mergeBlocks(prev ?? {}, next) as WorkflowConfig;
}

function mergeBlocks(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) continue;
    const before = out[k];
    out[k] = isBlock(v) && isBlock(before) ? mergeBlocks(before, v) : v;
  }
  return out;
}

/** A block to recurse into, as opposed to a scalar or a list to write whole. */
function isBlock(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Write one authored value at `path`, recursing into nested blocks.
 *
 * Recursing is the whole point: `setIn(["workflow","pr"], value)` replaces that
 * NODE, so a sender holding only half of `pr` would drop the other half — and
 * `pr` genuinely has several owners (the Reviewer pane, the reviewer list, and
 * three keys with no editor at all). Arrays are written whole on purpose:
 * `reviewers: []` is a decision ("ask nobody"), and merging it index-by-index
 * into the previous list would make that decision unexpressible.
 */
function applyAuthored(doc: LoadedManifest["doc"], path: string[], value: unknown): void {
  // Absent is not a deletion request — see `saveProjectWorkflow`'s docblock.
  if (value === undefined) return;
  if (isBlock(value)) {
    for (const [k, v] of Object.entries(value)) applyAuthored(doc, [...path, k], v);
    return;
  }
  doc.setIn(path, value);
}

/**
 * Save `workflow` for a project, choosing the manifest or the store as above.
 *
 * The incoming block MERGES into the previous one, key by key and level by
 * level. It used to replace it — an absent key was read as "clear this" — and
 * that is wrong for a reason no caller can work around: over JSON, `undefined`
 * and "not mentioned" are the same thing on the wire, so delete-on-absent makes
 * every partial payload a deletion request against a COMMITTED file, and the
 * only defence is every caller remembering to send the entire block. Nothing
 * enforced that contract, and the app's own settings page broke it: its saved
 * baseline omitted `pr`, so saving the Workflow section deleted `workflow.pr` —
 * reviewers, `requireReview`, `requireChecks` and `reviewAgent` — out of
 * `project.yaml` with no error and no UI able to restore any of it.
 *
 * What that costs is the ability to clear a key back to its profile default by
 * omitting it, and nothing needs it: every control in the settings pane sends
 * its RESOLVED value, so "unset" and "the profile default, written down" are the
 * same effective config. Actually REMOVING a key is an edit to the file, and the
 * config page already opens `project.yaml` in the editor for exactly that.
 */
export async function saveProjectWorkflow(
  deps: { store: Store; projectConfig: ProjectConfigService },
  projectId: string,
  workflow: WorkflowConfig,
): Promise<WorkflowSaveResult | null> {
  const project = await deps.store.getProject(projectId).catch(() => null);
  if (!project) return null;

  // Validating the PAYLOAD, not just the result: the manifest write used to
  // catch a malformed block on the way out, because `saveManifest` re-validates
  // the whole document. A merge can't lean on that any more — an incoming `{}`
  // changes nothing, so a garbage payload would land as a silent no-op instead
  // of an error the caller can see.
  const incoming = WorkflowConfigSchema.parse(workflow);

  const externalDir = deps.store.projectConfigDir(projectId);
  if (!isManifestBacked(project, externalDir)) {
    // The store path makes the same promise as the manifest one, or a project
    // would keep or lose its `pr` block depending on whether the repo happens to
    // carry a `.dispatch/`.
    const merged = mergeWorkflow(project.workflow, incoming);
    const saved = await deps.store.saveProject({ ...project, workflow: merged });
    return { target: "store", project: saved };
  }

  const paths = configPathsFor(project, externalDir);
  // No writable config dir (a `repo` pin with no usable checkout). Fall back to
  // `.data` rather than to a cwd-relative manifest — see `configPathsFor`.
  if (!paths) {
    const merged = mergeWorkflow(project.workflow, incoming);
    const saved = await deps.store.saveProject({ ...project, workflow: merged });
    return { target: "store", project: saved };
  }
  const loaded = await loadManifest(paths);
  // Key-by-key (rather than replacing the whole `workflow` node) so comments
  // attached to the keys we aren't touching survive the write.
  for (const key of WORKFLOW_KEYS) applyAuthored(loaded.doc, ["workflow", key], incoming[key]);
  const manifestPath = await saveManifest(loaded);

  // Re-read from disk so the store, the cached config and every WS client end up
  // agreeing with the file we just wrote — the same path a watcher edit takes.
  await deps.projectConfig.reload(projectId);
  const project2 = (await deps.store.getProject(projectId).catch(() => null)) ?? project;
  return { target: "manifest", project: project2, manifestPath };
}

/** Persist the project's transcript-shell override, or remove it to inherit. */
export async function saveProjectShellFilter(
  deps: { store: Store; projectConfig: ProjectConfigService },
  projectId: string,
  shellFilter: ShellTranscriptFilter | undefined,
): Promise<ProjectSettingSaveResult | null> {
  const project = await deps.store.getProject(projectId).catch(() => null);
  if (!project) return null;

  const externalDir = deps.store.projectConfigDir(projectId);
  if (!isManifestBacked(project, externalDir)) {
    const next = { ...project, shellFilter };
    if (shellFilter === undefined) delete next.shellFilter;
    const saved = await deps.store.saveProject(next);
    return { target: "store", project: saved };
  }

  const paths = configPathsFor(project, externalDir);
  if (!paths) {
    const next = { ...project, shellFilter };
    if (shellFilter === undefined) delete next.shellFilter;
    const saved = await deps.store.saveProject(next);
    return { target: "store", project: saved };
  }
  const loaded = await loadManifest(paths);
  if (shellFilter === undefined) loaded.doc.deleteIn(["defaults", "shellFilter"]);
  else loaded.doc.setIn(["defaults", "shellFilter"], shellFilter);
  const manifestPath = await saveManifest(loaded);
  await deps.projectConfig.reload(projectId);
  const project2 = (await deps.store.getProject(projectId).catch(() => null)) ?? project;
  return { target: "manifest", project: project2, manifestPath };
}

/**
 * A patch to the project layer of every layered setting: the manifest's
 * `defaults:` block plus `spawnChat.autoApprove`. Three states per key, and
 * all three matter:
 *
 *   - absent    — not mentioned; leave the file's answer alone
 *   - `null`    — REMOVE the key, so the project inherits from the app again
 *   - a value   — pin it for this repo
 *
 * `null` is the wire form of "inherit" for the same reason it is on
 * `PUT /api/chats/:id`: JSON cannot carry `undefined`, so absence and deletion
 * need different spellings or a partial payload becomes a deletion request.
 */
export const ProjectDefaultsPatchSchema = z.object({
  defaults: z
    .object({
      harness: HarnessKindSchema.nullable().optional(),
      mode: z.string().trim().min(1).nullable().optional(),
      effort: EffortSchema.nullable().optional(),
      model: z.string().trim().min(1).nullable().optional(),
      showInjectedContext: z.boolean().nullable().optional(),
      shellFilter: ShellTranscriptFilterSchema.nullable().optional(),
    })
    .optional(),
  spawnChat: z
    .object({
      autoApprove: z.boolean().nullable().optional(),
    })
    .optional(),
});
export type ProjectDefaultsPatch = z.infer<typeof ProjectDefaultsPatchSchema>;

/**
 * Write the project layer of the layered settings to `project.yaml`.
 *
 * Manifest ONLY — there is deliberately no `.data` fallback like the workflow
 * and shell-filter writers have. Those two are mirrored into the stored project
 * row (`mergeProject`), which is how the stable and dev instances came to
 * disagree about a project's harness: each had its own row. These keys are
 * read from the loaded config and nowhere else, so a project without a
 * manifest has nowhere to hold them, and the caller is told so rather than
 * handed a write that the next config reload would not know about.
 */
export async function saveProjectDefaults(
  deps: { store: Store; projectConfig: ProjectConfigService },
  projectId: string,
  patch: ProjectDefaultsPatch,
): Promise<ProjectSettingSaveResult | null> {
  const project = await deps.store.getProject(projectId).catch(() => null);
  if (!project) return null;
  const externalDir = deps.store.projectConfigDir(projectId);
  const paths = isManifestBacked(project, externalDir) ? configPathsFor(project, externalDir) : null;
  if (!paths) {
    throw new Error(
      "This project has no config dir yet. Create one (Project config → Create config) " +
        "and these defaults will be written to its project.yaml.",
    );
  }
  const loaded = await loadManifest(paths);
  const apply = (path: string[], value: unknown) => {
    if (value === undefined) return;
    if (value === null) loaded.doc.deleteIn(path);
    else loaded.doc.setIn(path, value);
  };
  for (const [key, value] of Object.entries(patch.defaults ?? {})) apply(["defaults", key], value);
  for (const [key, value] of Object.entries(patch.spawnChat ?? {})) apply(["spawnChat", key], value);
  // An emptied block is removed outright: `defaults: {}` left behind reads as
  // authored config in the file and as nothing in the loader, which is the kind
  // of gap a hand-editor then "fixes" by guessing at keys.
  for (const block of ["defaults", "spawnChat"]) {
    const node = loaded.doc.get(block, true);
    if (isMap(node) && node.items.length === 0) loaded.doc.delete(block);
  }
  const manifestPath = await saveManifest(loaded);
  await deps.projectConfig.reload(projectId);
  const project2 = (await deps.store.getProject(projectId).catch(() => null)) ?? project;
  return { target: "manifest", project: project2, manifestPath };
}
