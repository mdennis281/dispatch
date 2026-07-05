/**
 * MemoryService — per-project agent memory (the durable, cross-chat facts).
 *
 * Mirrors the pattern the human's own Claude Code uses: a folder of one-fact
 * markdown files + a generated `MEMORY.md` index, scoped to a PROJECT and stored
 * under `.data/projects/<projectId>/memory/`. Each memory is a single `.md` file
 * with YAML-ish frontmatter (`name` / `description` / `type`) over a markdown
 * body. The index (one line per memory) is injected into every session at start
 * (read); the `mcp__manager__remember|recall|forget` tools append/query/remove
 * it (write); the Memory panel curates it.
 *
 * No DB — everything is filesystem, keyed off the Store's base dir via
 * `store.projectMemoryDir(projectId)`. Writes/deletes serialize per-project (so
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

export interface MemoryServiceOptions {
  store: Store;
  bus: EventBus;
  now?: () => number;
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
}): string {
  const body = m.body.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  return (
    [
      "---",
      `name: ${m.name}`,
      `description: ${oneLine(m.description)}`,
      `type: ${m.type}`,
      "---",
      "",
    ].join("\n") + (body ? `${body}\n` : "")
  );
}

interface ParsedFile {
  name?: string;
  description?: string;
  type?: string;
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
  }
  return out;
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
  private readonly mutex = new KeyedMutex();

  constructor(opts: MemoryServiceOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Guard a projectId so it can't escape the data dir (no separators/traversal). */
  private safeProjectId(projectId: string): string {
    const id = String(projectId ?? "").trim();
    if (!id || id !== basename(id) || id === "." || id === "..") {
      throw new Error(`invalid projectId: ${JSON.stringify(projectId)}`);
    }
    return id;
  }

  private dir(projectId: string): string {
    return this.store.projectMemoryDir(this.safeProjectId(projectId));
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
   * Recall memories for an agent. With no query, returns just the index (bounded);
   * with a query, also returns the memories whose name/description/body/type match
   * so the agent can pull the full fact on demand.
   */
  async recall(
    projectId: string,
    query?: string,
  ): Promise<{ index: string; matches: ProjectMemory[] }> {
    const index = await this.index(projectId);
    const q = String(query ?? "").trim().toLowerCase();
    if (!q) return { index, matches: [] };
    const matches = (await this.list(projectId)).filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.type.toLowerCase().includes(q) ||
        m.body.toLowerCase().includes(q),
    );
    return { index, matches };
  }

  /** The `MEMORY.md` index content for a project (regenerated, not cached). */
  async index(projectId: string): Promise<string> {
    const memories = await this.list(projectId);
    return this.renderIndex(memories);
  }

  /**
   * The bounded system-prompt injection for a project (index + one-line
   * descriptions, never full bodies). Null when the project has no memories so
   * an empty project injects nothing.
   */
  async buildInjection(projectId: string): Promise<string | null> {
    const memories = await this.list(projectId);
    if (!memories.length) return null;
    const lines = memories.map(
      (m) => `- **${m.name}** (${m.type}) — ${m.description || "(no description)"}`,
    );
    return [
      "## Project memory (durable facts your team recorded; verify against live code before relying on them)",
      "",
      ...lines,
      "",
      "These are one-line summaries. Call `mcp__manager__recall({ query })` to read the full body of any memory, " +
        "`mcp__manager__remember({ name, description, type, body })` to record a new durable fact, or " +
        "`mcp__manager__forget({ name })` to remove one.",
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
