/**
 * MemoryService — per-project agent memory (the durable, cross-chat facts).
 *
 * Mirrors the pattern the human's own Claude Code uses: a folder of one-fact
 * markdown files + a generated `MEMORY.md` index, scoped to a PROJECT. Each
 * memory is a single `.md` file with YAML-ish frontmatter (`name` /
 * `description` / `type`) over a markdown body. The index (one line per memory)
 * is injected into every session at start (read); the
 * `mcp__manager__remember|recall|forget` tools append/query/remove it (write);
 * the Memory panel curates it.
 *
 * Storage location (resolved per-project via {@link dir}):
 *   - a project with a self-contained `.claude-manager/` config → the repo's
 *     `.claude-manager/memory/` dir (from {@link ProjectConfig.memoryDir}). This
 *     is the COMMITTABLE source of truth; remember/recall/forget + injection all
 *     read/write there.
 *   - a project WITHOUT a config dir → the legacy runtime store dir
 *     `.data/projects/<projectId>/memory/` (back-compat, unchanged).
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
} from "@cm/shared";
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
 * project's memory into its committable `.claude-manager/memory/` source of
 * truth. A minimal interface (not the concrete service) keeps the dependency
 * one-way and lets tests inject a trivial stub.
 */
export interface MemoryConfigResolver {
  /** The loaded config for a project, or null when it has no `.claude-manager/`. */
  getConfig(projectId: string): { memoryDir?: string | null } | null | undefined;
}

export interface MemoryServiceOptions {
  store: Store;
  bus: EventBus;
  now?: () => number;
  /**
   * Optional project-config resolver. When a project has a `.claude-manager/`
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
 * Score one memory against a set of query tokens. Field weight mirrors intent:
 * a hit in the name is worth far more than one buried in the body, and an exact
 * whole-token hit beats a mere substring. Returns 0 when nothing matches.
 */
function scoreMemory(m: ProjectMemory, tokens: string[], rawQuery: string): number {
  if (!tokens.length) return 0;
  const name = m.name.toLowerCase();
  const desc = m.description.toLowerCase();
  const body = m.body.toLowerCase();
  const nameTokens = new Set(tokenize(m.name));
  const descTokens = new Set(tokenize(m.description));
  const bodyTokens = new Set(tokenize(m.body));

  let score = 0;
  for (const t of tokens) {
    if (nameTokens.has(t)) score += 10;
    else if (name.includes(t)) score += 5;
    if (descTokens.has(t)) score += 4;
    else if (desc.includes(t)) score += 2;
    if (bodyTokens.has(t)) score += 2;
    else if (body.includes(t)) score += 1;
  }
  // Whole-phrase hits are strong intent signals — reward them on top.
  const q = rawQuery.trim().toLowerCase();
  if (q.length >= 3) {
    if (name.includes(q)) score += 8;
    if (desc.includes(q)) score += 4;
    if (body.includes(q)) score += 3;
  }
  return score;
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
interface MemoryText {
  name: string;
  description: string;
  body: string;
}

/**
 * Blended similarity of two memories in [0,1] — the "are these the same fact?"
 * signal behind the remember dedup nudge. Name and description carry the intent
 * (a duplicate usually shares the feature word + a reworded one-liner), so they
 * dominate; the body is noisy at length and only lightly weighted.
 */
export function memorySimilarity(a: MemoryText, b: MemoryText): number {
  const nameSim = jaccard(new Set(tokenize(a.name)), new Set(tokenize(b.name)));
  const descSim = jaccard(new Set(tokenize(a.description)), new Set(tokenize(b.description)));
  const bodySim = jaccard(new Set(tokenize(a.body)), new Set(tokenize(b.body)));
  return 0.45 * nameSim + 0.4 * descSim + 0.15 * bodySim;
}

/** A pre-existing memory that closely resembles a remember candidate. */
export interface SimilarMemory {
  name: string;
  description: string;
  type: MemoryType;
  /** Blended similarity in [0,1] (rounded to 2 dp). */
  similarity: number;
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
   * The absolute memory dir for a project. A project with a `.claude-manager/`
   * config → its repo `memory/` dir (the committable source of truth); otherwise
   * the legacy `.data/projects/<id>/memory/` dir (back-compat).
   */
  private dir(projectId: string): string {
    const pid = this.safeProjectId(projectId);
    const configDir = this.configMemoryDir(pid);
    return configDir ?? this.store.projectMemoryDir(pid);
  }

  /** The repo `.claude-manager/memory/` dir when the project has a config, else null. */
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
   * One-time transparent migration: when a project has a `.claude-manager/`
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
   * Rank a project's memories against free text (the shared relevance core used
   * by {@link recall}, the auto-surface injection, and the UI search box). A
   * weighted token+substring scorer favours name over description over body and
   * whole-token over substring hits; ties break by recency then name. Only
   * positive-scoring memories are returned, capped to `limit`. With
   * `expandLinks`, any `[[wikilink]]` neighbours of the top matches are appended
   * (marked `linked`) so surfacing one fact pulls in the ones it points at.
   */
  async search(
    projectId: string,
    query: string,
    opts: { limit?: number; type?: MemoryType; expandLinks?: boolean } = {},
  ): Promise<ScoredMemory[]> {
    const raw = String(query ?? "").trim();
    if (!raw) return [];
    const all = await this.list(projectId);
    const pool = opts.type ? all.filter((m) => m.type === opts.type) : all;
    const tokens = [...new Set(tokenize(raw))];
    // Access telemetry breaks score ties toward facts that keep proving useful.
    const stats = await this.stats.get(projectId).catch(() => ({}) as Record<string, MemoryStat>);

    const scored = pool
      .map((m) => ({ m, score: scoreMemory(m, tokens, raw) }))
      .filter((s) => s.score > 0)
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
      const MAX_LINKS = 5; // bound the fan-out so a hub memory can't balloon output
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
   * Returns null when nothing clears the relevance bar. `exclude` holds names
   * already surfaced this session so a memory isn't re-injected turn after turn;
   * the returned `names` are the ones to add to that set.
   */
  async surfaceFor(
    projectId: string,
    text: string,
    opts: { exclude?: ReadonlySet<string>; limit?: number; minScore?: number } = {},
  ): Promise<{ block: string; names: string[] } | null> {
    const minScore = opts.minScore ?? 6;
    const limit = Math.max(1, opts.limit ?? 3);
    // Over-fetch, then drop already-surfaced + below-threshold before capping, so
    // filtering never starves the result below what the caller asked for.
    const ranked = await this.search(projectId, text, { limit: limit * 4, expandLinks: true });
    const exclude = opts.exclude ?? new Set<string>();
    const picked = ranked
      .filter((m) => !exclude.has(m.name))
      // A directly-linked neighbour rides along even below threshold (score 0).
      .filter((m) => m.linked || m.score >= minScore)
      .slice(0, limit);
    if (!picked.length) return null;

    const names = picked.map((m) => m.name);
    // Count the proactive push so a fact that keeps being relevant ranks up.
    await this.recordAccess(this.safeProjectId(projectId), names, "surfaced");

    const sections = picked
      .map(
        (m) =>
          `### ${m.name} (${m.type})${m.linked ? " — linked" : ""}\n` +
          `${m.description}\n\n${clampBody(m.body, 4000)}`,
      )
      .join("\n\n");
    const block =
      "<system-reminder>\n" +
      "Relevant durable project memories your team recorded (surfaced automatically " +
      "because they match this turn). Treat them as trusted background context and " +
      "act on them; they reflect what was true when written, so sanity-check against " +
      "live code before betting on a specific detail. If any is now wrong, fix it " +
      "with `mcp__manager__remember` (same name overwrites) or `mcp__manager__forget`.\n\n" +
      sections +
      "\n</system-reminder>";
    return { block, names };
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
        "ALWAYS apply. Everything else is a lookup catalogue — the facts most relevant " +
        "to what you're doing surface in full automatically, and you can pull any other " +
        "by topic with `mcp__manager__recall({ query })`. Consult it before asking the " +
        "user something they may have already answered.",
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
          "`mcp__manager__recall({ query })` to pull any by topic.",
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
        "`mcp__manager__remember({ name, description, type, body })` so it outlives this " +
        "chat; reuse a name to update an existing one instead of adding a near-duplicate, " +
        "and `mcp__manager__forget({ name })` when one goes stale.",
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
