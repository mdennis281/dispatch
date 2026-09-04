/**
 * MemoryService — per-project agent memory (the durable, cross-chat facts).
 *
 * Mirrors the pattern the human's own Claude Code uses: a folder of one-fact
 * markdown files + a generated `MEMORY.md` index, scoped to a PROJECT. Each
 * memory is a single `.md` file with YAML-ish frontmatter (`name` /
 * `description` / `type`) over a markdown body. The index (one line per memory)
 * is injected into every session at start (read); the
 * `mcp__dispatch-memory__remember|recall|forget` tools append/query/remove it (write);
 * the Memory panel curates it.
 *
 * Storage location (resolved per-project via {@link dir}) is always the config
 * dir's `memory/`, and WHERE that is depends on the project (see
 * `ProjectConfigLocationSchema`):
 *   - config in the repo → the committable `.dispatch/memory/`. Memories are
 *     reviewed and shipped like code, and `workflow.memory: commit` lands them.
 *   - config EXTERNAL (the default) → `<configDir>/projects/<id>/memory/`, which
 *     is the same directory a project with no config dir has always used. That
 *     is not a coincidence: the external config dir was chosen to BE the
 *     project's entity dir precisely so adopting it moves no memory files.
 *   - a project with no config dir at all → that same store dir (back-compat,
 *     unchanged).
 * Nothing downstream branches on this. `MemoryCommitter` and `MemoryHistory`
 * both already decline when the memory dir resolves outside the repo, so an
 * external project simply has no commits to make or read.
 * A one-time transparent {@link migrateProject} copies any legacy `.data`
 * memories that aren't already present in the repo dir when a project gains a
 * config dir (idempotent; the originals are left in place).
 *
 * No DB — everything is filesystem. Writes/deletes serialize per-project (so
 * concurrent `remember` calls can't corrupt the regenerated index) and every
 * mutation publishes a `memory-update` / `memory-deleted` bus event so open UIs
 * live-update.
 */
import { join, basename } from "node:path";
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  ProjectMemorySchema,
  MemoryTypeSchema,
  type ProjectMemory,
  type MemoryType,
} from "@dispatch/shared";
import { KeyedMutex } from "../store/fsq.js";
import type { Store } from "../store/index.js";
import type { EventBus } from "../bus.js";
import {
  MemoryStatsStore,
  usefulness,
  type MemoryStat,
  type MemoryAccessKind,
} from "./memory-stats.js";

/** The generated index filename (excluded from the memory listing). */
const INDEX_FILE = "MEMORY.md";

/* -------------------------------------------------- start-of-session injection */

/** Per-rule body clamp (chars) in the injected "Standing rules" section. */
const RULE_BODY_MAX = 700;
/** Total budget (chars) for rule BODIES before later rules degrade to one-liners. */
const RULES_BODY_BUDGET = 4000;
/** How many lookup facts to show as a visible sample (most-used, then recent). */
const FACTS_SAMPLE = 6;
/** Topic-map areas shown before collapsing the tail into "+N more". */
const AREA_LIMIT = 12;

/* ------------------------------------------------- per-turn auto-surface tuning
 * Calibrated against a real 141-memory project store, using the normalized 0–100
 * scores from {@link scoreMemory}. Measured there: a squarely on-topic turn
 * scores its best match ~21–52, while an off-topic turn ("can you bump the
 * dependencies and commit") tops out around 8 and the worst near-miss seen ("run
 * the tests and fix whatever is failing" → `ci-runner-pnpm-store-corruption`)
 * reaches ~19. So FULL sits clear of that noise ceiling and MIN just under it:
 * a confident match arrives whole, a plausible one arrives as a one-liner it
 * costs ~15 tokens to offer, and the long tail waits for an explicit `recall`. */

/** Below this normalized score a memory isn't mentioned at all. */
const SURFACE_MIN_SCORE = 16;
/** At/above this score a match is confident enough to earn its full body. */
const SURFACE_FULL_SCORE = 25;
/** Most full-body memories per turn, however many clear the bar. */
const FULL_LIMIT = 2;
/** The runner-up needs this share of the leader's score to also come in full. */
const FULL_RUNNERUP_RATIO = 0.8;
/** Per-memory body clamp for a full-body surface (p90 body here is ~5.8KB). */
const SURFACE_BODY_MAX = 1500;
/** A full body clipped below this by the budget is demoted to a pointer instead. */
const SURFACE_BODY_MIN = 400;
/** Total chars one turn's surfaced block may spend (bodies + pointer lines). */
const SURFACE_CHAR_BUDGET = 3200;
/** Most memories referenced in one turn's block, across both tiers. */
const SURFACE_LIMIT = 6;
/** Most `[[link]]` neighbours one turn may pull in behind its real matches. */
const SURFACE_MAX_LINKS = 2;

/**
 * Cluster memories into topic areas by the first token of their kebab-case name
 * (`steam-*` → "steam") and render "area (count)" sorted by count desc. Bounded
 * to {@link AREA_LIMIT} areas with a "+N more" tail so the map stays compact even
 * when a project has hundreds of facts. Empty string when there's nothing to map.
 */
export function clusterAreas(memories: readonly { name: string }[]): string {
  const counts = new Map<string, number>();
  for (const m of memories) {
    const area = (m.name.split("-")[0] || m.name).trim();
    if (!area) continue;
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const shown = sorted.slice(0, AREA_LIMIT);
  const parts = shown.map(([area, n]) => `${area} (${n})`);
  const rest = sorted.length - shown.length;
  if (rest > 0) parts.push(`+${rest} more`);
  return parts.join(", ");
}

/**
 * The slice of {@link ProjectConfigService} MemoryService needs to relocate a
 * project's memory into its committable `.dispatch/memory/` source of
 * truth. A minimal interface (not the concrete service) keeps the dependency
 * one-way and lets tests inject a trivial stub.
 */
export interface MemoryConfigResolver {
  /** The loaded config for a project, or null when it has no `.dispatch/`. */
  getConfig(projectId: string): { memoryDir?: string | null } | null | undefined;
}

export interface MemoryServiceOptions {
  store: Store;
  bus: EventBus;
  now?: () => number;
  /**
   * Optional project-config resolver. When a project has a `.dispatch/`
   * config, memory reads/writes target its repo `memory/` dir (the source of
   * truth) instead of the `.data` store. Omitted → always the `.data` store.
   */
  projectConfig?: MemoryConfigResolver;
  /**
   * Access-telemetry store backing usefulness ranking + the injection's
   * "most-used" sample. Defaults to a {@link MemoryStatsStore} over the same
   * `.data` store (so production needs no wiring); tests may inject their own.
   */
  stats?: MemoryStatsStore;
}

/** Input for creating/updating a memory (the write surface). */
export interface MemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

/* ------------------------------------------------------------------ helpers */

/** Kebab-case slug — the memory's stable identity/filename within its project. */
export function slugifyMemoryName(name: string): string {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

/** Collapse a (possibly multi-line) description to a single trimmed line. */
function oneLine(text: string): string {
  return String(text).replace(/\s*\r?\n\s*/g, " ").trim();
}

/** Serialize a memory to its on-disk markdown (frontmatter + body). */
function serialize(m: {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  updatedAt?: number;
}): string {
  const body = m.body.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  const front = [
    "---",
    `name: ${m.name}`,
    `description: ${oneLine(m.description)}`,
    `type: ${m.type}`,
  ];
  // Persist the write time so recency survives a re-read (ranking + UI "edited"
  // display). Older files without it simply read back as `updatedAt: undefined`.
  if (typeof m.updatedAt === "number" && Number.isFinite(m.updatedAt)) {
    front.push(`updatedAt: ${Math.trunc(m.updatedAt)}`);
  }
  front.push("---", "");
  return front.join("\n") + (body ? `${body}\n` : "");
}

interface ParsedFile {
  name?: string;
  description?: string;
  type?: string;
  updatedAt?: number;
  body: string;
}

/** Parse a memory markdown file into its frontmatter fields + body. */
function parseFile(raw: string): ParsedFile {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { body: text.trim() };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { body: text.trim() };
  const front = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n+/, "").trimEnd();
  const out: ParsedFile = { body };
  for (const line of front.split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key === "name") out.name = value;
    else if (key === "description") out.description = value;
    else if (key === "type") out.type = value;
    else if (key === "updatedAt" || key === "updated") {
      const n = Number(value);
      if (Number.isFinite(n)) out.updatedAt = Math.trunc(n);
    }
  }
  return out;
}

/**
 * Extract `[[wikilink]]` targets from a memory body, normalized to name slugs.
 * These weave the per-project memories into a graph: surfacing one memory can
 * pull in the neighbours it explicitly points at.
 */
export function extractLinks(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const slug = slugifyMemoryName(m[1] ?? "");
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

/**
 * Clamp a memory body to `max` chars with a truncation note, so a single huge
 * memory can't blow the MCP tool-result token limit (recall) or bloat a turn's
 * context (auto-surface). The full body stays readable in the Memory view.
 */
export function clampBody(body: string, max: number): string {
  if (body.length <= max) return body;
  return (
    body.slice(0, max) +
    `\n\n…[truncated ${body.length - max} more chars — open this memory in the Memory view for the full text]`
  );
}

/** A memory plus its relevance score + why it surfaced (for ranked search). */
export interface ScoredMemory extends ProjectMemory {
  /** Relevance score for the query (higher = better). */
  score: number;
  /** True when surfaced only because a scored match `[[links]]` to it. */
  linked?: boolean;
}

/** Split arbitrary text into lowercased word tokens (≥2 chars) for scoring. */
function tokenize(text: string): string[] {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Fold a token to a crude stem so inflections match: a user asks why the client
 * is "desyncing" while the memory is named `steam-lobby-rejoin-desync`, and a
 * whole-token comparison misses it entirely — which on a real corpus demoted the
 * one exactly-right memory below unrelated ones.
 *
 * Deliberately conservative and NOT linguistically correct. It's applied to both
 * sides of every comparison, so all that matters is that it folds consistently;
 * an over-eager rule would collide unrelated words and invent matches.
 */
function stem(token: string): string {
  let t = token;
  if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith("ies")) t = `${t.slice(0, -3)}y`;
  else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  // "running" → "runn" → "run"; harmless when the doubling wasn't inflectional.
  if (t.length > 3 && t[t.length - 1] === t[t.length - 2]) t = t.slice(0, -1);
  return t;
}

/** Tokenize into the stem space used for all whole-token comparisons. */
function stemSet(text: string): Set<string> {
  return new Set(tokenize(text).map(stem));
}

/**
 * Function words that carry no retrieval intent. A user turn is a SENTENCE, not
 * a search box ("why is the client desyncing after someone leaves the lobby"),
 * so without this every memory collects a hit for `the`/`is`/`to`/… — on a real
 * ~140-memory store that alone put a uniform floor under EVERY memory's score,
 * which is what let unrelated facts outrank the right one. IDF ({@link
 * tokenWeights}) demotes corpus-specific filler on top of this fixed list.
 */
const STOPWORDS = new Set([
  "about","after","again","all","also","am","an","and","any","are","as","at","be",
  "because","been","before","being","below","between","both","but","by","can","did",
  "do","does","doing","don","down","during","each","few","for","from","further","had",
  "has","have","having","he","her","here","hers","him","his","how","if","in","into",
  "is","it","its","just","me","more","most","my","no","nor","not","now","of","off",
  "on","once","only","or","other","our","ours","out","over","own","re","same","she",
  "should","so","some","such","than","that","the","their","theirs","them","then",
  "there","these","they","this","those","through","to","too","under","until","up",
  "ve","very","was","we","were","what","when","where","which","while","who","whom",
  "why","will","with","would","you","your","yours",
  // conversational verbs that appear in almost every turn AND every memory body
  "add","added","fix","fixed","get","give","got","let","look","make","made","need",
  "please","see","take","try","use","used","want","work","works",
]);

/**
 * Query tokens worth scoring: stopwords removed, stemmed, deduped. Falls back to
 * the raw tokens when a query is ALL stopwords (e.g. the UI search box typed
 * "how to"), so a deliberate search never silently returns nothing.
 */
function queryTokens(query: string): string[] {
  const all = tokenize(query);
  const kept = all.filter((t) => !STOPWORDS.has(t));
  return [...new Set((kept.length ? kept : all).map(stem))];
}

/** The searchable text of one memory, pre-tokenized once per search call. */
interface MemoryIndexEntry {
  memory: ProjectMemory;
  name: string;
  desc: string;
  body: string;
  nameTokens: Set<string>;
  descTokens: Set<string>;
  bodyTokens: Set<string>;
}

/** Pre-tokenize a memory's fields (built once per search, reused per token). */
function indexMemory(m: ProjectMemory): MemoryIndexEntry {
  return {
    memory: m,
    name: m.name.toLowerCase(),
    desc: m.description.toLowerCase(),
    body: m.body.toLowerCase(),
    nameTokens: stemSet(m.name),
    descTokens: stemSet(m.description),
    bodyTokens: stemSet(m.body),
  };
}

/** Best per-token field score: name 10 > description 4 > body 2, summed. */
const MAX_TOKEN_SCORE = 16;

/**
 * Inverse-document-frequency weight per query token, in [0.05, 1]. A token that
 * appears in nearly every memory (`the`, but equally a project's own ubiquitous
 * jargon like `player` in a game repo) discriminates nothing and is driven to
 * the floor; a rare token approaches 1. This is what a fixed stopword list can't
 * do — it adapts to whatever THIS project's memories talk about constantly.
 */
function tokenWeights(tokens: string[], index: readonly MemoryIndexEntry[]): Map<string, number> {
  const n = index.length;
  const out = new Map<string, number>();
  const denom = Math.log(n + 1);
  for (const t of tokens) {
    if (n === 0 || denom <= 0) {
      out.set(t, 1);
      continue;
    }
    let df = 0;
    for (const e of index) {
      if (e.nameTokens.has(t) || e.descTokens.has(t) || e.bodyTokens.has(t)) df++;
    }
    const idf = Math.log((n + 1) / (df + 0.5)) / denom;
    out.set(t, Math.min(1, Math.max(0.05, idf)));
  }
  return out;
}

/**
 * Score every memory in a corpus against a query, on the calibrated 0–100 scale
 * (see {@link scoreMemory}). The pure relevance core behind {@link
 * MemoryService.search}, exported so it can be exercised — and re-calibrated —
 * against a real memory corpus without a Store or an EventBus. Scores are
 * returned for EVERY input in input order, including zeros; filtering, ranking
 * and tie-breaking are the caller's job.
 *
 * IDF is always computed over the whole corpus passed in, so a caller's later
 * filtering (e.g. by type) can't distort how common a token really is.
 */
export function scoreCorpus(
  memories: readonly ProjectMemory[],
  query: string,
): { memory: ProjectMemory; score: number }[] {
  const raw = String(query ?? "").trim();
  if (!raw) return memories.map((memory) => ({ memory, score: 0 }));
  const tokens = queryTokens(raw);
  const index = memories.map(indexMemory);
  const weights = tokenWeights(tokens, index);
  return index.map((e) => ({
    memory: e.memory,
    score: scoreMemory(e, tokens, weights, raw),
  }));
}

/**
 * Score one memory against the weighted query tokens, on a CALIBRATED 0–100
 * scale: the IDF-weighted average of per-token field hits, as a percentage of a
 * perfect hit (every token matching name + description + body). Field weight
 * mirrors intent — a name hit beats one buried in the body, and a whole-token
 * hit beats a mere substring.
 *
 * Normalizing by the weight total (rather than summing raw points) is what makes
 * scores COMPARABLE ACROSS TURNS: previously a long sentence accumulated points
 * from every incidental word, so a 12-word turn scored ~35 on a memory it had
 * nothing to do with — the same number a genuinely on-topic 5-word turn scored.
 * A threshold can only mean something against a normalized score.
 */
function scoreMemory(
  e: MemoryIndexEntry,
  tokens: string[],
  weights: Map<string, number>,
  rawQuery: string,
): number {
  if (!tokens.length) return 0;
  let earned = 0;
  let possible = 0;
  for (const t of tokens) {
    const w = weights.get(t) ?? 1;
    possible += w * MAX_TOKEN_SCORE;
    let s = 0;
    if (e.nameTokens.has(t)) s += 10;
    else if (e.name.includes(t)) s += 5;
    if (e.descTokens.has(t)) s += 4;
    else if (e.desc.includes(t)) s += 2;
    if (e.bodyTokens.has(t)) s += 2;
    else if (e.body.includes(t)) s += 1;
    earned += w * s;
  }
  if (possible <= 0) return 0;
  let score = (100 * earned) / possible;
  // Whole-phrase hits are strong intent signals — reward them on top. These stay
  // additive (not normalized) because a literal phrase match is evidence in its
  // own right, independent of how many other tokens the query happened to carry.
  const q = rawQuery.trim().toLowerCase();
  if (q.length >= 3) {
    if (e.name.includes(q)) score += 15;
    if (e.desc.includes(q)) score += 8;
    if (e.body.includes(q)) score += 5;
  }
  return Math.min(100, Math.round(score * 10) / 10);
}

/** Coerce a parsed `type` string to a valid MemoryType (default "project"). */
function coerceType(value: string | undefined): MemoryType {
  const parsed = MemoryTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : "project";
}

/** Jaccard overlap of two token sets — |A∩B| / |A∪B|, in [0,1]. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/** The text fields that define a memory's identity, for similarity comparison. */
export interface MemoryText {
  name: string;
  description: string;
  body: string;
}

/** A memory's identity fields, pre-tokenized once for repeated comparison. */
export interface MemoryTokens {
  name: Set<string>;
  description: Set<string>;
  body: Set<string>;
}

/**
 * Pre-tokenize a memory's identity fields. Hoisted out of {@link memorySimilarity}
 * because clustering a whole store compares every memory against every other one:
 * at 140 memories that's ~10k pairs, and tokenizing both sides per pair re-splits
 * the same (up to multi-KB) bodies tens of thousands of times. Tokenize once,
 * compare many.
 */
export function memoryTokens(m: MemoryText): MemoryTokens {
  return {
    name: new Set(tokenize(m.name)),
    description: new Set(tokenize(m.description)),
    body: new Set(tokenize(m.body)),
  };
}

/**
 * Blended similarity of two PRE-TOKENIZED memories in [0,1] — the "are these the
 * same fact?" signal behind the remember dedup nudge and the consolidation
 * clustering. Name and description carry the intent (a duplicate usually shares
 * the feature word + a reworded one-liner), so they dominate; the body is noisy
 * at length and only lightly weighted.
 */
export function similarityOfTokens(a: MemoryTokens, b: MemoryTokens): number {
  return (
    0.45 * jaccard(a.name, b.name) +
    0.4 * jaccard(a.description, b.description) +
    0.15 * jaccard(a.body, b.body)
  );
}

/** {@link similarityOfTokens} over raw text — the one-shot convenience form. */
export function memorySimilarity(a: MemoryText, b: MemoryText): number {
  return similarityOfTokens(memoryTokens(a), memoryTokens(b));
}

/** A pre-existing memory that closely resembles a remember candidate. */
export interface SimilarMemory {
  name: string;
  description: string;
  type: MemoryType;
  /** Blended similarity in [0,1] (rounded to 2 dp). */
  similarity: number;
}

/* ------------------------------------------------------------- curation views */

/**
 * One row of the curation inventory — a memory plus every signal that bears on
 * "should this still be here?". The Memory panel and the consolidation task both
 * read this instead of stitching {@link MemoryService.list} against
 * {@link MemoryStatsStore} themselves.
 */
export interface MemoryInventoryEntry extends ProjectMemory {
  /**
   * Body length in CHARACTERS — what this fact costs when it's injected.
   * Deliberately not "bytes": this is `body.length`, so it counts UTF-16 code
   * units, and a store full of `→`/`≈`/emoji would report fewer than its real
   * UTF-8 byte count. Characters are the honest unit here anyway, since what
   * this feeds is a context budget rather than a disk one.
   */
  chars: number;
  /** Times auto-surfaced into a turn. */
  surfaced: number;
  /** Times returned by an explicit recall (the strong "was needed" signal). */
  recalled: number;
  /** Last access (epoch ms), or undefined when it's never been retrieved. */
  lastAccessedAt?: number;
  /** `[[wikilink]]` targets in this body that resolve to a real memory. */
  links: string[];
  /**
   * Names of memories whose body links HERE. The signal that stops a
   * consolidation from quietly breaking the graph: deleting a memory three
   * others point at means redirecting those three, not just removing a file.
   */
  backlinks: string[];
}

/** One hit from {@link MemoryService.grep} — where the literal text appears. */
export interface MemoryGrepMatch {
  name: string;
  type: MemoryType;
  /** Which field matched. */
  field: "name" | "description" | "body";
  /** 1-based line number within the body; omitted for name/description hits. */
  line?: number;
  /** The matching line, clamped to {@link GREP_LINE_MAX}. */
  text: string;
}

/** Longest match line returned by {@link MemoryService.grep}. */
const GREP_LINE_MAX = 240;
/** Longest pattern grep accepts. */
const GREP_PATTERN_MAX = 200;

/**
 * Wall-clock budget for one {@link MemoryService.grep} scan.
 *
 * A literal search over a few hundred memories is single-digit milliseconds, so
 * anything near this ceiling is a regex behaving badly. Checked between lines,
 * which bounds the realistic accidental failure — a pattern that backtracks
 * mildly on every one of a few thousand lines and turns a search into a
 * multi-second event-loop stall.
 *
 * It does NOT bound a truly catastrophic pattern (`(a+)+$` and friends), where a
 * SINGLE line can spin longer than any between-lines check will ever notice.
 * Nothing in pure JS does: the regex engine can't be interrupted, so the only
 * complete fixes are a linear-time engine (RE2 — a native addon, and this
 * project is careful about Windows build friction) or running the scan in a
 * terminable worker. Both are disproportionate here: `regex: true` is opt-in,
 * the caller is this machine's own agent — which can already run arbitrary
 * shell — and the worst case is a local server that needs restarting, not a
 * reachable denial of service. Revisit if memory search ever becomes
 * multi-tenant or reachable from outside the box.
 */
const GREP_TIME_BUDGET_MS = 2_000;

/** Clamp a grep match line so one long line can't dominate the result. */
function clip(text: string): string {
  return text.length <= GREP_LINE_MAX ? text : `${text.slice(0, GREP_LINE_MAX)}…`;
}

/**
 * Default "these are probably the same fact" bar for the dedup nudge. Calibrated
 * against a real ~140-memory store where genuinely DISTINCT same-domain facts
 * (e.g. `debug-menu-system` vs `turret-menu-system`) top out around 0.31; sitting
 * just above that noise floor means the nudge fires on true reworded duplicates
 * without crying wolf on every same-area write. It's a soft, non-blocking hint,
 * so a rare miss or false positive costs little.
 */
const SIMILARITY_THRESHOLD = 0.35;

/* ------------------------------------------------------------ MemoryService */

export class MemoryService {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly now: () => number;
  private readonly projectConfig?: MemoryConfigResolver;
  private readonly stats: MemoryStatsStore;
  private readonly mutex = new KeyedMutex();

  constructor(opts: MemoryServiceOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.now = opts.now ?? (() => Date.now());
    this.projectConfig = opts.projectConfig;
    this.stats = opts.stats ?? new MemoryStatsStore(this.store);
  }

  /**
   * Record an access event against a set of memory names — best-effort, so a
   * telemetry write never breaks the recall/surface it's counting. Names are
   * assumed already resolved to real memories.
   */
  private async recordAccess(
    projectId: string,
    names: readonly string[],
    kind: MemoryAccessKind,
  ): Promise<void> {
    if (!names.length) return;
    try {
      await this.stats.record(projectId, names, kind, this.now());
    } catch {
      /* telemetry is best-effort */
    }
  }

  /** Guard a projectId so it can't escape the data dir (no separators/traversal). */
  private safeProjectId(projectId: string): string {
    const id = String(projectId ?? "").trim();
    if (!id || id !== basename(id) || id === "." || id === "..") {
      throw new Error(`invalid projectId: ${JSON.stringify(projectId)}`);
    }
    return id;
  }

  /**
   * The absolute memory dir for a project. A project with a `.dispatch/`
   * config → its repo `memory/` dir (the committable source of truth); otherwise
   * the legacy `.data/projects/<id>/memory/` dir (back-compat).
   */
  private dir(projectId: string): string {
    const pid = this.safeProjectId(projectId);
    const configDir = this.configMemoryDir(pid);
    return configDir ?? this.store.projectMemoryDir(pid);
  }

  /** The repo `.dispatch/memory/` dir when the project has a config, else null. */
  private configMemoryDir(projectId: string): string | null {
    const memoryDir = this.projectConfig?.getConfig(projectId)?.memoryDir;
    return typeof memoryDir === "string" && memoryDir ? memoryDir : null;
  }

  /** List a project's memories (sorted by name). Empty when none exist. */
  async list(projectId: string): Promise<ProjectMemory[]> {
    const dir = this.dir(projectId);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== INDEX_FILE)
      .map((e) => e.name);
    const out: ProjectMemory[] = [];
    for (const file of files) {
      const memory = await this.readFileAt(projectId, dir, file);
      if (memory) out.push(memory);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** Read one memory by name (slug). Null when absent. */
  async read(projectId: string, name: string): Promise<ProjectMemory | null> {
    const slug = slugifyMemoryName(name);
    if (!slug) return null;
    const dir = this.dir(projectId);
    return this.readFileAt(projectId, dir, `${slug}.md`);
  }

  private async readFileAt(
    projectId: string,
    dir: string,
    file: string,
  ): Promise<ProjectMemory | null> {
    const abs = join(dir, basename(file));
    if (!existsSync(abs)) return null;
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch {
      return null;
    }
    const parsed = parseFile(raw);
    const name = slugifyMemoryName(parsed.name || file.replace(/\.md$/, ""));
    if (!name) return null;
    const memory: ProjectMemory = {
      projectId: this.safeProjectId(projectId),
      name,
      description: parsed.description ?? "",
      type: coerceType(parsed.type),
      body: parsed.body,
      file: `${name}.md`,
      ...(parsed.updatedAt !== undefined ? { updatedAt: parsed.updatedAt } : {}),
    };
    return ProjectMemorySchema.parse(memory);
  }

  /**
   * Create or update a memory (dedupe by name slug — same slug overwrites),
   * regenerate the index, and publish `memory-update`. Rejects an empty name.
   */
  async write(projectId: string, input: MemoryInput): Promise<ProjectMemory> {
    const pid = this.safeProjectId(projectId);
    const name = slugifyMemoryName(input.name);
    if (!name) throw new Error("memory name must contain a letter or digit");
    const memory: ProjectMemory = ProjectMemorySchema.parse({
      projectId: pid,
      name,
      description: oneLine(input.description ?? ""),
      type: MemoryTypeSchema.parse(input.type),
      body: String(input.body ?? "").replace(/\r\n/g, "\n").trim(),
      file: `${name}.md`,
      updatedAt: this.now(),
    });

    await this.mutex.run(`memory:${pid}`, async () => {
      const dir = this.dir(pid);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, memory.file), serialize(memory), "utf8");
      await this.regenerateIndex(pid, dir);
    });

    this.bus.publish({ type: "memory-update", projectId: pid, memory });
    return memory;
  }

  /**
   * Delete a memory by name (slug), regenerate the index, and publish
   * `memory-deleted`. Returns false when nothing matched.
   */
  async delete(projectId: string, name: string): Promise<boolean> {
    const pid = this.safeProjectId(projectId);
    const slug = slugifyMemoryName(name);
    if (!slug) return false;
    let removed = false;
    await this.mutex.run(`memory:${pid}`, async () => {
      const dir = this.dir(pid);
      const abs = join(dir, `${slug}.md`);
      if (!existsSync(abs)) return;
      await rm(abs, { force: true });
      removed = true;
      await this.regenerateIndex(pid, dir);
    });
    if (removed) {
      this.bus.publish({ type: "memory-deleted", projectId: pid, name: slug });
      // Drop the removed memory's access stats so a later slug reuse starts clean.
      try {
        const live = new Set((await this.list(pid)).map((m) => m.name));
        await this.stats.prune(pid, live);
      } catch {
        /* best-effort telemetry cleanup */
      }
    }
    return removed;
  }

  /**
   * One-time transparent migration: when a project has a `.dispatch/`
   * config, copy any legacy `.data` memories that aren't already present in the
   * repo `memory/` dir into it, then regenerate `MEMORY.md` there. Idempotent —
   * existing repo files are never clobbered, and the legacy originals are left
   * untouched. No-op for a project without a config dir (nothing to relocate).
   * Publishes a `memory-update` per newly-copied memory so open UIs refresh.
   */
  async migrateProject(projectId: string): Promise<void> {
    const pid = this.safeProjectId(projectId);
    const configDir = this.configMemoryDir(pid);
    if (!configDir) return; // no config dir → the `.data` store is already the home
    const legacyDir = this.store.projectMemoryDir(pid);
    if (legacyDir === configDir || !existsSync(legacyDir)) return;

    const copied: ProjectMemory[] = [];
    await this.mutex.run(`memory:${pid}`, async () => {
      let entries;
      try {
        entries = await readdir(legacyDir, { withFileTypes: true });
      } catch {
        return;
      }
      const files = entries
        .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== INDEX_FILE)
        .map((e) => e.name);
      if (!files.length) return;

      await mkdir(configDir, { recursive: true });
      let didCopy = false;
      for (const file of files) {
        const target = join(configDir, basename(file));
        if (existsSync(target)) continue; // repo dir wins; idempotent re-runs skip
        try {
          const raw = await readFile(join(legacyDir, basename(file)), "utf8");
          await writeFile(target, raw, "utf8");
          didCopy = true;
          const mem = await this.readFileAt(pid, configDir, basename(file));
          if (mem) copied.push(mem);
        } catch {
          /* skip an unreadable legacy file; a later run can still pick it up */
        }
      }
      if (didCopy) await this.regenerateIndex(pid, configDir);
    });

    for (const memory of copied) {
      this.bus.publish({ type: "memory-update", projectId: pid, memory });
    }
  }

  /**
   * Find pre-existing memories that closely resemble a candidate (by name +
   * description + body), so `remember` can nudge the agent to CONSOLIDATE a
   * near-duplicate instead of accumulating a second copy of the same fact. The
   * candidate's own slug is excluded (reusing a name is a legitimate update, not
   * a duplicate). Returns matches at/above `threshold`, most-similar first,
   * capped to `limit`. Never throws on an empty/whitespace name → no matches.
   */
  async findSimilar(
    projectId: string,
    candidate: { name: string; description?: string; body?: string },
    opts: { threshold?: number; limit?: number } = {},
  ): Promise<SimilarMemory[]> {
    const slug = slugifyMemoryName(candidate.name);
    if (!slug) return [];
    const threshold = opts.threshold ?? SIMILARITY_THRESHOLD;
    const cand: MemoryText = {
      name: slug,
      description: candidate.description ?? "",
      body: candidate.body ?? "",
    };
    const all = await this.list(projectId);
    return all
      .filter((m) => m.name !== slug)
      .map((m) => ({ m, similarity: memorySimilarity(cand, m) }))
      .filter((s) => s.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity || a.m.name.localeCompare(b.m.name))
      .slice(0, Math.max(1, opts.limit ?? 3))
      .map((s) => ({
        name: s.m.name,
        description: s.m.description,
        type: s.m.type,
        similarity: Math.round(s.similarity * 100) / 100,
      }));
  }

  /**
   * The curation inventory: every memory with the signals that decide whether it
   * still earns its place — size, age, how often it's actually been retrieved,
   * and how it's wired into the `[[link]]` graph in BOTH directions.
   *
   * This is the read behind a consolidation pass. `list` alone can't answer "is
   * anything pointing at this?" or "has this ever been used?", which are exactly
   * the two questions that separate a stale fact from a load-bearing one.
   *
   * Filters narrow which rows come back; backlinks are always computed over the
   * WHOLE project, because a link from a filtered-out memory still counts.
   */
  async inventory(
    projectId: string,
    opts: { type?: MemoryType; prefix?: string; names?: readonly string[] } = {},
  ): Promise<MemoryInventoryEntry[]> {
    const pid = this.safeProjectId(projectId);
    const all = await this.list(pid);
    const stats = await this.stats.get(pid).catch(() => ({}) as Record<string, MemoryStat>);
    const live = new Set(all.map((m) => m.name));

    // One pass over every body builds both directions of the graph, so a filtered
    // query still reports links from memories the filter excluded.
    const linksOf = new Map<string, string[]>();
    const backlinks = new Map<string, string[]>();
    for (const m of all) {
      const targets = extractLinks(m.body).filter((t) => live.has(t) && t !== m.name);
      linksOf.set(m.name, targets);
      for (const t of targets) {
        const list = backlinks.get(t);
        if (list) list.push(m.name);
        else backlinks.set(t, [m.name]);
      }
    }

    const prefix = opts.prefix?.trim().toLowerCase();
    const wanted = opts.names?.length
      ? new Set(opts.names.map((n) => slugifyMemoryName(n)).filter(Boolean))
      : null;

    return all
      .filter((m) => !opts.type || m.type === opts.type)
      .filter((m) => !prefix || m.name.startsWith(prefix))
      .filter((m) => !wanted || wanted.has(m.name))
      .map((m) => {
        const s = stats[m.name];
        return {
          ...m,
          chars: m.body.length,
          surfaced: s?.surfaced ?? 0,
          recalled: s?.recalled ?? 0,
          ...(s?.lastAccessedAt ? { lastAccessedAt: s.lastAccessedAt } : {}),
          links: linksOf.get(m.name) ?? [],
          backlinks: backlinks.get(m.name) ?? [],
        };
      });
  }

  /**
   * LITERAL (or regex) search across a project's memories — the exact-match
   * counterpart to {@link search}.
   *
   * `search`/`recall` are fuzzy and RANKED: they answer "what's most relevant to
   * this topic", which is right when an agent needs the best fact and wrong when
   * a curator needs every occurrence. "Which memories still mention `taskkill`?"
   * has one correct answer — all of them — and a relevance ranking that returns
   * the best six is actively misleading for a consolidation pass.
   *
   * Returns one match per line, so a hit reads as evidence rather than as a
   * whole body to re-read. Bounded by `limit`; `truncated` says whether more
   * existed. A malformed regex is an Error, not silently zero matches.
   */
  async grep(
    projectId: string,
    opts: {
      pattern: string;
      /** Treat the pattern as a JS regex rather than a literal substring. */
      regex?: boolean;
      /**
       * Default false — curation searches are case-insensitive in practice.
       * Named the same way the `memory_search` tool names it: this used to be
       * `ignoreCase` with the tool inverting it, and two names for one flag with
       * opposite polarity is exactly the kind of thing that reads fine until
       * someone has to reason about a default.
       */
      caseSensitive?: boolean;
      /** Restrict to one field; default searches all three. */
      field?: "name" | "description" | "body";
      limit?: number;
    },
  ): Promise<{
    matches: MemoryGrepMatch[];
    truncated: boolean;
    /** The scan hit {@link GREP_TIME_BUDGET_MS} and stopped early. */
    timedOut: boolean;
    scanned: number;
  }> {
    const pattern = String(opts.pattern ?? "");
    if (!pattern.trim()) throw new Error("grep requires a non-empty pattern");
    if (pattern.length > GREP_PATTERN_MAX) {
      throw new Error(`pattern is too long (max ${GREP_PATTERN_MAX} chars)`);
    }
    const flags = opts.caseSensitive ? "g" : "gi";
    // A literal search is the default because a curator types `taskkill`, not
    // `taskkill` escaped — and an unescaped `.` or `(` in a literal search
    // silently matching everything is the worse failure.
    const source = opts.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let re: RegExp;
    try {
      re = new RegExp(source, flags);
    } catch (err) {
      throw new Error(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
    }
    /** Fresh per test — a `g` regex carries `lastIndex` between calls. */
    const hits = (text: string): boolean => {
      re.lastIndex = 0;
      return re.test(text);
    };

    const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
    const all = await this.list(projectId);
    const matches: MemoryGrepMatch[] = [];
    let truncated = false;
    const deadline = this.now() + GREP_TIME_BUDGET_MS;
    let timedOut = false;

    // Every hit goes through one gate, so the budget is checked BEFORE the push
    // rather than after: a name and a description hit on the same memory used to
    // sail past a limit that only the body loop enforced, and the result
    // overshot by two while still claiming to respect `limit`.
    const take = (hit: MemoryGrepMatch): boolean => {
      if (matches.length >= limit) {
        truncated = true;
        return false;
      }
      matches.push(hit);
      return true;
    };

    outer: for (const m of all) {
      if (this.now() > deadline) {
        timedOut = true;
        break;
      }
      const want = (f: "name" | "description" | "body") => !opts.field || opts.field === f;
      if (want("name") && hits(m.name)) {
        if (!take({ name: m.name, type: m.type, field: "name", text: m.name })) break outer;
      }
      if (want("description") && m.description && hits(m.description)) {
        const hit: MemoryGrepMatch = {
          name: m.name,
          type: m.type,
          field: "description",
          text: clip(m.description),
        };
        if (!take(hit)) break outer;
      }
      if (want("body")) {
        const lines = m.body.split("\n");
        for (let i = 0; i < lines.length; i++) {
          // Per LINE, not just per memory: one 3000-line body is where a mildly
          // backtracking pattern actually burns its seconds.
          if ((i & 0x3f) === 0 && this.now() > deadline) {
            timedOut = true;
            break outer;
          }
          const line = lines[i] ?? "";
          if (!hits(line)) continue;
          const hit: MemoryGrepMatch = {
            name: m.name,
            type: m.type,
            field: "body",
            line: i + 1,
            text: clip(line.trim()),
          };
          if (!take(hit)) break outer;
        }
      }
    }
    // A timeout is reported as truncation, never as success: a caller that
    // reads a partial scan as "these are all the mentions" then deletes the
    // memory whose mention it never reached.
    if (timedOut) truncated = true;
    return { matches, truncated, timedOut, scanned: all.length };
  }

  /**
   * Rank a project's memories against free text (the shared relevance core used
   * by {@link recall}, the auto-surface injection, and the UI search box). Query
   * stopwords are dropped and the rest IDF-weighted against this project's own
   * memories, then each memory is scored 0–100 by {@link scoreMemory} (name over
   * description over body, whole-token over substring). Ties break by usefulness,
   * then recency, then name. Only positive-scoring memories are returned, capped
   * to `limit`. `minScore` drops weak matches BEFORE link expansion — without it
   * a turn that matched nothing still drags in the neighbours of its best
   * near-miss, which is how unrelated facts leaked into an off-topic turn. With
   * `expandLinks`, the `[[wikilink]]` neighbours of the surviving matches are
   * appended (marked `linked`) so surfacing one fact pulls in the ones it points
   * at.
   */
  async search(
    projectId: string,
    query: string,
    opts: {
      limit?: number;
      type?: MemoryType;
      expandLinks?: boolean;
      minScore?: number;
      maxLinks?: number;
    } = {},
  ): Promise<ScoredMemory[]> {
    const raw = String(query ?? "").trim();
    if (!raw) return [];
    const all = await this.list(projectId);
    // Score against the WHOLE project (IDF must see every memory), then apply any
    // type filter — a filter must not change how common a token looks.
    const graded = scoreCorpus(all, raw);
    // Access telemetry breaks score ties toward facts that keep proving useful.
    const stats = await this.stats.get(projectId).catch(() => ({}) as Record<string, MemoryStat>);

    const floor = Math.max(0, opts.minScore ?? 0);
    const scored = graded
      .filter((g) => !opts.type || g.memory.type === opts.type)
      .map((g) => ({ m: g.memory, score: g.score }))
      .filter((s) => s.score > 0 && s.score >= floor)
      .sort(
        (a, b) =>
          b.score - a.score ||
          usefulness(stats[b.m.name]) - usefulness(stats[a.m.name]) ||
          (b.m.updatedAt ?? 0) - (a.m.updatedAt ?? 0) ||
          a.m.name.localeCompare(b.m.name),
      );

    const limit = Math.max(1, opts.limit ?? 8);
    const top = scored.slice(0, limit);
    const out: ScoredMemory[] = top.map((s) => ({ ...s.m, score: s.score }));

    if (opts.expandLinks) {
      // Bound the fan-out so a hub memory can't balloon the output.
      const MAX_LINKS = Math.max(0, opts.maxLinks ?? 5);
      const have = new Set(out.map((m) => m.name));
      const byName = new Map(all.map((m) => [m.name, m]));
      let added = 0;
      outer: for (const s of top) {
        for (const link of extractLinks(s.m.body)) {
          if (added >= MAX_LINKS) break outer;
          if (have.has(link)) continue;
          const neighbour = byName.get(link);
          if (!neighbour) continue;
          have.add(link);
          out.push({ ...neighbour, score: 0, linked: true });
          added++;
        }
      }
    }
    return out;
  }

  /**
   * Recall memories for an agent. With no query, returns just the index (bounded);
   * with a query, returns the top-ranked matching memories (with linked
   * neighbours) so the agent can pull the full fact on demand.
   */
  async recall(
    projectId: string,
    query?: string,
    opts: { limit?: number; type?: MemoryType } = {},
  ): Promise<{ index: string; matches: ScoredMemory[] }> {
    const index = await this.index(projectId);
    const q = String(query ?? "").trim();
    if (!q) return { index, matches: [] };
    const matches = await this.search(projectId, q, {
      limit: opts.limit ?? 6,
      type: opts.type,
      expandLinks: true,
    });
    // An explicit recall is the strongest "this fact was needed" signal.
    await this.recordAccess(this.safeProjectId(projectId), matches.map((m) => m.name), "recalled");
    return { index, matches };
  }

  /**
   * Auto-surface the memories most relevant to a piece of free text (a user's
   * turn) as a ready-to-inject `<system-reminder>` block — the "push" that puts
   * the right fact in front of the agent WITHOUT it having to call `recall`.
   * Returns null when nothing clears the relevance bar.
   *
   * GRADED, because relevance is graded. A confident match earns its full body
   * (the gotchas and "how to apply" notes are the whole point of a memory, and a
   * one-liner can't carry them). A plausible-but-unconfident match gets only its
   * `description` plus its name — enough for the agent to judge and pull it with
   * `recall` if it matters, at ~3% of the tokens. Everything is spent against a
   * total char budget, so a broad turn can't dominate the context window.
   *
   * `exclude` holds names already given IN FULL this session, so a memory isn't
   * re-injected turn after turn; the returned `names` are exactly those to add to
   * that set. Pointer-tier names come back separately as `pointed` — they are
   * deliberately NOT excluded, so a memory first seen as a pointer can still be
   * promoted to its full body on a later turn that matches it strongly.
   */
  async surfaceFor(
    projectId: string,
    text: string,
    opts: {
      exclude?: ReadonlySet<string>;
      limit?: number;
      minScore?: number;
      fullScore?: number;
      charBudget?: number;
    } = {},
  ): Promise<{ block: string; names: string[]; pointed: string[] } | null> {
    const minScore = opts.minScore ?? SURFACE_MIN_SCORE;
    const fullScore = opts.fullScore ?? SURFACE_FULL_SCORE;
    const limit = Math.max(1, opts.limit ?? SURFACE_LIMIT);
    let budget = Math.max(200, opts.charBudget ?? SURFACE_CHAR_BUDGET);

    // Threshold INSIDE the search so link expansion only fans out from matches
    // that actually cleared the bar, then over-fetch so dropping already-surfaced
    // names can't starve the result below what the caller asked for.
    const ranked = await this.search(projectId, text, {
      limit: limit * 3,
      expandLinks: true,
      minScore,
      maxLinks: SURFACE_MAX_LINKS,
    });
    const exclude = opts.exclude ?? new Set<string>();
    // A directly-linked neighbour rides along below threshold (score 0), but only
    // ever as a pointer — it didn't match the turn, the memory pointing at it did.
    const picked = ranked.filter((m) => !exclude.has(m.name)).slice(0, limit);
    if (!picked.length) return null;

    const top = picked[0]?.linked ? 0 : (picked[0]?.score ?? 0);
    const full: ScoredMemory[] = [];
    const pointers: ScoredMemory[] = [];
    const sections: string[] = [];
    for (const m of picked) {
      // Full body for a confident, unlinked match — and for the runner-up only
      // when it's in the same league as the leader (a clear #1 means the rest are
      // context, not the answer).
      const confident =
        !m.linked &&
        m.score >= fullScore &&
        (full.length === 0 || m.score >= top * FULL_RUNNERUP_RATIO);
      if (confident && full.length < FULL_LIMIT) {
        const head = `### ${m.name} (${m.type})\n${m.description}\n\n`;
        // Reserve the header before clamping — otherwise a body sized to the whole
        // remaining budget always overruns it and silently demotes to a pointer.
        const avail = budget - head.length;
        if (avail >= SURFACE_BODY_MIN) {
          const section = head + clampBody(m.body, Math.min(SURFACE_BODY_MAX, avail));
          full.push(m);
          sections.push(section);
          budget -= section.length;
          continue;
        }
      }
      pointers.push(m);
    }

    const pointerLines: string[] = [];
    for (const m of pointers) {
      const line =
        `- \`${m.name}\` (${m.type})${m.linked ? " — linked" : ""} — ` +
        `${m.description || "(no description)"}`;
      if (line.length > budget) break; // budget spent; the rest wait for `recall`
      pointerLines.push(line);
      budget -= line.length;
    }
    if (!sections.length && !pointerLines.length) return null;

    if (pointerLines.length) {
      sections.push(
        "### Possibly relevant — names only\n" +
          "Judge from the one-liner; pull the full fact with " +
          "`mcp__dispatch-memory__recall({ query: \"<name>\" })` if it bears on this work.\n" +
          pointerLines.join("\n"),
      );
    }

    const names = full.map((m) => m.name);
    const pointed = pointerLines.length
      ? pointers.slice(0, pointerLines.length).map((m) => m.name)
      : [];
    // Count the proactive push so a fact that keeps being relevant ranks up. Only
    // full-body pushes count — a pointer the agent never opened is not evidence
    // that the memory was useful, and counting it would corrupt prune candidates.
    await this.recordAccess(this.safeProjectId(projectId), names, "surfaced");

    const block =
      "<system-reminder>\n" +
      "Relevant durable project memories your team recorded (surfaced automatically " +
      "because they match this turn). Treat them as trusted background context and " +
      "act on them; they reflect what was true when written, so sanity-check against " +
      "live code before betting on a specific detail. If any is now wrong, fix it " +
      "with `mcp__dispatch-memory__remember` (same name overwrites) or `mcp__dispatch-memory__forget`.\n\n" +
      sections.join("\n\n") +
      "\n</system-reminder>";
    return { block, names, pointed };
  }

  /** The `MEMORY.md` index content for a project (regenerated, not cached). */
  async index(projectId: string): Promise<string> {
    const memories = await this.list(projectId);
    return this.renderIndex(memories);
  }

  /**
   * The bounded start-of-session injection for a project. Two tiers, so the
   * catalogue can grow to hundreds of facts without flooding every session:
   *
   *  - **Standing rules** (`user` + `feedback`) — behavioural guidance that
   *    can't wait to be keyword-matched, so it's ALWAYS present, with its body
   *    (clamped + budget-bounded). These are "how this team works".
   *  - **Recorded facts** (`project` + `reference`) — a lookup catalogue, so
   *    rather than dump every one-liner it injects a topic map (areas + counts)
   *    plus a small most-used sample. The relevant facts arrive in full via
   *    auto-surface, and the agent pulls the rest on demand with `recall`.
   *
   * Null when the project has no memories (an empty project injects nothing).
   */
  async buildInjection(projectId: string): Promise<string | null> {
    const memories = await this.list(projectId);
    if (!memories.length) return null;

    const rules = memories.filter((m) => m.type === "user" || m.type === "feedback");
    const facts = memories.filter((m) => m.type === "project" || m.type === "reference");
    const stats = await this.stats
      .get(projectId)
      .catch(() => ({}) as Record<string, MemoryStat>);

    const out: string[] = [
      "## Project memory",
      "",
      "Durable facts your team recorded for THIS project. The standing rules below " +
        "ALWAYS apply. Everything else is a lookup catalogue: as you work, the facts " +
        "that clearly bear on the current turn arrive in full automatically, and " +
        "near-misses arrive as a name + one-line description — when one of those looks " +
        "relevant, pull it with `mcp__dispatch-memory__recall({ query: \"<name>\" })` rather than " +
        "guessing. You can also search by topic the same way. Consult it before asking " +
        "the user something they may have already answered.",
      "",
    ];

    // --- Tier 1: standing rules & preferences (always in full, budget-bounded).
    if (rules.length) {
      out.push("### Standing rules & preferences", "");
      const rank: MemoryType[] = ["user", "feedback"];
      const sorted = [...rules].sort(
        (a, b) => rank.indexOf(a.type) - rank.indexOf(b.type) || a.name.localeCompare(b.name),
      );
      let budget = RULES_BODY_BUDGET;
      for (const m of sorted) {
        out.push(`- **${m.name}** — ${m.description || "(no description)"}`);
        const body = m.body.trim();
        if (body && budget > 0) {
          const clamped = clampBody(body, Math.min(RULE_BODY_MAX, budget));
          budget -= clamped.length;
          out.push(clamped.split("\n").map((l) => `  ${l}`).join("\n"));
        }
      }
      out.push("");
    }

    // --- Tier 2: recorded facts as a topic map + a most-used sample (never the
    //     full one-line dump — that's what floods a large project's every turn).
    if (facts.length) {
      out.push("### Recorded facts — retrieved on demand", "");
      out.push(
        `${facts.length} recorded ${facts.length === 1 ? "fact" : "facts"} (project + ` +
          "reference). The relevant ones auto-surface as you work; call " +
          "`mcp__dispatch-memory__recall({ query })` to pull any by topic.",
        "",
      );
      const areas = clusterAreas(facts);
      if (areas) out.push(`By area: ${areas}`, "");

      const sample = [...facts]
        .sort(
          (a, b) =>
            usefulness(stats[b.name]) - usefulness(stats[a.name]) ||
            (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
            a.name.localeCompare(b.name),
        )
        .slice(0, FACTS_SAMPLE);
      const anyUsed = sample.some((m) => usefulness(stats[m.name]) > 0);
      out.push(anyUsed ? "Most-used lately:" : "Recently recorded:");
      for (const m of sample) {
        out.push(`- \`${m.name}\` — ${m.description || "(no description)"}`);
      }
      out.push("");
    }

    out.push(
      "When you learn a durable fact — a preference, a correction, an architecture " +
        "decision, a reference — record it with " +
        "`mcp__dispatch-memory__remember({ name, description, type, body })` so it outlives this " +
        "chat; reuse a name to update an existing one instead of adding a near-duplicate, " +
        "and `mcp__dispatch-memory__forget({ name })` when one goes stale.",
    );

    return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  /**
   * A project's memory access telemetry (name → surfaced/recalled counts +
   * last-access time). Powers the Memory panel's usefulness view; empty when
   * nothing's been accessed yet.
   */
  async accessStats(projectId: string): Promise<Record<string, MemoryStat>> {
    return this.stats.get(this.safeProjectId(projectId));
  }

  /**
   * Memories that look prunable — a curation aid (for the Memory panel or a
   * future `/memory-review`), never an auto-delete. A memory is a candidate when
   * it was NEVER recalled AND either never accessed at all or only surfaced and
   * not since `staleBefore`. Ordered least-useful first. `staleBefore` defaults
   * to 0 → only the never-accessed ones qualify.
   */
  async pruneCandidates(
    projectId: string,
    opts: { staleBefore?: number } = {},
  ): Promise<ProjectMemory[]> {
    const pid = this.safeProjectId(projectId);
    const memories = await this.list(pid);
    const stats = await this.stats.get(pid).catch(() => ({}) as Record<string, MemoryStat>);
    const staleBefore = opts.staleBefore ?? 0;
    return memories
      .filter((m) => {
        const s = stats[m.name];
        if (!s) return true; // never accessed at all
        if (s.recalled > 0) return false; // an explicit recall proved it useful
        return s.lastAccessedAt < staleBefore; // only surfaced, and not lately
      })
      .sort(
        (a, b) =>
          usefulness(stats[a.name]) - usefulness(stats[b.name]) ||
          (a.updatedAt ?? 0) - (b.updatedAt ?? 0) ||
          a.name.localeCompare(b.name),
      );
  }

  /* --------------------------------------------------------------- internal */

  private renderIndex(memories: ProjectMemory[]): string {
    const lines = memories.map((m) => `- [${m.name}](${m.file}) — ${m.description}`);
    return `# Project memory\n\n${
      lines.length ? lines.join("\n") : "_No memories recorded yet._"
    }\n`;
  }

  /** Rewrite `MEMORY.md` from the current on-disk memories (called under the mutex). */
  private async regenerateIndex(projectId: string, dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== INDEX_FILE)
      .map((e) => e.name);
    const memories: ProjectMemory[] = [];
    for (const file of files) {
      const m = await this.readFileAt(projectId, dir, file);
      if (m) memories.push(m);
    }
    memories.sort((a, b) => a.name.localeCompare(b.name));
    await writeFile(join(dir, INDEX_FILE), this.renderIndex(memories), "utf8");
  }
}
