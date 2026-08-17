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

/**
 * What to order by. Every catalog answers all three or says which it can't
 * (see {@link applyRegistryQuery}); the KEY is shared, the field it reads is
 * per-catalog, exactly like `since`.
 *
 * `recent` is the default because a roster is read to find what just happened
 * far more often than to find what happened first — but it is now SAID rather
 * than left to whatever order git or a `Map` happened to produce.
 */
export const RegistrySortSchema = z.enum(["recent", "created", "name"]);
export type RegistrySort = z.infer<typeof RegistrySortSchema>;

export const RegistryOrderSchema = z.enum(["asc", "desc"]);
export type RegistryOrder = z.infer<typeof RegistryOrderSchema>;

/**
 * The boolean narrowings a catalog can offer.
 *
 * Each is a question about ONE record that the catalog answers with an accessor
 * (below), so a facet means the same thing to the REST route, the MCP tool and
 * the modal's checkbox. A catalog that has no answer for a facet does not get to
 * ignore it — see the "unsupported facet" rule in {@link applyRegistryQuery}.
 */
export const RegistryFacetSchema = z.enum([
  /** Terminals: running a command, or holding a background one. */
  "active",
  /** Terminals: a record with no process behind it — readable, not runnable. */
  "archived",
  /** Worktrees: the branch still holds work that isn't on the trunk. */
  "unmerged",
  /** Worktrees: no owning chat. The state the registry exists to make visible. */
  "unattributed",
]);
export type RegistryFacet = z.infer<typeof RegistryFacetSchema>;

/**
 * `1`/`true` and `0`/`false`, and NOTHING else.
 *
 * A query string carries strings, so a flag has to be read out of one — but
 * anything unrecognized is passed through UNCHANGED so `z.boolean()` rejects it
 * and the caller gets a 400. `Boolean("no")` is `true`, which is exactly the
 * kind of quiet mistranslation the rest of this module refuses to make.
 */
const FlagSchema = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const s = v.trim().toLowerCase();
  if (s === "1" || s === "true") return true;
  if (s === "0" || s === "false") return false;
  return v;
}, z.boolean().optional());

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
  /**
   * Unset = `recent`. Deliberately NOT `.default()`: a default lands in the
   * OUTPUT type as a required field, which would make every hand-built query —
   * every MCP tool arg, every test literal — restate a sort it doesn't care
   * about. The one place that reads it resolves it instead (`sortRegistry`).
   */
  sort: RegistrySortSchema.optional(),
  /** Unset = newest-first for `recent`/`created`, A→Z for `name`. */
  order: RegistryOrderSchema.optional(),
  /* -- facets. `true` keeps only matches, `false` keeps only non-matches. -- */
  active: FlagSchema,
  archived: FlagSchema,
  unmerged: FlagSchema,
  unattributed: FlagSchema,
  /** Who created the record (`agent`/`ui`, plus `tool`/`harness`/`external`). */
  origin: z.string().optional(),
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
    sort: get("sort"),
    order: get("order"),
    // Raw, not coerced: FlagSchema does the reading, and anything it doesn't
    // recognize has to reach `z.boolean()` intact so it fails rather than
    // becoming `true` on the way past.
    active: get("active"),
    archived: get("archived"),
    unmerged: get("unmerged"),
    unattributed: get("unattributed"),
    origin: get("origin"),
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
 * What a catalog can answer about one of its records. Every accessor is
 * optional, and OMITTING one is a statement: it means this catalog cannot
 * answer that question (see the unsupported-facet rule below).
 */
export interface RegistryAccessors<T> {
  text?: (item: T) => Array<string | undefined>;
  /** The stamp `since` and `sort: "recent"` read (last activity / last sighting). */
  touchedAt?: (item: T) => number | undefined;
  /** The stamp `sort: "created"` reads. */
  createdAt?: (item: T) => number | undefined;
  /** The label `sort: "name"` reads (a shell's name, a worktree's branch). */
  name?: (item: T) => string | undefined;
  /** The value `origin` is compared against. */
  origin?: (item: T) => string | undefined;
  /** One predicate per facet this catalog can answer. */
  facets?: Partial<Record<RegistryFacet, (item: T) => boolean>>;
}

/**
 * Apply scope + text + `since` + facets, then sort, then `limit`.
 *
 * `since` compares against whatever recency stamp the catalog considers
 * "touched" (a terminal's last activity, a worktree's last sighting), which is
 * why it's supplied by the caller rather than read off a fixed field. `sort`
 * and the facets follow the same shape for the same reason.
 *
 * ── Two orderings that are decisions, not accidents ──────────────────────────
 *
 * SORT BEFORE LIMIT. `limit` used to slice whatever order the source happened to
 * produce, so "the newest 20" was twenty arbitrary rows with a plausible name.
 *
 * AN UNSUPPORTED FACET RETURNS NOTHING. Asking `?unmerged=1` of the terminals
 * catalog is the same class of mistake as `?scope=chat` with no `chatId`, and
 * gets the same answer: empty. Dropping the filter and returning every terminal
 * would present an unfiltered list as a filtered one — which for `active` means
 * showing idle shells to someone who asked only for the busy ones.
 */
export function applyRegistryQuery<T extends RegistryScoped>(
  items: T[],
  query: RegistryQuery,
  opts: RegistryAccessors<T> = {},
): T[] {
  const out = items.filter((item) => {
    if (!matchesScope(item, query)) return false;
    if (!matchesText(opts.text?.(item) ?? [], query.q)) return false;
    if (query.since !== undefined) {
      const t = opts.touchedAt?.(item);
      if (t === undefined || t < query.since) return false;
    }
    if (query.origin !== undefined) {
      if (!opts.origin || opts.origin(item) !== query.origin) return false;
    }
    for (const facet of RegistryFacetSchema.options) {
      const want = query[facet];
      if (want === undefined) continue;
      const answer = opts.facets?.[facet];
      if (!answer || answer(item) !== want) return false;
    }
    return true;
  });
  sortRegistry(out, query, opts);
  return query.limit === undefined ? out : out.slice(0, query.limit);
}

/**
 * Order `items` in place per `query.sort`/`query.order`.
 *
 * A record the catalog can't supply the sort key for sorts LAST whichever
 * direction is asked for — a worktree with no `createdAt` is not the newest
 * thing in the list, it is a thing with no date, and letting `undefined` win
 * "newest first" is how an unattributed tree ends up at the top of every view.
 */
function sortRegistry<T>(items: T[], query: RegistryQuery, opts: RegistryAccessors<T>): void {
  // The ONE place the default lives (see the schema's `sort` comment). `recent`
  // because a roster is read to find what just happened far more often than to
  // find what happened first.
  const sort = query.sort ?? "recent";
  const asc = query.order ? query.order === "asc" : sort === "name";
  const dir = asc ? 1 : -1;
  if (sort === "name") {
    if (!opts.name) return;
    const key = (i: T): string => opts.name!(i) ?? "";
    items.sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      if (!x || !y) return x === y ? 0 : x ? -1 : 1;
      return dir * x.localeCompare(y, undefined, { sensitivity: "base" });
    });
    return;
  }
  const stamp = sort === "created" ? opts.createdAt : opts.touchedAt;
  if (!stamp) return;
  items.sort((a, b) => {
    const [x, y] = [stamp(a), stamp(b)];
    if (x === undefined || y === undefined) {
      return x === y ? 0 : x === undefined ? 1 : -1;
    }
    return dir * (x - y);
  });
}
