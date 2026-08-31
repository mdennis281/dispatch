/**
 * skill-materializer — bridge a project's authored `.dispatch/skills/`
 * into a form the Agent SDK actually discovers.
 *
 * The SDK has NO option to point at an arbitrary skills directory: `Options.skills`
 * is only a *filter* (`'all'` | a name list) over skills it has already DISCOVERED,
 * and discovery comes from the session cwd's `.claude/skills/` (loaded via
 * `settingSources: ['project','local']`), from plugins, or from bundled skills.
 * So to make a `.dispatch/skills/<name>` skill reach a live session we
 * MATERIALIZE it into the effective `<cwd>/.claude/skills/<name>` at launch, then
 * enable it with `skills: 'all'`.
 *
 * The copy is a MERGE, never a clobber: an existing `<cwd>/.claude/skills/<dir>`
 * (a skill the repo itself ships) is left completely untouched; only skills the
 * cwd doesn't already have are written. Exactly the dirs we create are returned so
 * the caller can remove ONLY those on session teardown — a repo-owned skill is
 * never deleted. Best-effort throughout: one skill's failure never aborts the rest
 * and never blocks a turn from starting.
 *
 * Two things make the copy invisible rather than merely temporary:
 *
 * - Every dir we write gets a {@link MATERIALIZED_MARKER} stamped with the id of
 *   the server run that wrote it, so a LATER run can tell its own leftovers from
 *   a repo-owned skill and reclaim them ({@link reclaimOrphans}). Teardown only
 *   runs on a clean turn end; a hard kill used to strand these dirs forever, and
 *   because materialization skips a target that already exists, a stranded copy
 *   also silently pinned that skill at its old content.
 * - The dirs are added to the repo's `.git/info/exclude`, so they stop showing up
 *   as untracked churn in a project that hasn't gitignored `.claude` — see
 *   `git-exclude.ts` for why it's the exclude file and not `.gitignore`.
 */
import { join, dirname } from "node:path";
import { cp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { SkillConfig } from "@dispatch/shared";
import { excludePathsFromGit } from "./git-exclude.js";

/** Stamp file marking a skill dir as ours to delete. Contains the writing run's id. */
export const MATERIALIZED_MARKER = ".dispatch-materialized";

/**
 * Identifies THIS server run. Orphan reclamation keys on it rather than on a
 * timestamp so that two chats sharing one project dir don't sweep each other:
 * within a run every session writes the same id and skips the others' dirs,
 * while anything left by a previous run is unambiguously abandoned.
 */
const RUN_ID = `${process.pid}-${randomUUID()}`;

/** The effective skills directory the SDK discovers under a session cwd. */
export function skillsTargetDir(cwd: string, providerDir: ".claude" | ".agents" = ".claude"): string {
  return join(cwd, providerDir, "skills");
}

/**
 * Delete skill dirs under `base` that a PREVIOUS server run materialized. A dir
 * with no marker is somebody else's (a repo-owned skill, or a user's own) and is
 * never touched; a dir marked with the current run id belongs to a live sibling
 * session. Returns the dirs removed. Never throws.
 */
export async function reclaimOrphans(base: string): Promise<string[]> {
  const removed: string[] = [];
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return removed; // no skills dir yet — nothing to reclaim
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    try {
      if ((await readFile(join(dir, MATERIALIZED_MARKER), "utf8")).trim() === RUN_ID) continue;
    } catch {
      continue; // unmarked (or unreadable) → not ours to delete
    }
    try {
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      /* a locked leftover just stays; the merge below will reuse it */
    }
  }
  return removed;
}

/**
 * Materialize config-sourced skills into `<cwd>/.claude/skills/`. Returns the
 * absolute paths of the skill dirs this call CREATED (for later cleanup); a skill
 * whose target already exists is skipped (merge, never clobber). Never throws.
 */
export async function materializeSkills(
  cwd: string,
  skills: SkillConfig[],
  providerDir: ".claude" | ".agents" = ".claude",
): Promise<string[]> {
  if (!skills.length) return [];
  const base = skillsTargetDir(cwd, providerDir);
  // Before deciding what "already exists" means, take back anything a crashed
  // run left behind — otherwise its stale copy reads as a repo-owned skill.
  await reclaimOrphans(base);
  const created: string[] = [];
  for (const skill of skills) {
    const target = join(base, skill.dir);
    // Never clobber a skill the repo already ships at this path.
    if (existsSync(target)) continue;
    try {
      await mkdir(base, { recursive: true });
      if (skill.layout === "dir") {
        // Copy the whole source skill dir (SKILL.md + any supporting files) so
        // relative references inside the skill keep resolving.
        await cp(dirname(skill.path), target, { recursive: true });
      } else {
        // Flat single-file skill → a `<dir>/SKILL.md`.
        await mkdir(target, { recursive: true });
        await writeFile(join(target, "SKILL.md"), await readFile(skill.path));
      }
      created.push(target);
    } catch {
      // A partial/half-written target is ours to remove — never leave a broken
      // dir behind, and never report it as "created" (nothing to clean up).
      try {
        await rm(target, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      continue;
    }
    // Separately guarded: a skill that copied fine but couldn't be stamped is
    // still a working skill. Losing the stamp costs us a future reclaim, which
    // is a far smaller thing than rolling back a good copy.
    try {
      await writeFile(join(target, MATERIALIZED_MARKER), RUN_ID, "utf8");
    } catch {
      /* unstamped — teardown still removes it via the returned list */
    }
  }
  // Deliberately NOT awaited. This walks up to `.git` and may write a file, and
  // it sits on the path a turn starts on — where it would be pure added latency
  // for something purely cosmetic. Worst case the new dirs are visible in git
  // status for a few milliseconds before the exclude lands.
  void excludePathsFromGit(cwd, created);
  return created;
}

/** Remove only the skill dirs {@link materializeSkills} created. Never throws. */
export async function cleanupMaterializedSkills(dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort: a stray transient skill dir is harmless */
    }
  }
}
