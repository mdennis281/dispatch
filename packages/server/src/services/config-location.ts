/**
 * config-location — decide WHICH directory is a project's config dir.
 *
 * A project's authored config (`project.yaml`, `instructions/`, `skills/`,
 * `memory/`) lives in exactly one of two places — the repo's committable
 * `.dispatch/`, or an external dir the install owns under its CONFIG root. See
 * {@link ProjectConfigLocationSchema} for why the two never merge.
 *
 * The split this module draws is between READING and PLACING, and it is the
 * whole reason the resolution can stay honest:
 *
 *   - {@link resolveConfigDir} answers "where IS this project's config" from
 *     disk facts alone — an override on the project, then whichever directory
 *     actually holds a manifest. It is synchronous and needs no settings,
 *     because a config dir that exists is not a preference to be overruled. That
 *     matters at the call sites that cannot await: `watchProject`, and the
 *     defensive path in `reload` that must not throw.
 *
 *   - {@link resolvePlacementDir} answers "where should a config dir GO" for a
 *     project that has none yet, and only THAT consults the app-wide default.
 *
 * Reading the setting at placement time rather than at read time is what makes
 * flipping it safe: it re-aims the next scaffold, and cannot orphan the config
 * of a project that already has one.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { configDirFor, pathsForConfigDir, type ProjectPaths } from "@dispatch/cli/core";
import {
  CONFIG_DIR_NAMES,
  MANIFEST_FILE,
  DEFAULT_CONFIG_LOCATION,
  type Project,
  type ProjectConfigLocation,
} from "@dispatch/shared";

/** Where a project's config resolved to, and which rung decided it. */
export interface ResolvedConfigDir {
  /** Absolute path to the config dir (which may not exist yet). */
  dir: string;
  location: ProjectConfigLocation;
  /**
   * Whether a manifest is actually present there. False means the project has
   * no authored config at all — the back-compat case, where the `.data` record
   * is used as-is.
   */
  exists: boolean;
}

/** Whether `dir` holds a `project.yaml`. */
function hasManifest(dir: string): boolean {
  return existsSync(join(dir, MANIFEST_FILE));
}

/**
 * The repo's committed config dir when one is actually there, else null.
 * Distinct from {@link configDirFor}, which names the path a config WOULD take
 * and so can never answer "does this repo carry one".
 */
export function findRepoConfigDir(repoPath: string): string | null {
  for (const name of CONFIG_DIR_NAMES) {
    const dir = join(repoPath, name);
    if (hasManifest(dir)) return dir;
  }
  return null;
}

/**
 * Where a project's config lives right now. Precedence:
 *
 *   1. an explicit `project.configLocation` — the only way to MOVE a project,
 *      in either direction, and it wins even over a dir that exists (that is
 *      what makes it a move rather than a suggestion),
 *   2. a committed `.dispatch/` in the repo — someone put it under version
 *      control on purpose, so it outranks any app-wide default,
 *   3. an external dir that already holds a manifest,
 *   4. neither: the external dir, unresolved. Nothing reads it (there is no
 *      manifest), and naming it here means a project that later gains one is
 *      already pointed at the right place.
 *
 * @param externalDir `Store.projectConfigDir(project.id)`.
 */
export function resolveConfigDir(project: Project, externalDir: string): ResolvedConfigDir {
  if (project.configLocation === "repo") {
    const dir = configDirFor(project.repoPath);
    return { dir, location: "repo", exists: hasManifest(dir) };
  }
  if (project.configLocation === "external") {
    return { dir: externalDir, location: "external", exists: hasManifest(externalDir) };
  }

  const repoDir = findRepoConfigDir(project.repoPath);
  if (repoDir) return { dir: repoDir, location: "repo", exists: true };
  if (hasManifest(externalDir)) {
    return { dir: externalDir, location: "external", exists: true };
  }
  return { dir: externalDir, location: "external", exists: false };
}

/**
 * The resolved config dir as {@link ProjectPaths}, for the manifest EDITORS in
 * `@dispatch/cli/core`.
 *
 * Every server-side manifest write goes through this rather than handing
 * `loadManifest` a repo path. The walk-up that a bare path triggers can only
 * find a config dir inside the repo, so on an external project it would miss the
 * real manifest, synthesize an empty one, and write a `.dispatch/` into the very
 * working tree the project asked to keep clean.
 */
export function configPathsFor(project: Project, externalDir: string): ProjectPaths {
  return pathsForConfigDir(resolveConfigDir(project, externalDir).dir, project.repoPath);
}

/**
 * Where to WRITE a config dir for a project that has none — the app-wide
 * default, unless the project overrides it. A project that already has one is
 * returned unchanged, so scaffolding is never a relocation.
 *
 * @param appDefault `AppSettings.projectConfigLocation`; unset ⇒
 *        {@link DEFAULT_CONFIG_LOCATION}.
 */
export function resolvePlacementDir(
  project: Project,
  externalDir: string,
  appDefault: ProjectConfigLocation | undefined,
): ResolvedConfigDir {
  const current = resolveConfigDir(project, externalDir);
  if (current.exists || project.configLocation) return current;

  const location = appDefault ?? DEFAULT_CONFIG_LOCATION;
  const dir = location === "repo" ? configDirFor(project.repoPath) : externalDir;
  return { dir, location, exists: false };
}
