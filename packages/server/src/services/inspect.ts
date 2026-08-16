/**
 * TRANSCRIPT INSPECTION — a read-only query surface over chats, their images,
 * and project config, for an AGENT rather than the UI.
 *
 * The client reads one chat at a time, newest-first, because that's what a human
 * scrolling a transcript wants. An agent asking "which chat was Michael talking
 * about" or "what did that other session decide" needs the opposite: a filtered
 * sweep ACROSS ~300 transcripts totalling ~800 MB, returning a few hundred
 * characters. Pointing the existing reads at that job doesn't work —
 * `Store.readMessages` slurps a whole file into memory to window it, which is
 * correct for one 18 MB chat and ruinous for all of them.
 *
 * So the scan here:
 *   - filters on chat METADATA first (project/status/time), which is 278 tiny
 *     JSON reads, and only then opens the transcripts that survived;
 *   - streams each transcript line-by-line and tests the RAW line before
 *     JSON.parse — a matching line is rare, so parsing is paid per hit rather
 *     than per row (the same trick `readMessages` uses for cursor resolution);
 *   - stops at a byte budget and REPORTS having stopped. A silent cap on a
 *     search reads as "not found", which is worse than slow.
 *
 * Rows are duck-typed, not zod-parsed. This reads production transcripts written
 * by months of older schema versions; a strict parse would drop historical rows
 * on the floor precisely when someone is digging through history to find them.
 *
 * Everything here is READ-ONLY by construction — no method writes, and the
 * manager-MCP binding exposes no path that could.
 */
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { Chat, ImageRef, Project } from "@dispatch/shared";

import type { Store } from "../store/index.js";

/* ------------------------------------------------------------------ limits */

/** Total transcript bytes one `findChats` call may stream before giving up. */
const DEFAULT_SCAN_BUDGET_BYTES = 256 * 1024 * 1024;
/** Transcripts opened concurrently during a scan. */
const SCAN_CONCURRENCY = 8;
/** Characters of context kept on each side of a match in a snippet. */
const SNIPPET_PAD = 140;
/** Hard cap on a single rendered field, so one huge row can't fill the result. */
const FIELD_CLIP = 2_000;

/* ------------------------------------------------------------------- types */

/** Which instance's data to read. `self` is the running server's own store. */
export type InspectInstance = "self" | "stable";

/** A loosely-typed transcript row — see the file header on why this isn't zod. */
export interface RawRow {
  id?: string;
  ts?: number;
  turn?: number;
  kind?: string;
  text?: string;
  thinking?: string;
  name?: string;
  toolUseId?: string;
  input?: unknown;
  content?: unknown;
  ok?: boolean;
  isError?: boolean;
  durationMs?: number;
  images?: ImageRef[];
  model?: string;
  subtype?: string;
  result?: string;
  level?: string;
  summary?: string;
  status?: string;
  toolName?: string;
  decision?: string;
  subagentType?: string;
  usage?: unknown;
  contextTokens?: number;
  costUsd?: number;
  [key: string]: unknown;
}

export interface ChatHit {
  /** Row id, so the caller can page around it with `chat_read`. */
  id?: string;
  ts?: number;
  kind: string;
  /** Tool name / subtype, when the row has one. */
  label?: string;
  snippet: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  projectId: string;
  projectName?: string;
  status?: string;
  archived?: boolean;
  harness?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  /** Bytes of transcript on disk — a cheap stand-in for "how big is this chat". */
  transcriptBytes?: number;
  worktrees?: string[];
  prs?: number[];
  hits?: ChatHit[];
}

export interface FindChatsQuery {
  instance?: InspectInstance;
  /** Free text matched against transcript content (and always against titles). */
  query?: string;
  /** Project id, or a case-insensitive substring of a project name. */
  project?: string;
  status?: string;
  /** Include archived chats (default false). */
  archived?: boolean;
  /** Only chats active at/after this time (epoch ms). */
  since?: number;
  /** Only chats active before this time (epoch ms). */
  before?: number;
  /** Restrict content matching to these row kinds. Default: user + assistant. */
  kinds?: string[];
  limit?: number;
  hitsPerChat?: number;
  scanBudgetBytes?: number;
}

export interface FindChatsResult {
  chats: ChatSummary[];
  /** Chats that passed the metadata filter (the search space). */
  candidates: number;
  /** Transcripts actually opened. */
  scanned: number;
  bytesScanned: number;
  /** True when the byte budget stopped the sweep before it finished. */
  truncated: boolean;
  /** Chats never opened because the budget ran out — named, never silent. */
  unscanned: number;
}

export type ChatView = "digest" | "messages" | "grep";

export interface ReadChatQuery {
  instance?: InspectInstance;
  chatId: string;
  view?: ChatView;
  /** Required for `grep`; ignored otherwise. */
  query?: string;
  kinds?: string[];
  limit?: number;
  /** Page backwards from this row id (exclusive). */
  beforeId?: string;
  /** Page forwards from this row id (exclusive). */
  afterId?: string;
  /** Keep verbatim payloads instead of clipping them. */
  full?: boolean;
}

export interface ChatImage {
  /** Absolute path on disk — read it directly with the file tools. */
  path: string;
  mimeType?: string;
  alt?: string;
  /** The row it was attached to. */
  rowId?: string;
  ts?: number;
}

export interface ReadChatResult {
  chat: ChatSummary;
  view: ChatView;
  /** Row counts by kind across the WHOLE transcript, not just the window. */
  kindCounts: Record<string, number>;
  totalRows: number;
  /** The rows this view selected. */
  rows: RawRow[];
  /** Every image in the transcript, with paths resolved for direct reading. */
  images: ChatImage[];
  /** Digest only: the human's messages, which carry the intent of the chat. */
  userMessages?: RawRow[];
  /** Digest only: errors + notices worth surfacing. */
  problems?: RawRow[];
  truncated: boolean;
}

export interface ProjectInfoQuery {
  instance?: InspectInstance;
  /** Project id or case-insensitive name substring. Defaults to the caller's. */
  project?: string;
  /** Include the project's durable memory index. */
  memory?: boolean;
  /** Include the N most recent chats. */
  chats?: number;
}

export interface ProjectInfoResult {
  project: Project;
  /** Where the committable `.dispatch/` config was found, if any. */
  configSourceDir: string | null;
  configErrors: { file?: string; message: string }[];
  instructions?: string;
  agents: string[];
  modes: string[];
  skills: string[];
  subApps: { id: string; name: string; ports?: number[]; url?: string }[];
  mcpServers: string[];
  memoryIndex?: string;
  recentChats: ChatSummary[];
}

/* -------------------------------------------------------------- collaborators */

/** The `.dispatch/` config reader, narrowed to what inspection needs. */
export interface InspectProjectConfig {
  get(projectId: string):
    | {
        sourceDir: string | null;
        config: unknown;
        errors: { file?: string; message: string }[];
      }
    | undefined;
}

/** The project-memory reader, narrowed to the index render. */
export interface InspectMemory {
  index(projectId: string): Promise<string>;
}

export interface InspectServiceOptions {
  store: Store;
  projectConfig?: InspectProjectConfig;
  memory?: InspectMemory;
  /**
   * Roots of the INSTALLED instance, for a dev server inspecting production.
   * Null/absent → `instance: "stable"` reports that it isn't available rather
   * than silently reading the dev store and returning a confidently wrong answer.
   */
  stableRoots?: () => { dataDir: string; configDir: string } | null;
  /** Build a Store over foreign roots (injected so tests don't touch disk). */
  makeStore?: (dataDir: string, configDir: string) => Store;
}

/* -------------------------------------------------------- installed roots */

/**
 * Where the INSTALLED deployment keeps its two roots.
 *
 * MIRROR of `desktopPaths()` in `tools/app/paths.mjs` (itself mirrored by
 * `tools/app/launch.py`). Duplicated rather than imported because that file is
 * build tooling outside the server's TS project — but it is three lines and the
 * layout is frozen by every existing installation, so the drift risk is small
 * and the failure is loud (a wrong root simply has no `chats/` dir).
 *
 * Returns null when the process IS the installed instance, since `self` already
 * reads that store and a second Store over the same files would be waste.
 */
export function installedRoots(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): { dataDir: string; configDir: string } | null {
  const explicit = env.DISPATCH_HOME ?? env.CM_HOME;
  const local =
    env.LOCALAPPDATA ??
    env.XDG_DATA_HOME ??
    join(home, process.platform === "darwin" ? "Library/Application Support" : ".local/share");
  const root = explicit ? resolve(explicit) : join(local, "claude-manager");
  const dataDir = join(root, "data");
  const configDir = join(root, "config");
  // Already pointed at it → `self` is the same store.
  if (env.DISPATCH_DATA_DIR && resolve(env.DISPATCH_DATA_DIR) === resolve(dataDir)) return null;
  return { dataDir, configDir };
}

/* ----------------------------------------------------------------- helpers */

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Flatten any row payload to searchable/renderable text. */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * The searchable text of a row. Deliberately includes tool payloads: an agent
 * looking for "which chat touched session-broker.ts" is looking for a file path
 * that only ever appears inside a tool input.
 */
export function rowText(row: RawRow): string {
  switch (row.kind) {
    case "user":
      return [row.text, stringify(row.parts)].filter(Boolean).join(" ");
    case "assistant":
      return [row.text, row.thinking].filter(Boolean).join(" ");
    case "tool_use":
      return [row.name, stringify(row.input)].filter(Boolean).join(" ");
    case "tool_result":
      return [row.name, stringify(row.content)].filter(Boolean).join(" ");
    case "result":
      return row.result ?? "";
    case "system":
      return [row.subtype, row.text, stringify(row.data)].filter(Boolean).join(" ");
    case "permission":
      return [row.toolName, row.text, stringify(row.input)].filter(Boolean).join(" ");
    case "task_status":
      return [row.status, row.summary].filter(Boolean).join(" ");
    case "notice":
      return row.text ?? "";
    default:
      return stringify(row.text) || stringify(row);
  }
}

/** A short label for a row — the tool name, subtype, or level. */
export function rowLabel(row: RawRow): string | undefined {
  switch (row.kind) {
    case "tool_use":
    case "tool_result":
      return row.name;
    case "result":
    case "system":
      return row.subtype;
    case "permission":
      return row.toolName;
    case "notice":
      return row.level;
    case "task_status":
      return row.status;
    case "assistant":
      return row.subagentType ? `subagent:${row.subagentType}` : undefined;
    default:
      return undefined;
  }
}

/** Extract a padded snippet around the first match of `needle`. */
function snippet(text: string, needle: string): string {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return clip(text, SNIPPET_PAD * 2);
  const start = Math.max(0, idx - SNIPPET_PAD);
  const end = Math.min(text.length, idx + needle.length + SNIPPET_PAD);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * Turn an `ImageRef.path` into something the caller can actually open.
 *
 * Only the PORTABLE `assets/<name>` form is resolved against the chat's asset
 * dir, and only via `basename` — mirroring `Store.safeAssetPath`. A stored path
 * is not automatically trustworthy input: `assets/../../secrets.png` would
 * otherwise resolve outside the chat entirely, and this function's whole output
 * is a path an agent is invited to read.
 *
 * Everything else is returned UNTOUCHED, because `ImageRef.path` is also allowed
 * to be a `data:` payload or a remote URL — running those through `resolve()`
 * produced a corrupted path that pointed at nothing.
 */
export function resolveImagePath(path: string, assetsDir: string): string {
  if (!path) return path;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path; // data:, http(s):, file:
  if (isAbsolute(path)) return path;
  const match = /^assets[/\\](.+)$/.exec(path);
  if (!match) return path; // harness-relative or unknown shape — leave it alone
  const name = basename(match[1]!);
  if (!name || name === "." || name === "..") return path;
  return resolve(assetsDir, name);
}

/** Parse a JSONL line, tolerating anything that isn't a JSON object. */
function parseRow(line: string): RawRow | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? (value as RawRow) : null;
  } catch {
    return null;
  }
}

/** Run `work` over `items` with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return out;
}

/* ------------------------------------------------------------ InspectService */

export class InspectService {
  private readonly store: Store;
  private readonly projectConfig?: InspectProjectConfig;
  private readonly memory?: InspectMemory;
  private readonly stableRoots?: () => { dataDir: string; configDir: string } | null;
  private readonly makeStore?: (dataDir: string, configDir: string) => Store;
  /** Lazily-built store for a foreign instance root. */
  private foreign?: Store;

  constructor(opts: InspectServiceOptions) {
    this.store = opts.store;
    this.projectConfig = opts.projectConfig;
    this.memory = opts.memory;
    this.stableRoots = opts.stableRoots;
    this.makeStore = opts.makeStore;
  }

  /**
   * The store for an instance. `stable` is only meaningful from a DEV server: it
   * opens a SECOND Store over the installed deployment's roots.
   *
   * Two distinct not-a-foreign-store cases, deliberately handled differently:
   *   - `stableRoots()` returns null → this process ALREADY IS the installed
   *     instance, so `self` is the very store being asked for. Return it. Making
   *     `instance: "stable"` fail on the stable instance would be absurd.
   *   - no resolver/factory wired at all → we genuinely cannot reach it. THROW,
   *     rather than quietly answering from the dev store, which would return a
   *     confidently wrong answer to a question explicitly about production.
   */
  private storeFor(instance: InspectInstance | undefined): Store {
    if (instance !== "stable") return this.store;
    if (this.foreign) return this.foreign;
    if (!this.stableRoots || !this.makeStore) {
      throw new Error(
        "instance: 'stable' is unavailable — no installed-instance root resolver " +
          "is wired in. Omit `instance` to read this server's own store.",
      );
    }
    const roots = this.stableRoots();
    if (!roots) return this.store; // this process is the installed instance
    this.foreign = this.makeStore(roots.dataDir, roots.configDir);
    return this.foreign;
  }

  /** Absolute path to a chat's transcript in the given store. */
  private transcriptPath(store: Store, chatId: string): string {
    return store.chatTranscriptPath(chatId);
  }

  /** Resolve a project id-or-name to the project record. */
  private async resolveProject(
    store: Store,
    needle: string | undefined,
    fallbackId?: string,
  ): Promise<Project | null> {
    const projects = await store.listProjects();
    if (!needle) {
      return fallbackId ? (projects.find((p) => p.id === fallbackId) ?? null) : null;
    }
    const exact = projects.find((p) => p.id === needle);
    if (exact) return exact;
    const lower = needle.toLowerCase();
    return (
      projects.find((p) => p.name.toLowerCase() === lower) ??
      projects.find((p) => p.name.toLowerCase().includes(lower)) ??
      null
    );
  }

  private toSummary(chat: Chat, projectName?: string): ChatSummary {
    return {
      id: chat.id,
      title: chat.title,
      projectId: chat.projectId,
      projectName,
      status: chat.status,
      archived: chat.archived,
      harness: chat.harness,
      model: chat.model,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt ?? chat.createdAt,
      worktrees: chat.worktrees,
      prs: chat.prs?.map((p) => p.number),
    };
  }

  /* --------------------------------------------------------- findChats */

  async findChats(q: FindChatsQuery = {}): Promise<FindChatsResult> {
    const store = this.storeFor(q.instance);
    const projects = await store.listProjects();
    const nameById = new Map(projects.map((p) => [p.id, p.name]));

    let projectId: string | undefined;
    if (q.project) {
      const project = await this.resolveProject(store, q.project);
      if (!project) {
        return {
          chats: [],
          candidates: 0,
          scanned: 0,
          bytesScanned: 0,
          truncated: false,
          unscanned: 0,
        };
      }
      projectId = project.id;
    }

    const all = await store.listChats(projectId);
    const query = q.query?.trim();
    const limit = Math.max(1, q.limit ?? 20);
    const hitsPerChat = Math.max(1, q.hitsPerChat ?? 3);
    const kinds = q.kinds?.length ? new Set(q.kinds) : new Set(["user", "assistant"]);

    // Metadata filter first — cheap, and it decides which transcripts get opened.
    const candidates = all
      .filter((c) => (q.archived ? true : !c.archived))
      .filter((c) => (q.status ? c.status === q.status : true))
      .filter((c) => {
        const at = c.updatedAt ?? c.createdAt;
        if (q.since !== undefined && at < q.since) return false;
        if (q.before !== undefined && at >= q.before) return false;
        return true;
      })
      .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));

    if (!query) {
      return {
        chats: candidates.slice(0, limit).map((c) => this.toSummary(c, nameById.get(c.projectId))),
        candidates: candidates.length,
        scanned: 0,
        bytesScanned: 0,
        truncated: false,
        unscanned: 0,
      };
    }

    // A title match is free and is usually the strongest signal there is, so it
    // never depends on the scan budget surviving long enough to reach the chat.
    const lower = query.toLowerCase();
    const titleHits = new Set(
      candidates.filter((c) => c.title?.toLowerCase().includes(lower)).map((c) => c.id),
    );

    const budget = q.scanBudgetBytes ?? DEFAULT_SCAN_BUDGET_BYTES;
    let bytesScanned = 0;
    let scanned = 0;
    let stopped = false;

    // Chats that never got opened, for whatever reason — the count that makes
    // `truncated` honest. Incremented only on a BUDGET skip, never on a chat
    // that simply has no transcript (there is nothing there to have missed).
    let skipped = 0;

    const results = await mapLimit(candidates, SCAN_CONCURRENCY, async (chat) => {
      if (stopped) {
        skipped++;
        return null;
      }
      const path = this.transcriptPath(store, chat.id);
      let size = 0;
      try {
        size = (await stat(path)).size;
      } catch {
        return null; // no transcript yet — nothing skipped, nothing to report
      }
      // Re-check AFTER the await: up to SCAN_CONCURRENCY workers were already
      // past the check above when another one exhausted the budget, and without
      // this a small straggler still gets scanned — which would make the
      // reported `scanned`/`bytesScanned` disagree with the cap they claim.
      if (stopped || bytesScanned + size > budget) {
        stopped = true;
        skipped++;
        return null;
      }
      bytesScanned += size;
      scanned++;
      const hits = await this.scanTranscript(path, query, kinds, hitsPerChat);
      return hits.length ? { chat, hits } : null;
    });

    const matched: ChatSummary[] = [];
    for (const r of results) {
      if (!r) continue;
      matched.push({
        ...this.toSummary(r.chat, nameById.get(r.chat.projectId)),
        hits: r.hits,
      });
    }
    // Title-only matches still belong in the answer, ranked after content hits.
    for (const c of candidates) {
      if (matched.length >= limit) break;
      if (!titleHits.has(c.id) || matched.some((m) => m.id === c.id)) continue;
      matched.push({
        ...this.toSummary(c, nameById.get(c.projectId)),
        hits: [{ kind: "title", snippet: c.title }],
      });
    }

    return {
      chats: matched.slice(0, limit),
      candidates: candidates.length,
      scanned,
      bytesScanned,
      truncated: stopped,
      unscanned: skipped,
    };
  }

  /**
   * Stream one transcript, testing the RAW line before parsing. The raw test is a
   * superset of the real one (JSON escaping can hide a match, and a match can
   * land in a field the kind filter excludes), so every raw hit is re-checked
   * against the parsed row — cheap, because raw hits are rare.
   */
  private async scanTranscript(
    path: string,
    query: string,
    kinds: Set<string>,
    maxHits: number,
  ): Promise<ChatHit[]> {
    const needle = query.toLowerCase();
    const hits: ChatHit[] = [];
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (hits.length >= maxHits) break;
        if (!line || !line.toLowerCase().includes(needle)) continue;
        const row = parseRow(line);
        if (!row?.kind || !kinds.has(row.kind)) continue;
        const text = rowText(row);
        if (!text.toLowerCase().includes(needle)) continue;
        hits.push({
          id: row.id,
          ts: row.ts,
          kind: row.kind,
          label: rowLabel(row),
          snippet: snippet(text, query),
        });
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    return hits;
  }

  /* ---------------------------------------------------------- readChat */

  async readChat(q: ReadChatQuery): Promise<ReadChatResult> {
    const store = this.storeFor(q.instance);
    const chat = await store.getChat(q.chatId);
    if (!chat) throw new Error(`No chat with id "${q.chatId}".`);
    const project = await store.getProject(chat.projectId).catch(() => null);

    const view: ChatView = q.view ?? "digest";
    const limit = Math.max(1, q.limit ?? (view === "digest" ? 30 : 60));
    const path = this.transcriptPath(store, q.chatId);

    // One pass: histogram + image inventory + the rows this view wants. A second
    // pass to count kinds would double the I/O on an 18 MB transcript.
    const kindCounts: Record<string, number> = {};
    const images: ChatImage[] = [];
    const userMessages: RawRow[] = [];
    const problems: RawRow[] = [];
    const kept: RawRow[] = [];
    let totalRows = 0;
    let afterSeen = !q.afterId;
    let doneKeeping = false;

    const wanted = q.kinds?.length ? new Set(q.kinds) : null;
    const needle = q.query?.trim().toLowerCase();
    const assetsDir = store.chatAssetsDir(q.chatId);

    // A chat can legitimately have no transcript yet — created but never spoken
    // to, which is 22 of the ~280 chats in the live store. Streaming a file that
    // isn't there throws ENOENT and would fail the whole tool over a chat that
    // is simply empty, so report the empty transcript it actually is (what
    // Store.readMessages / lastActivityAt already do).
    const stream = existsSync(path) ? createReadStream(path, { encoding: "utf8" }) : null;
    const lines = stream ? createInterface({ input: stream, crlfDelay: Infinity }) : null;
    try {
      for await (const line of lines ?? []) {
        if (!line) continue;
        const row = parseRow(line);
        if (!row) continue;
        totalRows++;
        const kind = row.kind ?? "unknown";
        kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;

        for (const img of row.images ?? []) {
          images.push({
            path: resolveImagePath(img.path, assetsDir),
            mimeType: img.mimeType,
            alt: img.alt,
            rowId: row.id,
            ts: row.ts,
          });
        }

        if (view === "digest") {
          if (kind === "user") userMessages.push(row);
          if (kind === "notice" || (kind === "tool_result" && row.isError) || (kind === "result" && row.isError)) {
            problems.push(row);
          }
        }

        // Cursor handling mirrors Store.readMessages: afterId is exclusive and
        // opens the window, beforeId is exclusive and closes it. `doneKeeping`
        // stops COLLECTING rows, never scanning — kindCounts and the image
        // inventory describe the whole transcript however small the window is.
        if (doneKeeping) continue;
        if (!afterSeen) {
          if (row.id === q.afterId) afterSeen = true;
          continue;
        }
        if (q.beforeId && row.id === q.beforeId) {
          doneKeeping = true;
          continue;
        }
        if (wanted && !wanted.has(kind)) continue;
        if (needle && !rowText(row).toLowerCase().includes(needle)) continue;
        if (view === "grep") {
          // Grep returns the FIRST `limit` matches, so the cap is checked BEFORE
          // pushing — testing it afterwards let the (limit+1)th match ride along.
          if (kept.length >= limit) {
            doneKeeping = true;
            continue;
          }
          kept.push(row);
        } else {
          kept.push(row);
          // Keep the NEWEST `limit`: drop from the front rather than growing a
          // whole 18 MB transcript in memory just to slice its tail.
          if (kept.length > limit) kept.shift();
        }
      }
    } finally {
      lines?.close();
      stream?.destroy();
    }

    let transcriptBytes: number | undefined;
    try {
      transcriptBytes = (await stat(path)).size;
    } catch {
      transcriptBytes = 0;
    }

    const rows = q.full ? kept : kept.map((r) => clipRow(r));
    return {
      chat: { ...this.toSummary(chat, project?.name), transcriptBytes },
      view,
      kindCounts,
      totalRows,
      rows,
      images,
      userMessages: view === "digest" ? userMessages.map((r) => clipRow(r)) : undefined,
      problems: view === "digest" ? problems.slice(-10).map((r) => clipRow(r)) : undefined,
      truncated: totalRows > rows.length,
    };
  }

  /* ------------------------------------------------------- projectInfo */

  async projectInfo(q: ProjectInfoQuery, callerProjectId?: string): Promise<ProjectInfoResult> {
    const store = this.storeFor(q.instance);
    const project = await this.resolveProject(store, q.project, callerProjectId);
    if (!project) {
      throw new Error(
        q.project
          ? `No project matching "${q.project}".`
          : "No project to describe — pass `project` with an id or name.",
      );
    }

    // `.dispatch/` config is only cached for the RUNNING instance's projects;
    // a foreign instance's config isn't loaded here (the repo on disk is the
    // same, but its watcher/cache belongs to that server).
    const cfg = q.instance === "stable" ? undefined : this.projectConfig?.get(project.id);
    const config = (cfg?.config ?? null) as {
      instructionsText?: string;
      agents?: { id?: string; name?: string }[];
      modes?: { id?: string; name?: string }[];
      skills?: { name?: string }[];
      mcpServers?: { name?: string }[];
    } | null;

    const named = (items: { id?: string; name?: string }[] | undefined): string[] =>
      (items ?? []).map((i) => i.name ?? i.id ?? "?").filter(Boolean);

    const recentCount = Math.max(0, q.chats ?? 5);
    let recentChats: ChatSummary[] = [];
    if (recentCount > 0) {
      const chats = await store.listChats(project.id);
      recentChats = chats
        .filter((c) => !c.archived)
        .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
        .slice(0, recentCount)
        .map((c) => this.toSummary(c, project.name));
    }

    let memoryIndex: string | undefined;
    if (q.memory && this.memory && q.instance !== "stable") {
      memoryIndex = await this.memory.index(project.id).catch(() => undefined);
    }

    return {
      project,
      configSourceDir: cfg?.sourceDir ?? null,
      configErrors: cfg?.errors ?? [],
      instructions: config?.instructionsText ? clip(config.instructionsText, 4_000) : undefined,
      agents: named(config?.agents),
      modes: named(config?.modes),
      skills: named(config?.skills as { id?: string; name?: string }[] | undefined),
      subApps: (project.subApps ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        ports: s.ports,
        url: s.url,
      })),
      mcpServers: named(config?.mcpServers as { id?: string; name?: string }[] | undefined),
      memoryIndex,
      recentChats,
    };
  }
}

/** Clip the bulky payloads on a row so one result can't blow the token cap. */
function clipRow(row: RawRow): RawRow {
  const out: RawRow = { ...row };
  if (typeof out.text === "string") out.text = clip(out.text, FIELD_CLIP);
  if (typeof out.thinking === "string") out.thinking = clip(out.thinking, FIELD_CLIP);
  if (typeof out.result === "string") out.result = clip(out.result, FIELD_CLIP);
  if (out.input !== undefined) out.input = clip(stringify(out.input), FIELD_CLIP);
  if (out.content !== undefined) out.content = clip(stringify(out.content), FIELD_CLIP);
  return out;
}
