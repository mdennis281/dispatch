/**
 * mode-editor — bind the three MODE scopes to one session, for the `mode_*`
 * tools.
 *
 * A mode is a named permission posture (`permissionMode`) with an optional
 * instruction overlay. It has three homes, and this is the one place that knows
 * all three:
 *
 *  - **project** — `.dispatch/modes/<id>.yaml`, committed with the repo and
 *    loaded by `ProjectConfigService`. The source of truth: it wins on an id
 *    collision, exactly as the broker's `resolveMode` says.
 *  - **global** — the `.data` store, which is what `GET /api/modes` and the
 *    Settings UI have always edited. NOT the shared config dir, unlike global
 *    skills and instructions: modes predate the authored-config split and the
 *    UI still reads them from the store, so writing them anywhere else would
 *    produce a mode the composer's picker can't see.
 *  - **builtin** — the fixed ids (`plan`, `auto`, `yolo`, …) the broker falls
 *    back to when nothing defines one. Listed so an agent can name them, never
 *    written: they have no file to write.
 *
 * Reads go to the DIRECTORY for project modes rather than the loaded config,
 * for the same reason `listProjectItems` does: the config is refreshed by a
 * debounced watcher, so a `mode_list` straight after a `mode_write` would not
 * show the mode it just created and invite a second write.
 *
 * `configPaths` must name the project's MAIN working copy, never a session
 * worktree — same rule, same reason, as `authoring-editor` and
 * `mcp-config-editor`: committed config edited in a throwaway tree is
 * discarded with it.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadManifest, type ProjectPaths } from "@dispatch/cli/core";
import {
  DEFAULT_MODES_DIR,
  PermissionModeSchema,
  type ModeConfig,
  type PermissionMode,
} from "@dispatch/shared";
import { slugifyConfigName } from "../project-config.js";

/** Where a mode is defined. Ordered most-specific-first, which is lookup order. */
export const MODE_SCOPES = ["project", "global", "builtin"] as const;
export type ModeScope = (typeof MODE_SCOPES)[number];

/** Scopes a write/delete may target — `builtin` has no file behind it. */
export type WritableModeScope = "project" | "global";

/** One mode, as the tools list and read it. */
export interface ModeRecord {
  id: string;
  name: string;
  scope: ModeScope;
  permissionMode: PermissionMode;
  description?: string;
  instructions?: string;
  /** Absolute file for a project mode; absent for the other two scopes. */
  path?: string;
}

/** The subset of the store the editor needs — `.data` modes are `global`. */
export interface ModeStore {
  listModes(): Promise<ModeConfig[]>;
  getMode(id: string): Promise<ModeConfig | null>;
  saveMode(mode: ModeConfig): Promise<ModeConfig>;
  deleteMode(id: string): Promise<void>;
}

export interface ModeEditorDeps {
  store: ModeStore;
  /** The project's resolved config dir, or null for a session with no project. */
  configPaths: ProjectPaths | null;
  /** The broker's built-in id → posture table (`BUILTIN_MODE_PERMISSION`). */
  builtin: Record<string, PermissionMode>;
}

/** The per-session mode binding the `mode_*` tools consume. */
export interface ManagerMcpModes {
  /** Whether this session has a project to write `.dispatch/modes/` into. */
  hasProject: boolean;
  /** Every mode across every scope, most-specific scope first. */
  list(): Promise<ModeRecord[]>;
  /** One mode. Without `scope`, the copy actually in effect for that id. */
  read(id: string, scope?: ModeScope): Promise<ModeRecord | null>;
  write(input: {
    scope: WritableModeScope;
    name: string;
    permissionMode: PermissionMode;
    description?: string;
    instructions?: string;
  }): Promise<ModeRecord>;
  remove(id: string, scope: WritableModeScope): Promise<boolean>;
}

/** The id a mode name becomes — the same slug the config loader derives. */
export function modeIdFor(name: string): string {
  return slugifyConfigName(name);
}

/** Build the per-session mode binding. */
export function createModeEditor(deps: ModeEditorDeps): ManagerMcpModes {
  const { store, configPaths, builtin } = deps;

  const projectModes = async (): Promise<ModeRecord[]> => {
    if (!configPaths) return [];
    const dir = await modesDir(configPaths);
    return readModesDir(dir);
  };

  const globalModes = async (): Promise<ModeRecord[]> =>
    (await store.listModes().catch(() => [] as ModeConfig[]))
      // A `.data` row can carry a project scope from an older writer; those
      // are not this editor's to report as "global", and the config dir is
      // the source of truth for project modes anyway.
      .filter((m) => m.scope !== "project")
      .map((m) => fromStore(m));

  const builtinModes = (): ModeRecord[] =>
    Object.entries(builtin).map(([id, permissionMode]) => ({
      id,
      name: id,
      scope: "builtin" as const,
      permissionMode,
    }));

  return {
    hasProject: Boolean(configPaths),

    async list() {
      return [...(await projectModes()), ...(await globalModes()), ...builtinModes()];
    },

    async read(id, scope) {
      const order: ModeScope[] = scope ? [scope] : [...MODE_SCOPES];
      for (const s of order) {
        const pool =
          s === "project" ? await projectModes() : s === "global" ? await globalModes() : builtinModes();
        const found = pool.find((m) => m.id === id);
        if (found) return found;
      }
      return null;
    },

    async write({ scope, name, permissionMode, description, instructions }) {
      const id = modeIdFor(name);
      if (!id) throw new Error(`"${name}" leaves nothing to make a mode id from.`);
      if (scope === "project") {
        if (!configPaths) throw new Error("this session has no project to write a mode into");
        const dir = await modesDir(configPaths);
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${id}.yaml`);
        // Key order is the order a human reads the file in: what it's called,
        // when to use it, what it permits, then the overlay.
        const doc: Record<string, unknown> = { name };
        if (description) doc.description = description;
        doc.permissionMode = permissionMode;
        if (instructions) doc.instructions = instructions;
        await writeFile(path, stringifyYaml(doc), "utf8");
        return { id, name, scope, permissionMode, description, instructions, path };
      }
      const saved = await store.saveMode({
        id,
        name,
        description,
        permissionMode,
        instructions,
        scope: "global",
      });
      return fromStore(saved);
    },

    async remove(id, scope) {
      if (scope === "project") {
        if (!configPaths) throw new Error("this session has no project to delete a mode from");
        const dir = await modesDir(configPaths);
        // Either extension: the loader accepts both, so a hand-authored `.yml`
        // is a real mode this must be able to remove.
        let removed = false;
        for (const path of [join(dir, `${id}.yaml`), join(dir, `${id}.yml`)]) {
          if (!existsSync(path)) continue;
          await rm(path, { force: true });
          removed = true;
        }
        return removed;
      }
      const existing = await store.getMode(id).catch(() => null);
      if (!existing || existing.scope === "project") return false;
      await store.deleteMode(id);
      return true;
    },
  };
}

/* ----------------------------------------------------------------- helpers */

function fromStore(m: ModeConfig): ModeRecord {
  return {
    id: m.id,
    name: m.name,
    scope: "global",
    permissionMode: m.permissionMode,
    description: m.description,
    instructions: m.instructions,
  };
}

/** `<configDir>/<modes:>` — honouring the manifest's dir override. */
async function modesDir(paths: ProjectPaths): Promise<string> {
  const loaded = await loadManifest(paths);
  const v = loaded.doc.get("modes");
  return join(paths.configDir, typeof v === "string" && v.trim() ? v.trim() : DEFAULT_MODES_DIR);
}

/**
 * Every mode in one directory. A near-twin of `ProjectConfigService.loadModes`,
 * kept separate for the same reason `readSkillsDir` is separate from
 * `loadSkills`: that one's job is also to REPORT each malformed file into the
 * project's config-errors list. Here a bad file is one fewer mode.
 */
export async function readModesDir(dir: string): Promise<ModeRecord[]> {
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: ModeRecord[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    try {
      const data = (parseYaml(await readFile(join(dir, file), "utf8")) ?? {}) as Record<
        string,
        unknown
      >;
      const name =
        typeof data.name === "string" && data.name.trim() ? data.name : file.replace(/\.ya?ml$/i, "");
      const id = slugifyConfigName(name);
      const perm = PermissionModeSchema.safeParse(data.permissionMode);
      if (!id || !perm.success || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name,
        scope: "project",
        permissionMode: perm.data,
        description: typeof data.description === "string" ? data.description.trim() || undefined : undefined,
        instructions:
          typeof data.instructions === "string" ? data.instructions.trim() || undefined : undefined,
        path: join(dir, file),
      });
    } catch {
      /* skip */
    }
  }
  return out;
}
