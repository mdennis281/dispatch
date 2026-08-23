/**
 * slash-commands — what the composer's `/` menu offers, and where it comes from.
 *
 * The obvious implementation is "ask the runtime": the SDK's `supportedCommands()`
 * returns every command it accepts, descriptions and all. The obvious
 * implementation is also unusable on its own, because the menu has to work in a
 * chat that has never sent a message — which is precisely the chat where a
 * `/skill` is most useful, and precisely the chat with no live session to ask.
 *
 * So the catalog has two halves, and each covers the other's blind spot:
 *
 *  - **From disk, always.** Every skill Dispatch would materialize into the
 *    session cwd (project `.dispatch/skills/`, the operator's global dir, the
 *    shipped set) plus whatever the repo itself ships at `<cwd>/.claude/skills/`
 *    and `<cwd>/.claude/commands/`. This is derivable with no session at all, and
 *    it is the half that actually answers "what can I run here".
 *  - **From the runtime, once seen.** The built-ins (`/compact`, `/usage`, …)
 *    cannot be derived from anything on disk. A live session's list is snapshotted
 *    the first time one is available and reused for every later request — built-ins
 *    do not vary by project, so one sighting serves the whole process. Until that
 *    sighting the catalog says `builtinsKnown:false` rather than pretending the
 *    short list is the whole list.
 *
 * Disk wins on name collisions, and deliberately: if `code-review` is both a
 * shipped skill and something the runtime reported, the menu should say where
 * the file is, not label it a built-in.
 */
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  type SlashCommandCatalog,
  type SlashCommandInfo,
  type SlashCommandSource,
} from "@dispatch/shared";
import { parseFrontmatter } from "./project-config.js";
import { readSkillsDir, type AuthoredConfigService } from "./authored-config.js";
import { bundledSkills } from "./bundled-skills.js";

/** Where a session's own harness-discovered commands live, under its cwd. */
const CWD_SKILLS = [".claude/skills", ".agents/skills"];
const CWD_COMMANDS = [".claude/commands", ".agents/commands"];

export interface SlashCommandDeps {
  authored?: AuthoredConfigService;
  /**
   * A project's resolved `.dispatch/skills/` directory, or null when it has no
   * config loaded.
   *
   * The DIRECTORY rather than the already-parsed `ProjectConfig.skills` list,
   * because that list is refreshed by a debounced fs watcher: a skill authored
   * by `config_write` would be missing from the menu for as long as the reload
   * takes, which breaks the one promise the tool makes ("the human can now run
   * it as /name"). The path itself is stable, so reading it fresh costs one
   * `readdir` and is never stale.
   */
  projectSkillsDir?: (projectId: string) => string | null | undefined;
}

/**
 * Assembles the `/` menu. One instance per server, because the built-in snapshot
 * is process-wide state — see the module note.
 */
export class SlashCommandService {
  private readonly deps: SlashCommandDeps;
  /** The last built-in list any live session reported. Null until one has. */
  private builtins: SlashCommandInfo[] | null = null;

  constructor(deps: SlashCommandDeps = {}) {
    this.deps = deps;
  }

  /**
   * Record a live session's command list. Called once per session launch;
   * cheap to repeat, and a later (richer) sighting simply replaces the earlier
   * one. An empty list is IGNORED rather than stored — a runtime that answered
   * "nothing" is almost always one that failed to answer, and caching that would
   * pin the menu to the short list for the life of the process.
   */
  recordRuntimeCommands(commands: readonly SlashCommandInfo[]): void {
    if (!commands.length) return;
    this.builtins = commands.map((c) => ({ ...c, source: "builtin" as const }));
  }

  /** Reset the snapshot (tests only). */
  reset(): void {
    this.builtins = null;
  }

  /**
   * The menu for one chat.
   *
   * @param cwd        the chat's working directory (worktree or repo root), or null
   * @param projectId  the chat's project, for its `.dispatch/skills/`
   */
  async catalog(cwd: string | null, projectId: string | null): Promise<SlashCommandCatalog> {
    const out = new Map<string, SlashCommandInfo>();
    /** First writer of a name wins — the sources are added most-specific-first. */
    const add = (cmd: SlashCommandInfo): void => {
      if (!cmd.name || out.has(cmd.name)) return;
      out.set(cmd.name, cmd);
    };

    const projectDir = projectId ? this.deps.projectSkillsDir?.(projectId) : null;
    if (projectDir) {
      for (const skill of readSkillsDir(projectDir)) {
        add(command(skill.dir, skill.description, "project"));
      }
    }
    if (this.deps.authored) {
      for (const skill of readSkillsDir(this.deps.authored.globalSkillsDir())) {
        add(command(skill.dir, skill.description, "global"));
      }
    }
    for (const skill of bundledSkills()) {
      add(command(skill.dir, skill.description, "shipped"));
    }
    // What the REPO itself ships. Listed after the Dispatch-authored scopes
    // because materialization never clobbers these — a repo skill of the same
    // name is the one that actually runs — but it is added last on purpose: the
    // earlier entries name a file the config tools can edit, and this one does
    // not. Same name, same behaviour, different provenance.
    if (cwd) {
      for (const rel of CWD_SKILLS) {
        for (const skill of readSkillsDir(join(cwd, rel))) {
          add(command(skill.dir, skill.description, "repo"));
        }
      }
      for (const rel of CWD_COMMANDS) {
        for (const cmd of await readCommandsDir(join(cwd, rel))) add(cmd);
      }
    }
    for (const builtin of this.builtins ?? []) add(builtin);

    return {
      commands: [...out.values()].sort((a, b) => a.name.localeCompare(b.name)),
      builtinsKnown: this.builtins !== null,
    };
  }
}

function command(
  name: string,
  description: string | undefined,
  source: SlashCommandSource,
): SlashCommandInfo {
  return { name, description, source, aliases: [] };
}

/**
 * Claude Code's `<cwd>/.claude/commands/` — a flat `<name>.md` (or a nested
 * `<group>/<name>.md`, which is invoked as `/group:name`) whose frontmatter may
 * carry `description` and `argument-hint`.
 */
async function readCommandsDir(dir: string, prefix = ""): Promise<SlashCommandInfo[]> {
  if (!existsSync(dir)) return [];
  let entries: { name: string; isDir: boolean; isFile: boolean }[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
      isFile: e.isFile(),
    }));
  } catch {
    return [];
  }
  const out: SlashCommandInfo[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDir) {
      // One level of nesting only — deeper is not a form Claude Code invokes.
      if (prefix) continue;
      out.push(...(await readCommandsDir(join(dir, entry.name), `${entry.name}:`)));
      continue;
    }
    if (!entry.isFile || !entry.name.toLowerCase().endsWith(".md")) continue;
    const name = `${prefix}${entry.name.replace(/\.md$/i, "")}`;
    try {
      const { data } = parseFrontmatter(await readFile(join(dir, entry.name), "utf8"));
      out.push({
        name,
        description:
          typeof data.description === "string" ? data.description.trim() || undefined : undefined,
        argumentHint:
          typeof data["argument-hint"] === "string"
            ? data["argument-hint"].trim() || undefined
            : undefined,
        source: "repo",
        aliases: [],
      });
    } catch {
      out.push({ name, source: "repo", aliases: [] });
    }
  }
  return out;
}
