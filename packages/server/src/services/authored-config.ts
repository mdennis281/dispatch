/**
 * authored-config — reading and WRITING the instructions and skills a session
 * is given, across the three scopes defined in `@dispatch/shared/authoring`.
 *
 * Two things live here because they are the same problem seen from both ends:
 *
 *  1. **The APP-LEVEL halves of the pipeline.** A project's `.dispatch/` is
 *     already loaded by `ProjectConfigService`; this adds the two scopes it has
 *     no business knowing about — `shipped` (committed in the Dispatch repo,
 *     delivered by upgrade) and `global` (this machine's shared config dir,
 *     applying to every project on it). The broker merges all three.
 *
 *  2. **The WRITE surface** behind `mcp__dispatch-config__*`. Authoring a skill
 *     used to mean hand-placing `.dispatch/skills/<name>/SKILL.md`; authoring an
 *     instruction ALSO meant hand-editing `project.yaml`, because an instruction
 *     file is inert until the manifest lists it. That second step is the one
 *     everybody forgets, so `write()` does it — see {@link registerInstruction}.
 *
 * WHY `shipped` skills are already handled elsewhere: `bundled-skills.ts` got
 * there first and the broker already calls it. It is left as the shipped-SKILLS
 * reader and re-exported through here, so there is still exactly one function
 * that answers "what skills does Dispatch itself ship". Shipped INSTRUCTIONS are
 * new and read here.
 *
 * Everything is best-effort on the READ paths — a malformed skill or an
 * unreadable dir yields fewer items, never a failed session launch. WRITE paths
 * throw with a real reason, because the caller is a tool that has to report it.
 */
import { join, dirname, resolve, basename } from "node:path";
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SkillConfigSchema,
  AUTHORED_NAME_RE,
  type AuthoredItem,
  type AuthoredKind,
  type AuthoredScope,
  type SkillConfig,
  type WritableAuthoredScope,
} from "@dispatch/shared";
import { parseFrontmatter } from "./project-config.js";
import { bundledSkills } from "./bundled-skills.js";

/** Dir name (under the server package root) holding shipped instructions. */
const SHIPPED_INSTRUCTIONS_DIR = "instructions";

/** Sub-dirs of the user-global root. */
export const GLOBAL_SKILLS_DIR = "skills";
export const GLOBAL_INSTRUCTIONS_DIR = "instructions";

/* ------------------------------------------------------------------ shared */

/** First non-blank, non-heading line of a markdown body — an instruction's blurb. */
function summarize(text: string): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^#+\s*/, "").trim();
    if (line) return line.length > 160 ? `${line.slice(0, 157)}…` : line;
  }
  return undefined;
}

/**
 * Locate a directory that sits at the SERVER PACKAGE ROOT, from this module's
 * location — which differs between `tsx src/…` in dev (→ `src/services/`) and
 * `node dist/…` in production (→ `dist/services/`). Same walk-up as
 * `bundled-skills.ts` uses, and for the same reason: encoding either layout
 * makes one of the two silently find nothing.
 */
function findPackageDir(name: string): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/* ------------------------------------------------------------------ skills */

/**
 * Every skill in one directory, in both supported layouts (`<dir>/SKILL.md` and
 * a flat `<name>.md`). A near-twin of `ProjectConfigService.loadSkills`, kept
 * separate rather than shared because that one's job is also to REPORT each
 * malformed skill into the project's config-errors list, which the app-level
 * scopes have nowhere to show. Here a bad skill is simply skipped.
 */
export function readSkillsDir(dir: string): SkillConfig[] {
  if (!existsSync(dir)) return [];
  let entries: { name: string; isDir: boolean; isFile: boolean }[];
  try {
    // Sync on purpose: this feeds `buildOptions`, which is already on the hot
    // path of starting a turn, and these dirs hold a handful of files.
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
      isFile: e.isFile(),
    }));
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const out: SkillConfig[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const src = entry.isDir
      ? { path: join(dir, entry.name, "SKILL.md"), skillDir: entry.name, layout: "dir" as const }
      : entry.isFile && entry.name.toLowerCase().endsWith(".md")
        ? {
            path: join(dir, entry.name),
            skillDir: entry.name.replace(/\.md$/i, ""),
            layout: "flat" as const,
          }
        : null;
    if (!src || !existsSync(src.path) || seen.has(src.skillDir)) continue;
    try {
      const { data } = parseFrontmatter(readFileSync(src.path, "utf8"));
      const name =
        typeof data.name === "string" && data.name.trim() ? data.name.trim() : src.skillDir;
      const parsed = SkillConfigSchema.safeParse({
        id: src.skillDir,
        name,
        description:
          typeof data.description === "string" ? data.description.trim() || undefined : undefined,
        dir: src.skillDir,
        path: src.path,
        layout: src.layout,
      });
      if (!parsed.success) continue;
      seen.add(src.skillDir);
      out.push(parsed.data);
    } catch {
      /* an unreadable skill is one fewer skill, never a failed launch */
    }
  }
  return out;
}

/* ------------------------------------------------------------ instructions */

/** One instruction file read off disk. */
export interface InstructionFile {
  name: string;
  path: string;
  text: string;
  description?: string;
}

/**
 * `README.md` documents the directory for a human; it is not guidance for the
 * model. Skipped by name rather than by a convention nobody would discover,
 * because a config dir without a README is a config dir nobody can author into
 * — and paying for that README on every turn of every session is absurd.
 */
const NOT_AN_INSTRUCTION = new Set(["readme.md"]);

/** Every `*.md` instruction in a directory, name-sorted so injection order is stable. */
export async function readInstructionsDir(dir: string): Promise<InstructionFile[]> {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter(
        (e) =>
          e.isFile() &&
          e.name.toLowerCase().endsWith(".md") &&
          !NOT_AN_INSTRUCTION.has(e.name.toLowerCase()),
      )
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
  const out: InstructionFile[] = [];
  for (const file of names) {
    try {
      const text = (await readFile(join(dir, file), "utf8")).replace(/\r\n/g, "\n").trimEnd();
      if (!text) continue;
      const name = file.replace(/\.md$/i, "");
      out.push({ name, path: join(dir, file), text, description: summarize(text) });
    } catch {
      /* skip */
    }
  }
  return out;
}

/* ------------------------------------------------------------------ service */

export interface AuthoredConfigOptions {
  /**
   * The user-global root — `<configDir>/global`. Its `skills/` and
   * `instructions/` sub-dirs apply to EVERY project on this machine. Lives in
   * the CONFIG root rather than `.data` deliberately: config is shared by the
   * stable and dev instances and is never replaced by an upgrade, which is
   * exactly the lifetime "my own house style" wants.
   */
  globalRoot: string;
}

/**
 * The app-level (non-project) half of authored guidance, plus the write surface
 * the config tools drive. Project-scope writes are delegated in by the caller —
 * see {@link ProjectAuthoringTarget} — so this service never needs to know how a
 * project's config dir is discovered.
 */
export class AuthoredConfigService {
  private readonly globalRoot: string;
  /** Memoized shipped instructions — a published payload can't change under us. */
  private shippedInstructions: InstructionFile[] | null = null;

  constructor(opts: AuthoredConfigOptions) {
    this.globalRoot = opts.globalRoot;
  }

  globalSkillsDir(): string {
    return join(this.globalRoot, GLOBAL_SKILLS_DIR);
  }
  globalInstructionsDir(): string {
    return join(this.globalRoot, GLOBAL_INSTRUCTIONS_DIR);
  }

  /**
   * App-level skills in MATERIALIZATION ORDER — global before shipped, so an
   * operator's own `code-review` skill quietly wins over a shipped one of the
   * same name (materialization skips a target that already exists). The caller
   * puts project skills ahead of both.
   */
  appSkills(): SkillConfig[] {
    return [...readSkillsDir(this.globalSkillsDir()), ...bundledSkills()];
  }

  /** Shipped instructions — `packages/server/instructions/*.md`, memoized. */
  async shipped(): Promise<InstructionFile[]> {
    if (this.shippedInstructions) return this.shippedInstructions;
    const dir = findPackageDir(SHIPPED_INSTRUCTIONS_DIR);
    this.shippedInstructions = dir ? await readInstructionsDir(dir) : [];
    return this.shippedInstructions;
  }

  /** Reset the shipped memo (tests only). */
  resetCache(): void {
    this.shippedInstructions = null;
  }

  /**
   * The app-level system-prompt append: shipped instructions first, then global.
   * Null when there are none, so an untouched install injects nothing.
   *
   * Broadest-first is the whole point — the project's own instructions are
   * appended AFTER this block by the broker, so the most specific guidance is
   * the last thing the model reads.
   */
  async buildInjection(): Promise<string | null> {
    const sections = [
      ...(await this.shipped()),
      ...(await readInstructionsDir(this.globalInstructionsDir())),
    ];
    const text = sections
      .map((s) => s.text)
      .filter(Boolean)
      .join("\n\n");
    if (!text.trim()) return null;
    return [
      "## Global instructions",
      "_Apply to every project on this machine (Dispatch-shipped + operator-authored)._",
      "",
      text.length > MAX_GLOBAL_INJECTION_CHARS
        ? `${text.slice(0, MAX_GLOBAL_INJECTION_CHARS)}\n\n… (global instructions truncated)`
        : text,
    ].join("\n");
  }

  /** Ids of the app-level instruction files riding along, for the usage ledger. */
  async listInjected(): Promise<string[]> {
    const shipped = (await this.shipped()).map((i) => `shipped:${i.name}`);
    const global = (await readInstructionsDir(this.globalInstructionsDir())).map(
      (i) => `global:${i.name}`,
    );
    return [...shipped, ...global];
  }

  /* ------------------------------------------------------------- listing */

  /** Every app-level item of a kind (both `shipped` and `global`). */
  async list(kind: AuthoredKind): Promise<AuthoredItem[]> {
    if (kind === "skill") {
      return [
        ...bundledSkills().map((s) => toSkillItem(s, "shipped")),
        ...readSkillsDir(this.globalSkillsDir()).map((s) => toSkillItem(s, "global")),
      ];
    }
    return [
      ...(await this.shipped()).map((i) => toInstructionItem(i, "shipped")),
      ...(await readInstructionsDir(this.globalInstructionsDir())).map((i) =>
        toInstructionItem(i, "global"),
      ),
    ];
  }

  /* --------------------------------------------------------------- write */

  /** Create/overwrite a user-global item. Returns the file written. */
  async write(kind: AuthoredKind, name: string, body: string, description?: string): Promise<string> {
    assertName(name);
    if (kind === "skill") {
      const dir = join(this.globalSkillsDir(), name);
      await mkdir(dir, { recursive: true });
      const path = join(dir, "SKILL.md");
      await writeFile(path, renderSkill(name, description, body), "utf8");
      return path;
    }
    await mkdir(this.globalInstructionsDir(), { recursive: true });
    const path = join(this.globalInstructionsDir(), `${name}.md`);
    await writeFile(path, `${body.trimEnd()}\n`, "utf8");
    return path;
  }

  /**
   * Remove a user-global item. False when it wasn't there.
   *
   * EVERY layout that exists is removed, not the first one found. A skill can
   * legally be `skills/<name>/SKILL.md` OR a flat `skills/<name>.md`, and both
   * can exist at once — `write()` always creates the directory form, so one
   * `config_write` over a hand-authored flat file produces the pair.
   * `readSkillsDir` dedupes them (the directory sorts first and wins), so reads
   * look right; a first-match delete would then report success, leave the flat
   * file behind, and the `/` menu would keep offering the OLD body under the
   * same name with nothing anywhere reporting a problem.
   */
  async remove(kind: AuthoredKind, name: string): Promise<boolean> {
    assertName(name);
    const targets =
      kind === "skill"
        ? [join(this.globalSkillsDir(), name), join(this.globalSkillsDir(), `${name}.md`)]
        : [join(this.globalInstructionsDir(), `${name}.md`)];
    let removed = false;
    for (const target of targets) {
      if (!existsSync(target)) continue;
      await rm(target, { recursive: true, force: true });
      removed = true;
    }
    return removed;
  }
}

/** Cap on the app-level append, mirroring the project one so neither can run away. */
export const MAX_GLOBAL_INJECTION_CHARS = 16_000;

/* ----------------------------------------------------------------- helpers */

function toSkillItem(skill: SkillConfig, scope: AuthoredScope): AuthoredItem {
  return {
    kind: "skill",
    scope,
    name: skill.dir,
    description: skill.description,
    path: skill.path,
    writable: scope !== "shipped",
    active: true,
  };
}

function toInstructionItem(
  file: InstructionFile,
  scope: AuthoredScope,
  active = true,
): AuthoredItem {
  return {
    kind: "instruction",
    scope,
    name: file.name,
    description: file.description,
    path: file.path,
    writable: scope !== "shipped",
    active,
  };
}

export { toSkillItem, toInstructionItem };

/** Reject a name that would escape its directory or produce an untypable command. */
export function assertName(name: string): void {
  if (!AUTHORED_NAME_RE.test(name)) {
    throw new Error(
      `"${name}" is not a valid name — use lowercase letters, digits and dashes ` +
        "(starting with a letter or digit), up to 64 characters.",
    );
  }
}

/**
 * A SKILL.md with the frontmatter the SDK requires.
 *
 * `name` and `description` are not decoration: skill discovery reads the
 * description to decide whether to surface the skill at all, so a skill written
 * without one is a skill the model never reaches for.
 */
export function renderSkill(name: string, description: string | undefined, body: string): string {
  const desc = (description ?? "").replace(/\r?\n/g, " ").trim();
  const front = ["---", `name: ${name}`, `description: ${desc || name}`, "---", ""];
  return `${front.join("\n")}\n${body.trim()}\n`;
}

/** Path a project-scope item is written to, relative to the config dir. */
export function projectRelPath(kind: AuthoredKind, name: string): string {
  return kind === "skill" ? `skills/${name}/SKILL.md` : `instructions/${name}.md`;
}

/** Last path segment, tolerant of either separator. */
export function baseName(path: string): string {
  return basename(path.replace(/\\/g, "/"));
}
