/**
 * bundled-skills — skills the MANAGER itself ships to every session.
 *
 * A project's own `.dispatch/skills/` teaches an agent about that project.
 * These teach it about the manager: workflows that exist because Dispatch
 * is the harness (today, how MCP servers are configured here — a thing an agent
 * has no way to know, and will otherwise get wrong by writing `.mcp.json`).
 *
 * They reuse the project-skill pipeline wholesale: each is a normal `SKILL.md`
 * directory described as a {@link SkillConfig}, and the broker materializes them
 * into the session cwd's `.claude/skills/` alongside project skills, with the
 * same never-clobber merge and the same teardown cleanup. That ordering matters —
 * because materialization skips any skill dir that already exists, a project (or
 * the repo itself) can override a bundled skill just by shipping its own skill of
 * the same name, and never has one forced on it.
 *
 * Discovery is filesystem-based rather than a hardcoded list so adding a skill is
 * just adding a directory under `packages/server/skills/`.
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SkillConfigSchema, type SkillConfig } from "@dispatch/shared";

/** Directory name (under the server package root) holding bundled skills. */
const SKILLS_DIR_NAME = "skills";

/**
 * Locate `packages/server/skills/` from this module's location, which differs
 * between `tsx src/…` in dev (→ `src/services/`) and `node dist/…` in production
 * (→ `dist/services/`). Rather than encode either layout, walk up looking for the
 * dir — it sits at the package root in both.
 */
function findBundledSkillsDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, SKILLS_DIR_NAME);
    if (existsSync(join(candidate))) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Pull `name` / `description` out of a SKILL.md's YAML frontmatter. */
function readFrontmatter(path: string): { name?: string; description?: string } {
  try {
    const text = readFileSync(path, "utf8");
    if (!text.startsWith("---")) return {};
    const end = text.indexOf("\n---", 3);
    if (end < 0) return {};
    const out: { name?: string; description?: string } = {};
    for (const line of text.slice(4, end).split("\n")) {
      const at = line.indexOf(":");
      if (at <= 0) continue;
      const key = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
      if (key === "name") out.name = value;
      else if (key === "description") out.description = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Memoized so repeated session launches don't re-stat the skills dir. */
let cached: SkillConfig[] | null = null;

/**
 * Every manager-bundled skill, as {@link SkillConfig}s ready to hand to
 * `materializeSkills`. Returns `[]` when the skills dir is missing (an unusual
 * build layout must degrade to "no bundled skills", never to a crashed session).
 */
export function bundledSkills(): SkillConfig[] {
  if (cached) return cached;
  const base = findBundledSkillsDir();
  if (!base) return (cached = []);

  const out: SkillConfig[] = [];
  try {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(base, entry.name, "SKILL.md");
      if (!existsSync(path)) continue;
      const front = readFrontmatter(path);
      const parsed = SkillConfigSchema.safeParse({
        id: entry.name,
        name: front.name ?? entry.name,
        description: front.description,
        dir: entry.name,
        path,
        layout: "dir",
      });
      if (parsed.success) out.push(parsed.data);
    }
  } catch {
    /* unreadable skills dir → no bundled skills */
  }
  return (cached = out);
}

/** Reset the memo (tests only). */
export function resetBundledSkillsCache(): void {
  cached = null;
}
