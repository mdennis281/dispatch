/**
 * THE MANAGER TOOL REGISTRY — which category server serves each Dispatch tool.
 *
 * Dispatch's own toolbox used to be ONE MCP server called `manager`, so every
 * tool was qualified with that one name and a name told you nothing: `forget`
 * and `approve_pr` read as siblings. The toolbox is now partitioned into eight
 * servers by what a tool is FOR, and a name says which.
 *
 * WHY the names are prefixed. The manager servers are merged into a session's
 * `mcpServers` LAST, so they win every name collision — that is deliberate (a
 * project must not be able to shadow `approve_pr`), and it is exactly why the
 * category names cannot be bare. GitHub's own MCP server is conventionally
 * registered as `github`; `memory`, `chat`, `project` and `mcp` are all
 * plausible third-party names too. Bare names would mean a project that
 * configured `github` silently lost its tools, with no error anywhere — the
 * failure mode this whole file exists to make impossible. `dispatch-` is a
 * namespace nobody else claims.
 *
 * THE REGISTRY IS THE MIGRATION. Because it maps bare tool name → category, it
 * is also what rewrites a stale `terminal` entry in a permission allowlist that
 * still carries the retired server's prefix, and what forward-maps a metrics row
 * recorded under the old name so `create_pr` stays ONE series instead of
 * splitting in two at the rename.
 *
 * Adding a tool: add it here AND to the factory. `manager-mcp.ts` cross-checks
 * the two at COMPILE time in both directions, so a tool that exists in one and
 * not the other fails the build rather than going missing at runtime.
 */

/** Each category server, in the order the catalog lists them. */
export const MANAGER_CATEGORIES = [
  "github",
  "confirm",
  "chat",
  "memory",
  "workspace",
  "mcp",
  "session",
  "project",
] as const;

/** One category of Dispatch tool — also the suffix of its server's name. */
export type ManagerCategory = (typeof MANAGER_CATEGORIES)[number];

/** Namespace every Dispatch-served MCP server sits under. */
export const MANAGER_SERVER_PREFIX = "dispatch-";

/** The server name a category is served under, e.g. "github" → "dispatch-github". */
export function managerServerName(category: ManagerCategory): string {
  return `${MANAGER_SERVER_PREFIX}${category}`;
}

/** Every manager server name, for merge-order and catalog code that needs the set. */
export const MANAGER_SERVER_NAMES: readonly string[] = MANAGER_CATEGORIES.map(managerServerName);

const MANAGER_SERVER_SET: ReadonlySet<string> = new Set(MANAGER_SERVER_NAMES);

/**
 * The single server name every manager tool used to live under. Retained ONLY
 * so the things that must still recognise it do — the allowlist migration, the
 * metrics forward-map, and the CI verifier that fails if it reappears in source.
 * Nothing is served under it.
 */
export const LEGACY_MANAGER_SERVER = "manager";

/**
 * Is this MCP server one of Dispatch's own? Excludes the retired `manager`.
 *
 * The right question for anything deciding what to SERVE or REGISTER — nothing
 * is served under the old name. For anything READING a record that predates the
 * split, use {@link isManagerServerOrLegacy} instead.
 */
export function isManagerServer(server: string | undefined): boolean {
  return server !== undefined && MANAGER_SERVER_SET.has(server);
}

/**
 * The same question, for READ paths that must still recognise history.
 *
 * Chat transcripts are re-rendered from stored rows, so a call recorded before
 * the split is re-read for as long as the chat exists — 267 of 291 transcripts
 * on the install this shipped from. A renderer keyed on {@link isManagerServer}
 * alone silently drops every one of them to generic MCP wire formatting: no
 * shell card for a `terminal` call, no PR grouping, no Dispatch icon. Nothing
 * errors, so nothing reports it.
 *
 * Use this wherever a stored name is being INTERPRETED, and the strict form
 * wherever a name is being produced.
 */
export function isManagerServerOrLegacy(server: string | undefined): boolean {
  return isManagerServer(server) || server === LEGACY_MANAGER_SERVER;
}

/**
 * The category serving each tool, keyed by its bare (wire) name.
 *
 * Seeded from `MANAGER_TOOL_GATE`'s capability bindings, which were already this
 * taxonomy in all but name — a tool's gating service is very nearly a statement
 * of what it is for. Where they differ it is deliberate: `chat_find`/`chat_read`/
 * `project_info` share one `inspect` binding but answer two different questions,
 * and `wait_for_chat` is gated on nothing yet blocks on a PEER chat, which is a
 * chat concern rather than a self-pacing one.
 */
export const MANAGER_TOOL_CATEGORY = {
  /* github — everything that moves a pull request along. */
  create_pr: "github",
  approve_pr: "github",
  watch_pr: "github",
  post_review: "github",
  request_review: "github",
  resolve_thread: "github",

  /* confirm — the two tools whose whole purpose is to put a card in front of a
     human and wait. Both run their own gate, which is why they are also the
     membership of `SELF_GATED_TOOLS`. */
  ask_user: "confirm",
  request_exemption: "confirm",

  /* chat — other chats: start one, wait on one, find one, read one. */
  spawn_chat: "chat",
  wait_for_chat: "chat",
  chat_find: "chat",
  chat_read: "chat",

  /* memory — the durable write surface plus the curation reads. */
  remember: "memory",
  recall: "memory",
  forget: "memory",
  memory_list: "memory",
  memory_search: "memory",
  memory_history: "memory",
  memory_similar: "memory",

  /* workspace — where the work physically happens: trees, shells, running apps. */
  worktree: "workspace",
  terminal: "workspace",
  terminal_output: "workspace",
  run_subapp: "workspace",

  /* mcp — reading and editing the project's own MCP configuration. */
  mcp_list: "mcp",
  mcp_add: "mcp",
  mcp_remove: "mcp",
  prewarm_mcp: "mcp",

  /* session — the agent acting on ITSELF: its clock and its context window. */
  wait: "session",
  context_usage: "session",
  compact_context: "session",

  /* project — what Dispatch knows about a project as a whole. */
  project_info: "project",
} as const satisfies Record<string, ManagerCategory>;

/** Bare name of every tool Dispatch serves. */
export type ManagerToolName = keyof typeof MANAGER_TOOL_CATEGORY;

/** Every bare tool name, for iteration. */
export const MANAGER_TOOL_NAMES = Object.keys(MANAGER_TOOL_CATEGORY) as ManagerToolName[];

/** Bare tool names served by one category. */
export function managerToolsInCategory(category: ManagerCategory): ManagerToolName[] {
  return MANAGER_TOOL_NAMES.filter((name) => MANAGER_TOOL_CATEGORY[name] === category);
}

/** The qualified name an agent sees, e.g. "create_pr" → "mcp__dispatch-github__create_pr". */
export function managerToolQualifiedName(tool: ManagerToolName): string {
  return `mcp__${managerServerName(MANAGER_TOOL_CATEGORY[tool])}__${tool}`;
}

/** Parse `mcp__<server>__<tool>`. Returns undefined for a non-MCP tool name. */
export function parseMcpToolName(
  name: string,
): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice("mcp__".length);
  const i = rest.indexOf("__");
  // A malformed `mcp__foo` (no tool half) is still an MCP call. Attribute the
  // whole remainder to both halves rather than silently reading it as a
  // built-in tool literally named `mcp__foo`.
  return i >= 0 ? { server: rest.slice(0, i), tool: rest.slice(i + 2) } : { server: rest, tool: rest };
}

/** Prefix a stale per-TOOL allowlist entry carries. */
export const LEGACY_MANAGER_TOOL_PREFIX = `mcp__${LEGACY_MANAGER_SERVER}__`;

/**
 * The bare whole-server form — Claude Code writes `mcp__<server>` to allow every
 * tool on a server, and `mcp__<server>__<tool>` to allow one.
 *
 * Spelled separately because it is NOT a prefix match: `mcp__managerx__foo`
 * starts with the same characters and belongs to somebody else entirely.
 */
export const LEGACY_MANAGER_SERVER_ENTRY = `mcp__${LEGACY_MANAGER_SERVER}`;

/**
 * Does this entry name the retired server as a whole? Covers all three spellings
 * a permission list uses for "every tool here": the bare server name, its `__`
 * form, and a `__*` wildcard.
 */
function isLegacyWholeServerEntry(entry: string): boolean {
  return (
    entry === LEGACY_MANAGER_SERVER_ENTRY ||
    entry === LEGACY_MANAGER_TOOL_PREFIX ||
    entry === `${LEGACY_MANAGER_TOOL_PREFIX}*`
  );
}

/** The per-category entries a whole-server permission expands to. */
function expandWholeServer(entry: string): string[] {
  const suffix = entry.slice(LEGACY_MANAGER_SERVER_ENTRY.length);
  return MANAGER_SERVER_NAMES.map((name) => `mcp__${name}${suffix}`);
}

/**
 * Rewrite one reference carrying the retired server's prefix to its category
 * server.
 * Returns null when `name` is not a legacy manager reference, or names a tool
 * that no longer exists — a dead entry is left ALONE rather than guessed at, so
 * a rename never invents a permission for a tool nobody has.
 *
 * Idempotent by construction: an already-migrated name doesn't start with the
 * legacy prefix, so re-running the migration is a no-op rather than a
 * double-rewrite.
 *
 * Handles the trailing-argument form Claude Code's allowlists use — a scoped
 * `terminal(cd *)` entry keeps its `(cd *)` suffix — because dropping it would
 * silently WIDEN a scoped permission into a blanket one.
 */
export function migrateManagerToolName(name: string): string | null {
  if (!name.startsWith(LEGACY_MANAGER_TOOL_PREFIX)) return null;
  const rest = name.slice(LEGACY_MANAGER_TOOL_PREFIX.length);
  const paren = rest.indexOf("(");
  const tool = paren >= 0 ? rest.slice(0, paren) : rest;
  const suffix = paren >= 0 ? rest.slice(paren) : "";
  // A whole-server wildcard covered the whole toolbox; it cannot be expressed as
  // one new name, so the caller expands it (see `migrateToolList`).
  if (!isManagerToolName(tool)) return null;
  return `mcp__${managerServerName(MANAGER_TOOL_CATEGORY[tool])}__${tool}${suffix}`;
}

/** Is this a bare tool name Dispatch still serves? */
export function isManagerToolName(name: string): name is ManagerToolName {
  return Object.prototype.hasOwnProperty.call(MANAGER_TOOL_CATEGORY, name);
}

/** What {@link migrateToolList} changed, for the log line that records it. */
export interface ToolListMigration {
  /** The list after migration — identical array contents when nothing changed. */
  tools: string[];
  /** `old → new` for each entry rewritten. Empty when the list was already current. */
  changed: { from: string; to: string }[];
  /** Legacy entries naming a tool that no longer exists; left untouched. */
  unknown: string[];
}

/**
 * Migrate an allow/deny list of tool names off the retired `manager` server.
 *
 * WHY this is not optional. A permission entry that stops matching does not
 * error — it silently stops granting, and the symptom is a permission prompt on
 * a tool that was approved months ago. Nobody reports that as a regression;
 * they just click through it. So the rename has to carry the allowlists with it.
 *
 * A whole-server permission — the bare server name, its `__` form, or a `__*`
 * wildcard — expands to one entry per category, because the eight servers
 * together are what the one server used to be. Collapsing it to a single
 * category would REVOKE seven eighths of a permission the human granted.
 */
export function migrateToolList(tools: readonly string[]): ToolListMigration {
  const out: string[] = [];
  const changed: { from: string; to: string }[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  for (const entry of tools) {
    // Tested BEFORE the per-tool prefix: the bare server entry is not a prefix
    // match, and the `__` form is a whole-server permission AND a prefix at once.
    if (isLegacyWholeServerEntry(entry)) {
      for (const expanded of expandWholeServer(entry)) {
        changed.push({ from: entry, to: expanded });
        push(expanded);
      }
      continue;
    }
    if (!entry.startsWith(LEGACY_MANAGER_TOOL_PREFIX)) {
      push(entry);
      continue;
    }
    const renamed = migrateManagerToolName(entry);
    if (renamed === null) {
      unknown.push(entry);
      push(entry);
      continue;
    }
    changed.push({ from: entry, to: renamed });
    push(renamed);
  }
  return { tools: out, changed, unknown };
}

/**
 * Does this text still mention the retired server? Used by the boot check that
 * warns about config Dispatch does NOT own (a repo's `.claude/settings.json`),
 * where the honest move is to tell the human rather than rewrite their file.
 */
export function mentionsLegacyManagerServer(text: string): boolean {
  return LEGACY_MENTION_RE.test(text);
}

/**
 * Every spelling of the retired server in a config file: the bare server entry
 * on its own, and its per-tool / `__*` / `__` forms.
 *
 * The trailing `(?!\w)` is what stops a LONGER server name — somebody else's
 * `…managerx…` — from being reported as ours. `String.raw` because a plain
 * template literal eats the backslash: `\w` becomes `w`, the lookahead silently
 * degrades to "not followed by the letter w", and the guard stops guarding.
 *
 * Not a `g` regex either: a shared `lastIndex` makes `.test()` alternate
 * true/false on identical input.
 */
const LEGACY_MENTION_RE = new RegExp(
  String.raw`${LEGACY_MANAGER_SERVER_ENTRY}(?:__[A-Za-z0-9_*]*)?(?!\w)`,
);

/** Every distinct legacy reference in a blob of config, for a warning that names them. */
export function findLegacyManagerMentions(text: string): string[] {
  return [...new Set(text.match(new RegExp(LEGACY_MENTION_RE, "g")) ?? [])];
}
