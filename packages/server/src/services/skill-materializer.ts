/**
 * skill-materializer — bridge a project's authored `.claude-manager/skills/`
 * into a form the Agent SDK actually discovers.
 *
 * The SDK has NO option to point at an arbitrary skills directory: `Options.skills`
 * is only a *filter* (`'all'` | a name list) over skills it has already DISCOVERED,
 * and discovery comes from the session cwd's `.claude/skills/` (loaded via
 * `settingSources: ['project','local']`), from plugins, or from bundled skills.
 * So to make a `.claude-manager/skills/<name>` skill reach a live session we
 * MATERIALIZE it into the effective `<cwd>/.claude/skills/<name>` at launch, then
 * enable it with `skills: 'all'`.
 *
 * The copy is a MERGE, never a clobber: an existing `<cwd>/.claude/skills/<dir>`
 * (a skill the repo itself ships) is left completely untouched; only skills the
 * cwd doesn't already have are written. Exactly the dirs we create are returned so
 * the caller can remove ONLY those on session teardown — a repo-owned skill is
 * never deleted. Best-effort throughout: one skill's failure never aborts the rest
 * and never blocks a turn from starting.
 */
import { join, dirname } from "node:path";
import { cp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { SkillConfig } from "@cm/shared";

/** The effective skills directory the SDK discovers under a session cwd. */
export function skillsTargetDir(cwd: string): string {
  return join(cwd, ".claude", "skills");
}

/**
 * Materialize config-sourced skills into `<cwd>/.claude/skills/`. Returns the
 * absolute paths of the skill dirs this call CREATED (for later cleanup); a skill
 * whose target already exists is skipped (merge, never clobber). Never throws.
 */
export async function materializeSkills(
  cwd: string,
  skills: SkillConfig[],
): Promise<string[]> {
  if (!skills.length) return [];
  const base = skillsTargetDir(cwd);
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
    }
  }
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
