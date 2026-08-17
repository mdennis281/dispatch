/**
 * Registry query vocabulary — the ONE filter shape the catalogs speak.
 *
 * Worktrees, terminals and (later) PRs are all long-lived resources that belong
 * to a chat, inside a project, inside the app. Before this module each of them
 * was queried differently: `/api/worktrees` demanded a `projectId`,
 * `/api/terminals` demanded a `chatId`, and neither could answer "everything, on
 * this machine" — which is exactly the question the Workspace modal asks and the
 * question an agent asks when it has lost track of a shell it started.
 *
 * Defining the predicate once, here, is what keeps the visual filters and the
 * programmatic ones (REST query string, MCP tool args) from drifting into two
 * subtly different answers to the same question.
 */
import * as z from "zod";

/**
 * How wide to look.
 *
 * `chat` and `project` both degrade to EMPTY rather than to `all` when their id
 * is missing. A filter that silently widens is worse than one that returns
 * nothing: "show me this chat's shells" answered with every shell on the machine
 * reads as data, not as a missing parameter.
 */
export const RegistryScopeSchema = z.enum(["chat", "project", "all"]);
export type RegistryScope = z.infer<typeof RegistryScopeSchema>;

export const RegistryQuerySchema = z.object({
  scope: RegistryScopeSchema.default("all"),
  projectId: z.string().optional(),
  chatId: z.string().optional(),
  /** Free-text match; which fields it covers is documented per catalog. */
  q: z.string().optional(),
  /** Only records touched at or after this epoch-ms. */
  since: z.number().int().optional(),
  /** Cap the result set. Unset = no cap (catalogs are small by construction). */
  limit: z.number().int().positive().max(1000).optional(),
});
export type RegistryQuery = z.infer<typeof RegistryQuerySchema>;

/** The scope fields every catalog record carries. */
export interface RegistryScoped {
  projectId?: string;
  chatId?: string;
}

/** Anything that answers `get(name)` — `URLSearchParams`, without naming it. */
interface QueryLike {
  get(name: string): string | null;
}

/**
 * A malformed filter, as a value rather than an exception.
 *
 * `parseRegistryQuery` validates with zod and therefore THROWS on `?scope=nope`
 * — which, called inline in a route handler, surfaces as a 500 for what is
 * plainly a client error. Routes use this and answer 400.
 */
export class RegistryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryQueryError";
  }
}

/**
 * Parse a request's query params into a RegistryQuery.
 *
 * Takes either the plain object Fastify hands a handler or anything with a
 * `get()` (a `URLSearchParams`), so the routes don't each hand-roll the same
 * `Number(...)` / empty-string-is-absent coercion. Typed structurally rather
 * than against `URLSearchParams` because this package compiles without the DOM
 * or node libs — it is shared with the browser.
 */
export function parseRegistryQuery(
  input: QueryLike | Record<string, unknown> | undefined,
): RegistryQuery {
  const get = (k: string): string | undefined => {
    if (!input) return undefined;
    const source = input as Partial<QueryLike> & Record<string, unknown>;
    const raw = typeof source.get === "function" ? source.get(k) : source[k];
    if (raw === null || raw === undefined) return undefined;
    const s = String(raw).trim();
    return s === "" ? undefined : s;
  };
  const num = (k: string): number | undefined => {
    const s = get(k);
    if (s === undefined) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };
  // An explicit `scope` wins; otherwise the narrowest id present implies it, so
  // the pre-existing `?chatId=` / `?projectId=` callers keep working unchanged.
  const chatId = get("chatId");
  const projectId = get("projectId");
  const scope = get("scope") ?? (chatId ? "chat" : projectId ? "project" : "all");
  const parsed = RegistryQuerySchema.safeParse({
    scope,
    projectId,
    chatId,
    q: get("q"),
    since: num("since"),
    limit: num("limit"),
  });
  if (!parsed.success) {
    // Rejected rather than coerced: a filter we quietly "fixed" would answer a
    // different question than the one asked, which for a scope means showing
    // somebody else's shells.
    throw new RegistryQueryError(
      `invalid query: ${parsed.error.issues.map((i) => `${i.path.join(".") || "?"} ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

/** True when `rec` falls inside the query's scope. */
export function matchesScope(rec: RegistryScoped, query: RegistryQuery): boolean {
  switch (query.scope) {
    case "chat":
      return !!query.chatId && rec.chatId === query.chatId;
    case "project":
      return !!query.projectId && rec.projectId === query.projectId;
    case "all":
      return true;
  }
}

/**
 * Case-insensitive substring match over a record's searchable fields. An empty
 * or absent needle matches everything, so callers can pass `query.q` straight
 * through without branching.
 */
export function matchesText(fields: Array<string | undefined>, q?: string): boolean {
  const needle = q?.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => f && f.toLowerCase().includes(needle));
}

/**
 * Apply scope + text + `since` + `limit` in one pass.
 *
 * `since` compares against whatever recency stamp the catalog considers
 * "touched" (a terminal's last activity, a worktree's last sighting), which is
 * why it's supplied by the caller rather than read off a fixed field.
 */
export function applyRegistryQuery<T extends RegistryScoped>(
  items: T[],
  query: RegistryQuery,
  opts: { text?: (item: T) => Array<string | undefined>; touchedAt?: (item: T) => number | undefined } = {},
): T[] {
  const out = items.filter((item) => {
    if (!matchesScope(item, query)) return false;
    if (!matchesText(opts.text?.(item) ?? [], query.q)) return false;
    if (query.since !== undefined) {
      const t = opts.touchedAt?.(item);
      if (t === undefined || t < query.since) return false;
    }
    return true;
  });
  return query.limit === undefined ? out : out.slice(0, query.limit);
}
