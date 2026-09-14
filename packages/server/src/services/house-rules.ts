/**
 * house-rules — the ONE piece of guidance injected into every session
 * unconditionally, and deliberately small.
 *
 * It replaces the memory store's old "standing rules" tier, which force-injected
 * every `user`/`feedback` memory under a 4KB budget. That tier had no owner: any
 * agent's `remember` could grow it, rules were ordered by type then NAME, so the
 * first few long ones alphabetically ate the budget and every later rule was
 * silently cut down to a one-liner. Nobody chose what was always-on.
 *
 * Here a human chooses, in two files capped at {@link HOUSE_RULES_MAX_CHARS} each:
 *
 *  - `global`  — `<config>/global/house-rules.md`, every project on this machine.
 *                The config root, so the stable and dev instances share one copy
 *                and an upgrade never replaces it.
 *  - `project` — `house-rules.md` in the project's config dir (its `.dispatch/`,
 *                or the external config dir when the project keeps config out of
 *                the repo) — beside the instructions it sits above.
 *
 * The cap is enforced on write AND clamped on read: a hand edit past the limit
 * still can't make every session pay for it.
 */
import { join, dirname } from "node:path";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  HOUSE_RULES_MAX_CHARS,
  type HouseRules,
  type HouseRulesFile,
  type HouseRulesScope,
} from "@dispatch/shared";

export const HOUSE_RULES_FILE = "house-rules.md";

export interface HouseRulesOptions {
  /** The user-global root — `<configDir>/global`. */
  globalRoot: string;
  /** A project's config dir (where its house-rules file lives). */
  projectDir: (projectId: string) => string;
}

export class HouseRulesError extends Error {}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export class HouseRulesService {
  constructor(private readonly opts: HouseRulesOptions) {}

  path(scope: HouseRulesScope, projectId?: string): string {
    if (scope === "global") return join(this.opts.globalRoot, HOUSE_RULES_FILE);
    if (!projectId) throw new HouseRulesError("project house rules need a projectId");
    return join(this.opts.projectDir(projectId), HOUSE_RULES_FILE);
  }

  private async readFile(scope: HouseRulesScope, projectId?: string): Promise<HouseRulesFile> {
    const path = this.path(scope, projectId);
    let text = "";
    try {
      if (existsSync(path)) text = normalize(await readFile(path, "utf8"));
    } catch {
      /* unreadable → empty; never a failed launch */
    }
    return { scope, text, path, limit: HOUSE_RULES_MAX_CHARS };
  }

  /** Both files — `project` is null when no project is given. */
  async read(projectId?: string): Promise<HouseRules> {
    return {
      global: await this.readFile("global"),
      project: projectId ? await this.readFile("project", projectId) : null,
    };
  }

  /**
   * Replace one file. Over the cap is refused, not truncated — silently
   * dropping the tail of a rule is exactly the failure this file exists to end.
   * Empty text deletes the file, so "no house rules" leaves nothing behind.
   */
  async write(scope: HouseRulesScope, text: string, projectId?: string): Promise<HouseRulesFile> {
    const next = normalize(text);
    if (next.length > HOUSE_RULES_MAX_CHARS) {
      throw new HouseRulesError(
        `house rules are capped at ${HOUSE_RULES_MAX_CHARS} characters (got ${next.length})`,
      );
    }
    const path = this.path(scope, projectId);
    if (!next) {
      await rm(path, { force: true });
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${next}\n`, "utf8");
    }
    return { scope, text: next, path, limit: HOUSE_RULES_MAX_CHARS };
  }

  /** The system-prompt section, or null when both files are empty. */
  async buildInjection(projectId?: string): Promise<string | null> {
    const { global, project } = await this.read(projectId);
    const clamp = (t: string) =>
      t.length > HOUSE_RULES_MAX_CHARS ? `${t.slice(0, HOUSE_RULES_MAX_CHARS)}…` : t;
    const parts: string[] = [];
    if (global.text) parts.push("### Everywhere", "", clamp(global.text), "");
    if (project?.text) parts.push("### This project", "", clamp(project.text), "");
    if (!parts.length) return null;
    return [
      "## House rules",
      "_Set by the human. These ALWAYS apply, in every chat._",
      "",
      ...parts,
    ]
      .join("\n")
      .trimEnd();
  }

  /** Usage-ledger ids for the files that rode along this turn. */
  async listInjected(projectId?: string): Promise<string[]> {
    const { global, project } = await this.read(projectId);
    return [
      ...(global.text ? ["house-rules:global"] : []),
      ...(project?.text ? ["house-rules:project"] : []),
    ];
  }
}
