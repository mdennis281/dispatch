/**
 * Reading and writing `.dispatch/schedules/<id>.md` — the editor's half of the
 * format the loader (`ProjectConfigService.loadSchedules`) reads.
 *
 * Only fields that differ from their default are written. The file is
 * committed and meant to be read by people; a `catchUp: true` on every
 * schedule is noise that makes the one deliberate `catchUp: false` harder to see.
 */
import { join, relative, resolve, isAbsolute } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import { loadManifest, saveManifest, type ProjectPaths } from "@dispatch/cli/core";
import { DEFAULT_SCHEDULES_DIR, SCHEDULE_ID_RE, type ScheduleInput } from "@dispatch/shared";

/**
 * The file for schedule `id` inside `dir`, or a throw.
 *
 * The id arrives from a URL. The route checks it too, but the check that
 * matters is the one next to the filesystem call — a future caller that skips
 * the route (a tool, the CLI) must not be able to write `../../x.md`. Both the
 * shape AND the resolved containment are checked: the regex alone already
 * excludes separators and dots, the containment check is what still holds if
 * that regex is ever loosened.
 */
function scheduleFilePath(dir: string, id: string): string {
  if (!SCHEDULE_ID_RE.test(id)) throw new Error(`invalid schedule id "${id}"`);
  const root = resolve(dir);
  const path = resolve(root, `${id}.md`);
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`invalid schedule id "${id}"`);
  return path;
}

export function renderScheduleFile(s: ScheduleInput): string {
  const front: Record<string, unknown> = {};
  if (s.name.trim() && s.name.trim() !== s.id) front.name = s.name.trim();
  front.cron = s.cron.trim();
  if (s.timezone) front.timezone = s.timezone;
  if (s.personaId) front.persona = s.personaId;
  if (s.model) front.model = s.model;
  if (s.effort) front.effort = s.effort;
  if (s.harness) front.harness = s.harness;
  if (s.modeId) front.mode = s.modeId;
  if (s.enabled === false) front.enabled = false;
  if (s.catchUp === false) front.catchUp = false;
  return `---\n${stringifyYaml(front).trimEnd()}\n---\n\n${s.prompt.trim()}\n`;
}

/** Write a schedule's file, creating the config dir (and its manifest) if the project has none. */
export async function writeScheduleFile(paths: ProjectPaths, s: ScheduleInput): Promise<string> {
  const loaded = await loadManifest(paths);
  const dir = join(loaded.paths.configDir, DEFAULT_SCHEDULES_DIR);
  await mkdir(dir, { recursive: true });
  const path = scheduleFilePath(dir, s.id);
  await writeFile(path, renderScheduleFile(s), "utf8");
  // Same as a persona or skill: no manifest entry is needed, but a project with
  // no `.dispatch/` yet needs the manifest to exist or nothing anchors the dir.
  if (!loaded.existed) await saveManifest(loaded);
  return path;
}

/** Remove a schedule's file. False when there was none. */
export async function deleteScheduleFile(paths: ProjectPaths, id: string): Promise<boolean> {
  const path = scheduleFilePath(join(paths.configDir, DEFAULT_SCHEDULES_DIR), id);
  if (!existsSync(path)) return false;
  await rm(path);
  return true;
}
