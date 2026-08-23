/**
 * The vocabulary for AUTHORED GUIDANCE — instructions and skills — and for the
 * `/` commands they become.
 *
 * Memory answers "what does this project know". Instructions and skills answer
 * "how should work be done here", and until now they were the one half an agent
 * could READ (they arrive in the system prompt) but never WRITE: authoring one
 * meant hand-placing a file under `.dispatch/` and hand-editing `project.yaml`.
 * The `mcp__dispatch-config__*` tools close that, so the same session that
 * learns a procedure can record it as a skill.
 *
 * THE THREE SCOPES exist because guidance has three different lifetimes:
 *   - `project` — committed in the repo's `.dispatch/`. Travels with the code,
 *     reviewed like the code. The default, and the only one a teammate sees.
 *   - `global`  — this machine's shared config dir. Applies to EVERY project
 *     here and survives an app upgrade (config/ is never replaced). For the
 *     operator's own house style, which has no business in someone's repo.
 *   - `shipped` — committed in the Dispatch repo itself and delivered by an
 *     upgrade. How the manager teaches agents about the manager. READ-ONLY at
 *     runtime: writing it would be overwritten by the next publish, so the tools
 *     refuse rather than let a fact quietly evaporate.
 *
 * PRECEDENCE is most-specific-wins, and it is spelled the same way in both
 * pipelines: `project > global > shipped`. Skills honour it by MATERIALIZATION
 * ORDER (the copy never clobbers an existing target, so the first writer of a
 * name owns it); instructions honour it by INJECTION ORDER (broadest first, so
 * the most specific guidance is the last word the model reads).
 */
import * as z from "zod";

/** Which authored-guidance kind a tool call is about. */
export const AuthoredKindSchema = z.enum(["instruction", "skill"]);
export type AuthoredKind = z.infer<typeof AuthoredKindSchema>;

/**
 * Where an authored item lives. Ordered BROADEST FIRST, which is also the order
 * skills are materialized and instructions are injected — see the module note.
 */
export const AUTHORED_SCOPES = ["shipped", "global", "project"] as const;
export const AuthoredScopeSchema = z.enum(AUTHORED_SCOPES);
export type AuthoredScope = z.infer<typeof AuthoredScopeSchema>;

/** Scopes a write/delete may target — `shipped` is delivered by upgrade, not authored. */
export const WRITABLE_AUTHORED_SCOPES = ["project", "global"] as const;
export const WritableAuthoredScopeSchema = z.enum(WRITABLE_AUTHORED_SCOPES);
export type WritableAuthoredScope = z.infer<typeof WritableAuthoredScopeSchema>;

/** Is this scope one the config tools may write? */
export function isWritableScope(scope: string): scope is WritableAuthoredScope {
  return (WRITABLE_AUTHORED_SCOPES as readonly string[]).includes(scope);
}

/** One authored instruction or skill, as the config tools and the UI list it. */
export const AuthoredItemSchema = z.object({
  kind: AuthoredKindSchema,
  scope: AuthoredScopeSchema,
  /** Kebab-case identity within its (kind, scope) — the filename stem / skill dir. */
  name: z.string(),
  /** One-line summary: a skill's frontmatter `description`, or an instruction's first line. */
  description: z.string().optional(),
  /** Absolute path to the file that defines it (the `SKILL.md` for a skill). */
  path: z.string(),
  /** Whether the config tools may overwrite/delete it (false for `shipped`). */
  writable: z.boolean(),
  /**
   * Only meaningful for `project` instructions: an instruction file is inert
   * until `project.yaml` lists it, so a stray file in `instructions/` is
   * reported as unregistered rather than silently counted as active.
   */
  active: z.boolean().default(true),
});
export type AuthoredItem = z.infer<typeof AuthoredItemSchema>;

/**
 * Filename stem rules for an authored item.
 *
 * Deliberately strict: the name becomes a path segment, a skill DIRECTORY, and
 * (for a skill) the `/command` you type. Anything with a separator, a dot, or a
 * leading dash in it is rejected at the schema rather than sanitized — a
 * silently-renamed skill is a skill the author can't find again.
 */
export const AUTHORED_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Normalize a free-form title into a legal authored name, or null if nothing survives. */
export function toAuthoredName(raw: string): string | null {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return AUTHORED_NAME_RE.test(slug) ? slug : null;
}

/* ------------------------------------------------------------ / commands */

/**
 * Where a `/` command in the composer menu came from.
 *
 * `repo` is distinct from `project`: a repo may ship its own `.claude/skills/`
 * and `.claude/commands/` that Dispatch never wrote and does not manage, and
 * those are typable too. Showing them under the same label as Dispatch-authored
 * ones would imply the config tools can edit them, which they can't.
 */
export const SlashCommandSourceSchema = z.enum([
  "project",
  "global",
  "shipped",
  "repo",
  "builtin",
]);
export type SlashCommandSource = z.infer<typeof SlashCommandSourceSchema>;

/** One entry in the composer's `/` menu. */
export const SlashCommandInfoSchema = z.object({
  /** Command name WITHOUT the leading slash. */
  name: z.string(),
  description: z.string().optional(),
  /** e.g. "<file>" — rendered dim after the name. */
  argumentHint: z.string().optional(),
  source: SlashCommandSourceSchema,
  /** Alternate spellings that resolve here (built-ins only). */
  aliases: z.array(z.string()).default([]),
});
export type SlashCommandInfo = z.infer<typeof SlashCommandInfoSchema>;

export const SlashCommandCatalogSchema = z.object({
  commands: z.array(SlashCommandInfoSchema).default([]),
  /**
   * False when the harness has never reported its built-in command list in this
   * server process — the menu then holds skills only. Said out loud so the UI can
   * explain a short list instead of looking broken.
   */
  builtinsKnown: z.boolean().default(false),
});
export type SlashCommandCatalog = z.infer<typeof SlashCommandCatalogSchema>;

/**
 * Rank + filter a command list against what has been typed after the slash.
 *
 * Shared with the client so the menu's ordering is testable without a DOM. A
 * prefix match outranks an interior one, and a name match outranks a
 * description match — typing "sk" should surface `/skill` before a built-in
 * whose blurb happens to say "skip".
 */
export function matchSlashCommands(
  commands: readonly SlashCommandInfo[],
  query: string,
): SlashCommandInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  const scored: { cmd: SlashCommandInfo; rank: number }[] = [];
  for (const cmd of commands) {
    const name = cmd.name.toLowerCase();
    const alias = cmd.aliases.find((a) => a.toLowerCase().startsWith(q));
    let rank: number | null = null;
    if (name.startsWith(q)) rank = 0;
    else if (alias) rank = 1;
    else if (name.includes(q)) rank = 2;
    else if ((cmd.description ?? "").toLowerCase().includes(q)) rank = 3;
    if (rank !== null) scored.push({ cmd, rank });
  }
  return scored
    .sort((a, b) => a.rank - b.rank || a.cmd.name.localeCompare(b.cmd.name))
    .map((s) => s.cmd);
}
