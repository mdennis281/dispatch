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
 * Here a human chooses, in two files each capped at the limit resolved for the
 * project (Settings → Agent context; see `resolveAgentContext`):
 *
 *  - `global`  — `<config>/global/house-rules.md`, every project on this machine.
 *                The config root, so the stable and dev instances share one copy
 *                and an upgrade never replaces it.
 *  - `project` — `house-rules.md` in the project's config dir (its `.dispatch/`,
 *                or the external config dir when the project keeps config out of
 *                the repo) — beside the instructions it sits above.
 *
 * The cap is enforced on write AND clamped on read: a hand edit past the limit
 * still can't make every session pay for it. It is a SETTING rather than a
 * constant because the alternative, observed in this very repo, is that a
 * project with more than 1000 chars of genuinely always-on guidance moves it
 * into an instruction file — which is injected on every turn too, uncapped and
 * unlabelled, i.e. exactly the tier the cap was introduced to end.
 */
import { join, dirname } from "node:path";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  DEFAULT_HOUSE_RULES_MODE,
  resolveAgentContext,
  type HouseRules,
  type HouseRulesFile,
  type HouseRulesMode,
  type HouseRulesScope,
  type Project,
  type ResolvedAgentContext,
} from "@dispatch/shared";
import { resolveConfigDir } from "./config-location.js";

export const HOUSE_RULES_FILE = "house-rules.md";

/**
 * Where a project's house rules live: its config dir as resolved from the
 * PROJECT (repo `.dispatch/` or the external dir), falling back to the external
 * dir. Deliberately not `projectConfig.getConfig()?.sourceDir` — that is null
 * whenever `project.yaml` fails to parse, so a typo there would move the one
 * always-on block to the fallback dir and it would silently stop injecting.
 */
export function houseRulesDirFor(project: Project | null, externalDir: string): string {
  return project ? resolveConfigDir(project, externalDir).dir : externalDir;
}

export interface HouseRulesOptions {
  /** The user-global root — `<configDir>/global`. */
  globalRoot: string;
  /**
   * A project's config dir (where its house-rules file lives). Must not depend
   * on the manifest PARSING: a typo in `project.yaml` would otherwise move the
   * file to the fallback dir, and the one always-on block would silently vanish.
   */
  projectDir: (projectId: string) => string | Promise<string>;
  /**
   * The resolved agent-context settings for a project (app layer, then the
   * project's own). Optional so a test — or a build wired before settings
   * exist — falls back to the shipped defaults rather than failing to construct.
   */
  agentContext?: (projectId?: string) => ResolvedAgentContext | Promise<ResolvedAgentContext>;
}

export class HouseRulesError extends Error {}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export class HouseRulesService {
  constructor(private readonly opts: HouseRulesOptions) {}

  /**
   * What is in force for this project. Best-effort: a settings read that throws
   * must degrade to the defaults, never block an injection — the whole point of
   * house rules is that they are the guidance that always arrives.
   */
  private async context(projectId?: string): Promise<ResolvedAgentContext> {
    try {
      if (this.opts.agentContext) return await this.opts.agentContext(projectId);
    } catch {
      /* fall through to defaults */
    }
    return resolveAgentContext(undefined, undefined);
  }

  /** The char cap for one file, as resolved for this project. */
  async limit(projectId?: string): Promise<number> {
    return (await this.context(projectId)).houseRulesLimit.effective;
  }

  /** Whether this project's rules follow the global ones or stand in for them. */
  async mode(projectId?: string): Promise<HouseRulesMode> {
    // No project ⇒ nothing can be replacing anything. Asking the resolver would
    // give the same answer, but saying it here keeps the global-only callers
    // (the app settings pane) from depending on that coincidence.
    if (!projectId) return DEFAULT_HOUSE_RULES_MODE;
    return (await this.context(projectId)).houseRulesMode.effective;
  }

  async path(scope: HouseRulesScope, projectId?: string): Promise<string> {
    if (scope === "global") return join(this.opts.globalRoot, HOUSE_RULES_FILE);
    if (!projectId) throw new HouseRulesError("project house rules need a projectId");
    return join(await this.opts.projectDir(projectId), HOUSE_RULES_FILE);
  }

  private async readFile(
    scope: HouseRulesScope,
    projectId: string | undefined,
    limit: number,
  ): Promise<HouseRulesFile> {
    const path = await this.path(scope, projectId);
    let text = "";
    try {
      if (existsSync(path)) text = normalize(await readFile(path, "utf8"));
    } catch {
      /* unreadable → empty; never a failed launch */
    }
    return { scope, text, path, limit };
  }

  /**
   * Both files plus the mode that decides what happens to them. `project` is
   * null when no project is given.
   *
   * The limit is resolved ONCE here and handed to both files rather than looked
   * up per file: they are the same setting, and two reads could straddle a
   * settings write and report caps that disagree.
   */
  async read(projectId?: string): Promise<HouseRules> {
    const ctx = await this.context(projectId);
    const limit = ctx.houseRulesLimit.effective;
    return {
      global: await this.readFile("global", undefined, limit),
      project: projectId ? await this.readFile("project", projectId, limit) : null,
      mode: projectId ? ctx.houseRulesMode.effective : DEFAULT_HOUSE_RULES_MODE,
    };
  }

  /**
   * Replace one file. Over the cap is refused, not truncated — silently
   * dropping the tail of a rule is exactly the failure this file exists to end.
   * Empty text deletes the file, so "no house rules" leaves nothing behind.
   *
   * A GLOBAL write is checked against the limit resolved WITHOUT a project, i.e.
   * the app-level one. A project that raised its own cap must not become a way
   * to write a machine-wide file that every other project then has clamped on
   * read — which is the silent-truncation failure wearing a different hat.
   */
  async write(scope: HouseRulesScope, text: string, projectId?: string): Promise<HouseRulesFile> {
    const next = normalize(text);
    const limit = await this.limit(scope === "global" ? undefined : projectId);
    if (next.length > limit) {
      throw new HouseRulesError(
        `house rules are capped at ${limit} characters (got ${next.length}). ` +
          `Raise the cap in Settings → Agent context, or move the overflow into a skill.`,
      );
    }
    const path = await this.path(scope, projectId);
    if (!next) {
      await rm(path, { force: true });
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${next}\n`, "utf8");
    }
    return { scope, text: next, path, limit };
  }

  /**
   * The system-prompt section, or null when nothing would be in it.
   *
   * Under `replace` the global file is not merely deprioritised, it is ABSENT:
   * a project that says its rules stand in for the machine's must not ship the
   * agent both and leave it to guess which one lost.
   */
  async buildInjection(projectId?: string): Promise<string | null> {
    const { global, project, mode } = await this.read(projectId);
    const limit = await this.limit(projectId);
    const clamp = (t: string) => (t.length > limit ? `${t.slice(0, limit)}…` : t);
    const replaced = mode === "replace" && Boolean(project?.text);
    const parts: string[] = [];
    if (global.text && !replaced) parts.push("### Everywhere", "", clamp(global.text), "");
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

  /**
   * The injection plus a one-line description of what is in it, for the
   * transcript's "sent context" disclosure.
   *
   * House rules ride in the system prompt rather than in a message, so they were
   * the one always-on injection the transcript could not show — "show sent
   * context" displayed surfaced memories and repo snapshots while the block that
   * applies to EVERY turn stayed invisible. Rendering and labelling live here,
   * together, so the disclosure can't describe one thing while the prompt
   * carries another.
   */
  async describeInjection(
    projectId?: string,
  ): Promise<{ block: string; label: string } | null> {
    const block = await this.buildInjection(projectId);
    if (!block) return null;
    const { global, project, mode } = await this.read(projectId);
    const replaced = mode === "replace" && Boolean(project?.text);
    const scopes: string[] = [];
    if (global.text && !replaced) scopes.push("global");
    if (project?.text) scopes.push("project");
    // Name the suppression explicitly. A reader who set machine-wide rules and
    // sees only "project" needs to know the global file exists and is being
    // stood down here, not wonder whether it failed to load.
    const suffix = replaced && global.text ? ", global replaced" : "";
    return { block, label: `House rules — ${scopes.join(" + ")}${suffix}` };
  }

  /**
   * Usage-ledger ids for the files that rode along this turn — which is why it
   * has to agree with {@link buildInjection} about `replace`: a ledger row for a
   * global file that was suppressed would make it look used on every turn of a
   * project that never sees it.
   */
  async listInjected(projectId?: string): Promise<string[]> {
    const { global, project, mode } = await this.read(projectId);
    const replaced = mode === "replace" && Boolean(project?.text);
    return [
      ...(global.text && !replaced ? ["house-rules:global"] : []),
      ...(project?.text ? ["house-rules:project"] : []),
    ];
  }
}
