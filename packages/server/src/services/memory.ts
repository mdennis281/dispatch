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

/** The generated index filename (excluded from the memory listing). */
const INDEX_FILE = "MEMORY.md";

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

/* ------------------------------------------------------------ MemoryService */

export class MemoryService {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly now: () => number;
  private readonly projectConfig?: MemoryConfigResolver;
  private readonly mutex = new KeyedMutex();

  constructor(opts: MemoryServiceOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.now = opts.now ?? (() => Date.now());
    this.projectConfig = opts.projectConfig;
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
    if (removed) this.bus.publish({ type: "memory-deleted", projectId: pid, name: slug });
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

    const scored = pool
      .map((m) => ({ m, score: scoreMemory(m, tokens, raw) }))
      .filter((s) => s.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.m.updatedAt ?? 0) - (a.m.updatedAt ?? 0) ||
          a.m.name.localeCompare(b.m.name),
      );

    const limit = Math.max(1, opts.limit ?? 8);
    const top = scored.slice(0, limit);
    const out: ScoredMemory[] = top.map((s) => ({ ...s.m, score: s.score }));

    if (opts.expandLinks) {
      const have = new Set(out.map((m) => m.name));
      const byName = new Map(all.map((m) => [m.name, m]));
      for (const s of top) {
        for (const link of extractLinks(s.m.body)) {
          if (have.has(link)) continue;
          const neighbour = byName.get(link);
          if (!neighbour) continue;
          have.add(link);
          out.push({ ...neighbour, score: 0, linked: true });
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

    const sections = picked
      .map(
        (m) =>
          `### ${m.name} (${m.type})${m.linked ? " — linked" : ""}\n` +
          `${m.description}\n\n${m.body}`,
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
    return { block, names: picked.map((m) => m.name) };
  }

  /** The `MEMORY.md` index content for a project (regenerated, not cached). */
  async index(projectId: string): Promise<string> {
    const memories = await this.list(projectId);
    return this.renderIndex(memories);
  }

  /**
   * The bounded system-prompt injection for a project (the memory catalogue as
   * one-line, grouped descriptions — never full bodies). Directive framing so
   * the agent actually consults + grows the memory rather than ignoring it. Null
   * when the project has no memories so an empty project injects nothing.
   */
  async buildInjection(projectId: string): Promise<string | null> {
    const memories = await this.list(projectId);
    if (!memories.length) return null;

    const order: MemoryType[] = ["user", "feedback", "project", "reference"];
    const labels: Record<MemoryType, string> = {
      user: "Preferences",
      feedback: "Feedback & lessons",
      project: "Project facts",
      reference: "Reference pointers",
    };
    const lines: string[] = [];
    for (const type of order) {
      const group = memories.filter((m) => m.type === type);
      if (!group.length) continue;
      lines.push(`**${labels[type]}**`);
      for (const m of group) {
        lines.push(`- \`${m.name}\` — ${m.description || "(no description)"}`);
      }
      lines.push("");
    }

    return [
      "## Project memory",
      "",
      "Durable facts your team recorded for THIS project. The most relevant ones are " +
        "surfaced in full automatically as you work — but this is the full catalogue. " +
        "Consult it before asking the user something they may have already answered, " +
        "and treat these as the team's standing context.",
      "",
      ...lines,
      "When something here is relevant, call `mcp__manager__recall({ query })` to read the " +
        "full body. When you learn a durable fact — a preference, a correction, an " +
        "architecture decision, a reference — record it with " +
        "`mcp__manager__remember({ name, description, type, body })` so it outlives this " +
        "chat; reuse a name to update, and `mcp__manager__forget({ name })` when one goes stale.",
    ].join("\n");
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
