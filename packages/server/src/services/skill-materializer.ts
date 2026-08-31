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
 * - Every dir we write gets a {@link MATERIALIZED_MARKER} stamped with the pid of
 *   the server that wrote it, so a later run can tell its own leftovers from a
 *   repo-owned skill and reclaim them ({@link reclaimOrphans}). Teardown only
 *   runs on a clean turn end; a hard kill used to strand these dirs forever, and
 *   because materialization skips a target that already exists, a stranded copy
 *   also silently pinned that skill at its old content.
 * - The dirs are added to the repo's `.git/info/exclude` while they exist, and
 *   taken back out when they're cleaned up, so they stop showing up as untracked
 *   churn in a project that hasn't gitignored `.claude` without ever hiding what
 *   the user later puts at that path — see `git-exclude.ts`.
 */
import { join, dirname } from "node:path";
import { cp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { SkillConfig } from "@dispatch/shared";
import { excludePathsFromGit, unexcludePathsFromGit } from "./git-exclude.js";

/** Stamp file marking a skill dir as ours to delete. Holds the writing server's id. */
export const MATERIALIZED_MARKER = ".dispatch-materialized";

/**
 * Identifies THIS server run. Both halves do work. The PID PREFIX is what lets a
 * marker be judged across processes, which matters because the two documented
 * instances (the installed app on 4318 and `pnpm dev` on 4319) share `config/` —
 * hence the projects roster, hence a project `path`. Both can have a chat cwd'd
 * to one repo at the same time. The UUID settles the one case a pid can't: a
 * marker bearing OUR pid that we did not write, which a restart inheriting the
 * dead run's pid produces.
 */
const RUN_ID = `${process.pid}-${randomUUID()}`;

/** The effective skills directory the SDK discovers under a session cwd. */
export function skillsTargetDir(cwd: string, providerDir: ".claude" | ".agents" = ".claude"): string {
  return join(cwd, providerDir, "skills");
}

/**
 * Is the server that wrote this marker still running? Reclaiming keys on THIS,
 * not on "the id isn't mine": the other instance's agent may be mid-turn against
 * these very dirs, and its skill set is not necessarily ours (dev materializes
 * this checkout's skills, stable the published payload's), so deleting them
 * would strip a live session of skills this run would never put back.
 *
 * Errs toward "alive" in every ambiguous case — an unparseable marker, or a pid
 * we may not signal (EPERM). Failing that way just means we don't tidy up; the
 * owner's own teardown or a later run gets it. Failing the other way corrupts a
 * running session.
 *
 * One case is NOT ambiguous and must not be treated as such: our own pid on a
 * marker we didn't write. No other live process can hold our pid, so only a dead
 * run can have left it — which is exactly what a hard kill followed by a restart
 * that inherits the pid produces. Reading it as "alive" would pin that skill at
 * its stale body forever, the very failure the marker exists to prevent.
 *
 * The converse — an UNRELATED process inheriting a dead owner's pid — stays
 * undetectable without a heartbeat, and is accepted: it only costs us a reclaim.
 */
export function markerOwnerAlive(marker: string): boolean {
  const id = marker.trim();
  if (id === RUN_ID) return true; // ours, this run — a sibling session's dirs
  const pid = Number.parseInt(id.split("-")[0], 10);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return false; // our pid, not our run → provably stale
  try {
    process.kill(pid, 0); // signal 0 tests existence without delivering anything
    return true;
  } catch (err) {
    // EPERM = it exists, we're just not allowed to signal it (another user).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What a reclamation pass did, so the caller can tell "gone" from "still broken". */
export interface ReclaimResult {
  /** Dirs fully removed. */
  removed: string[];
  /** Dirs we own and tried to remove but couldn't fully delete — possibly wreckage. */
  stuck: string[];
}

/**
 * Delete skill dirs under `base` whose owning server is gone. A dir with no
 * marker is somebody else's (the repo's own skill, or the user's) and is never
 * touched; a dir whose owner is still running is left alone whether that owner
 * is this process or the other instance.
 *
 * A dir that resists deletion is reported as `stuck` rather than dropped: it may
 * now be half-emptied, and letting the caller's "already exists" check skip it
 * would hand the session a skill dir with no `SKILL.md`. Never throws.
 */
export async function reclaimOrphans(base: string): Promise<ReclaimResult> {
  const removed: string[] = [];
  const stuck: string[] = [];
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return { removed, stuck }; // no skills dir yet — nothing to reclaim
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    try {
      if (markerOwnerAlive(await readFile(join(dir, MATERIALIZED_MARKER), "utf8"))) continue;
    } catch {
      continue; // unmarked (or unreadable) → not ours to delete
    }
    try {
      // Retries because this is Windows: a file the dead owner's child process
      // still holds open answers EBUSY/EPERM for a moment after it dies.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      removed.push(dir);
    } catch {
      stuck.push(dir);
    }
  }
  return { removed, stuck };
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
  const { stuck } = await reclaimOrphans(base);
  const created: string[] = [];
  for (const skill of skills) {
    const target = join(base, skill.dir);
    // Never clobber a skill the repo already ships at this path — UNLESS it's a
    // dir we own that resisted reclamation, which may now be half-emptied.
    // Copying over it repairs it; skipping would leave a skill with no body.
    if (existsSync(target) && !stuck.includes(target)) continue;
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
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* best-effort: a stray transient skill dir is harmless */
    }
  }
  // Take the exclude patterns back out with them. Leaving them would outlive the
  // dirs they describe, and the next thing to appear at that path is the user's
  // own override of a bundled skill — which would then be invisible to git.
  await unexcludePathsFromGit(dirs);
}
