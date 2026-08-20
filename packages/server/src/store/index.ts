/**
 * Store — the persistence layer. Two roots, two very different storage models,
 * split along how often each is written.
 *
 * CONFIG root (`configDir`) — low-write, shared between instances, JSON FILES:
 *   config.json                  — global app settings
 *   projects/<id>.json           — Project
 *   projects/<id>/memory/        — project agent-memory (+ memory-stats.json)
 *   agents/<id>.json             — AgentConfig
 *   modes/<id>.json              — ModeConfig
 *
 * These stay files deliberately. They are ~41 KB in total and rewritten by hand
 * about as often as they are by the app; project memory is git-committed
 * markdown whose diffability is the point. A database would buy nothing and cost
 * the ability to fix one with an editor.
 *
 * STATE root (`dataDir`) — high-write, per-instance, SQLITE (`state.db`):
 *   runner, mcp_port_lease, worktree, terminal, terminal_line, pr, checkpoint
 *
 * …plus what is still on the filesystem there, on purpose:
 *   chats/<id>/chat.json         — Chat
 *   chats/<id>/messages.jsonl    — ChatMessage rows
 *   chats/<id>/assets/           — pasted/received images, video, audio, files
 *   auth-sessions.json           — refresh families (owned by AuthService)
 *
 * Assets are FILES and stay files. `ImageRefSchema.path` is already "path under
 * the chat's assets/ dir", the media is 582 MB of PNG/JPG/video against a 214 MB
 * transcript corpus, and only 158 of 2730 are duplicates — so there is no dedup
 * win to chase, and putting hundreds of megabytes of opaque blobs into the same
 * file as the rows would make every backup, every VACUUM and every range request
 * worse. `writeChatAsset` / `readChatAsset` / `openChatAsset` (and the traversal
 * guard in `safeAssetPath`) are unchanged.
 *
 * WHY THE STATE ROOT MOVED. Every one of those tables used to be a whole-file
 * read-modify-write JSON map guarded by an in-process {@link KeyedMutex}:
 * `saveCheckpoint` rewrote all 2.4 MB of `checkpoints.json` to add one entry,
 * once per turn, and it only ever grew. The mutex also meant two PROCESSES
 * sharing a state root would silently drop each other's writes, which is the
 * reason the dev and stable instances were given separate `data/` dirs.
 *
 * SQLite + WAL retires that hazard: concurrent writers serialize properly and a
 * reader gets a consistent snapshot rather than whatever a half-finished rewrite
 * left behind. Keeping the two state roots apart is now a POLICY choice (a dev
 * crash shouldn't cost the stable instance its rollback points), not a
 * correctness requirement — and the one place that always crossed the line,
 * InspectService opening the installed instance's store from dev (see
 * `makeStore` in services/container.ts), now reads a snapshot instead of JSON
 * files caught mid-rename.
 *
 * Everything is still zod-validated on the way in AND out, so corrupt or legacy
 * data surfaces loudly rather than propagating. The exception is deliberate and
 * documented where it lives: `services/inspect.ts` duck-types transcript rows
 * because it reads months of older schema versions.
 *
 * The database is opened LAZILY and must be {@link Store.close}d — on Windows an
 * open SQLite handle blocks `rm -r` of the directory containing it.
 */
import { join, resolve, relative, isAbsolute, basename } from "node:path";
import {
  readdir,
  mkdir,
  rm,
  stat,
  copyFile,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import * as z from "zod";
import {
  ProjectSchema,
  type Project,
  ChatSchema,
  type Chat,
  AgentConfigSchema,
  type AgentConfig,
  ModeConfigSchema,
  type ModeConfig,
  ChatMessageSchema,
  type ChatMessage,
  RunnerInstanceSchema,
  type RunnerInstance,
  CheckpointSchema,
  type Checkpoint,
  WorktreeRecordSchema,
  type WorktreeRecord,
  TerminalRecordSchema,
  type TerminalRecord,
  TerminalLineSchema,
  type TerminalLineRecord,
  PrRecordSchema,
  type PrRecord,
  McpPortLeaseSchema,
  type McpPortLease,
  ShellTranscriptFilterSchema,
} from "@dispatch/shared";
import { HarnessSettingsSchema, UpdateChannelSchema } from "@dispatch/shared";
import {
  KeyedMutex,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  readJsonlLines,
  readJsonlTail,
} from "./fsq.js";
import { StateDb, assertStateMigrated } from "./db.js";

/** Global app settings (config.json). Kept permissive by design. */
export const AppSettingsSchema = z.object({
  /** `system` defers to the browser's `prefers-color-scheme`; the client
   *  resolves it and caches the result in localStorage so the first paint has
   *  an answer before this endpoint can respond (see client stores/theme.ts). */
  theme: z.enum(["dark", "light", "system"]).default("dark"),
  defaultModeId: z.string().optional(),
  /** App-wide runtime selection, per-runtime defaults, and context budgets. */
  harness: HarnessSettingsSchema.optional(),
  webhook: z
    .object({
      kind: z.enum(["ntfy", "pushover"]).optional(),
      url: z.string().optional(),
      enabled: z.boolean().default(false),
    })
    .optional(),
  /**
   * Native SDK auto-compaction: when the context window fills, the session
   * summarizes itself and continues (rather than erroring). Enabled by default;
   * `window` optionally overrides the SDK's compaction reserve (tokens). Applied
   * per session via `Options.settings` (see SessionBroker.buildOptions).
   */
  autoCompact: z
    .object({
      enabled: z.boolean().default(true),
      window: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * App-wide default for showing the context Dispatch attaches on your behalf
   * (surfaced memories, repo snapshots) in a transcript. The bottom of a
   * three-level fallback — chat, then project manifest, then this, then off.
   * Off by default: most turns carry some injected context, and a disclosure
   * row on every one of them is noise until you go looking for it.
   *
   * Optional rather than `.default(false)` so every existing AppSettings
   * literal (tests, DEFAULT_SETTINGS) stays valid — and because "unset" and
   * "false" mean the same thing at the bottom of a fallback chain.
   */
  showInjectedContext: z.boolean().optional(),
  /** App-wide transcript-shell defaults. Unset resolves to every category on. */
  shellFilter: ShellTranscriptFilterSchema.optional(),
  /**
   * Which release stream this install follows. Lives here rather than in the
   * payload because `config/` is the one directory install and upgrade never
   * touch — a subscription that reset on every update would be no subscription.
   *
   * Optional rather than `.default("stable")` so every existing AppSettings
   * literal (tests, DEFAULT_SETTINGS) stays valid; unset reads as `stable`,
   * which is also what every install predating channels was on.
   */
  updateChannel: UpdateChannelSchema.optional(),
  /**
   * Policy for `mcp__manager__spawn_chat` — an agent starting ANOTHER chat.
   * `autoApprove` off (the default, and the reason this is opt-in rather than
   * opt-out) means every spawn stops for a permission prompt the human answers;
   * the tool itself takes no bypass argument, so this setting is the ONLY way
   * past the gate. A project's manifest may override it for that project.
   */
  spawnChat: z
    .object({
      autoApprove: z.boolean().default(false),
    })
    .optional(),
  /**
   * Authentication is deliberately optional. Existing config.json files have no
   * auth key, and that absence MUST keep an upgraded installation open.
   */
  auth: z
    .object({
      enabled: z.boolean().default(false),
      firstRunDismissed: z.boolean().default(false),
      canonicalUrl: z.string().url().optional(),
      rpId: z.string().min(1).optional(),
      /**
       * Whether a session's PUBLIC ip may be sent to the geolocation provider
       * that fills in ISP and city on the Active sessions list. Opt-OUT: unset
       * reads as on, which keeps every existing config.json meaning what it did.
       * Private and loopback addresses are never looked up whatever this says.
       */
      ipLookup: z.boolean().optional(),
    })
    .optional(),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

const DEFAULT_SETTINGS: AppSettings = { theme: "dark" };

/**
 * Row id off a raw JSONL line WITHOUT parsing it. `id` is the first key of every
 * persisted row (MessageBase is spread first in every message schema, and
 * JSON.stringify preserves insertion order), so the anchored match hits on the
 * fast path; anything else falls back to a real parse rather than guessing.
 */
function rowIdOf(line: string): string | null {
  const fast = /^\{"id":"([^"\\]+)"/.exec(line);
  if (fast) return fast[1]!;
  try {
    const obj = JSON.parse(line) as { id?: unknown };
    return typeof obj.id === "string" ? obj.id : null;
  } catch {
    return null;
  }
}

/** Whether a raw JSONL line is the row with this id. */
function lineHasId(line: string, id: string): boolean {
  return rowIdOf(line) === id;
}

/** Parse + validate a window of raw JSONL lines, tolerating a torn last line. */
function parseMessageLines(lines: string[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      out.push(ChatMessageSchema.parse(JSON.parse(lines[i]!)));
    } catch (err) {
      // A malformed FINAL line can be a torn append (a write in flight); anything
      // earlier is real corruption and should surface.
      if (i === lines.length - 1) break;
      throw err;
    }
  }
  return out;
}

/**
 * Decode a row body LENIENTLY: `null` when it doesn't parse as JSON, and `null`
 * when it doesn't satisfy the schema.
 *
 * The two failures have to be treated alike. As one JSON document per file, a
 * malformed row could not exist — the whole file parsed or it didn't. Row by
 * row, a body this build can't even `JSON.parse` is exactly the case the
 * tolerant readers below exist for, and letting it throw would cost the entire
 * PR roster (or every session's port lease) for one corrupt record.
 */
function decodeRow<T>(schema: z.ZodType<T>, body: unknown): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(String(body));
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Rebuild a TerminalLineRecord from its three columns (see the schema). */
function toTerminalLine(row: Record<string, unknown>): TerminalLineRecord {
  return TerminalLineSchema.parse({ ts: row.ts, stream: row.stream, chunk: row.chunk });
}

export class Store {
  private readonly mutex = new KeyedMutex();
  /**
   * Parsed `chat.json` by chat id. Write-through; see {@link readChatRecord} for
   * why an in-memory copy is authoritative here and what still isn't cached.
   */
  private readonly chatCache = new Map<string, Chat>();
  private readonly configDir: string;
  private readonly db: StateDb;
  private freshInstall = true;

  /**
   * @param dataDir   STATE root (`state.db` + chats) — per-instance.
   * @param configDir CONFIG root (settings, projects, agents, modes) — shareable
   *                  between instances. Defaults to `dataDir` for a single-root
   *                  layout, which is what every existing caller and test uses.
   */
  constructor(
    private readonly dataDir: string,
    configDir?: string,
  ) {
    this.configDir = configDir ?? dataDir;
    this.db = new StateDb(dataDir);
  }

  /**
   * Release the state database. Idempotent, and safe to call on a store that
   * never opened one.
   *
   * NOT optional on Windows: SQLite opens its files without FILE_SHARE_DELETE,
   * so `rm -r` of the directory holding an open database fails EPERM. That is
   * every test's `afterEach` teardown, and the server's own `dispose()`.
   */
  close(): void {
    this.db.close();
  }

  /**
   * The state database handle.
   *
   * Every OTHER table in this file is reached through a typed method on this
   * class, and that stays the rule for anything storing an entity. The exception
   * this exists for is the metrics ledger (services/metrics.ts): it stores no
   * entity, and its entire read surface is aggregation SQL — bucketed series,
   * faceted totals, dynamic group-by. Three hundred lines of that on `Store`
   * would say nothing about the store and would bury the entity methods that do.
   *
   * It is exposed rather than duplicated because the alternative is a SECOND
   * database file, which means a second connection, a second migration list, and
   * a second thing to close before Windows will let you delete the data dir.
   */
  get stateDb(): StateDb {
    return this.db;
  }

  /**
   * `all()` typed as the loose row shape `node:sqlite` actually returns. Every
   * caller here immediately narrows a known column, so a shared cast beats
   * repeating it at three dozen call sites.
   */
  private rows(sql: string, ...params: Array<string | number>): Array<Record<string, unknown>> {
    return this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  }

  /* ------------------------------------------------------------ paths */

  private projectsDir() {
    return join(this.configDir, "projects");
  }
  /**
   * Absolute path to a project's agent-memory dir — one markdown file per memory
   * plus a generated `MEMORY.md` index. Lives beside the `projects/<id>.json`
   * entity (a `<id>` DIRECTORY next to the `<id>.json` FILE; no collision, and
   * `listProjects` only reads `.json` files). Owned by the MemoryService, which
   * creates it on demand.
   */
  projectMemoryDir(projectId: string) {
    return join(this.projectsDir(), projectId, "memory");
  }
  /**
   * Sidecar ACCESS-telemetry file for a project's memories (how often each is
   * recalled/surfaced). Deliberately in the manager's own store — NEVER the
   * committable `.dispatch/memory/` dir — so it's runtime signal that can't
   * churn the repo. Owned by {@link MemoryStatsStore}; created on demand.
   */
  projectMemoryStatsFile(projectId: string) {
    return join(this.projectsDir(), projectId, "memory-stats.json");
  }
  private agentsDir() {
    return join(this.configDir, "agents");
  }
  private modesDir() {
    return join(this.configDir, "modes");
  }
  private chatsDir() {
    return join(this.dataDir, "chats");
  }
  private chatDir(chatId: string) {
    return join(this.chatsDir(), chatId);
  }
  private chatFile(chatId: string) {
    return join(this.chatDir(chatId), "chat.json");
  }
  private messagesFile(chatId: string) {
    return join(this.chatDir(chatId), "messages.jsonl");
  }
  /**
   * Absolute path to a chat's TRANSCRIPT file, for readers that must stream it
   * rather than take it whole. `readMessages` slurps the file to window it —
   * correct for one chat, ruinous for the InspectService's sweep across every
   * transcript in the store, which streams line-by-line under a byte budget.
   */
  chatTranscriptPath(chatId: string) {
    return this.messagesFile(chatId);
  }
  /** Absolute path to a chat's asset dir (images). Created on demand. */
  chatAssetsDir(chatId: string) {
    return join(this.chatDir(chatId), "assets");
  }
  private settingsFile() {
    return join(this.configDir, "config.json");
  }
  /** Stable auth identities and their provider credentials share the config root. */
  authFile() {
    return join(this.configDir, "auth.json");
  }
  /** Refresh families are high-write and must never be shared by two processes. */
  authSessionsFile() {
    return join(this.dataDir, "auth-sessions.json");
  }
  /** Live-process marker used to make offline owner recovery fail closed. */
  authRecoveryLockFile() {
    return join(this.dataDir, "auth-recovery.lock");
  }

  /**
   * Create both roots' trees and open the state database. Idempotent; call once
   * at boot.
   *
   * Opening here rather than on first use is deliberate: a state root written by
   * a newer schema, or a Node without FTS5, should stop the server at boot with
   * a message — not surface as one failing request an hour in.
   */
  async init(): Promise<void> {
    // BEFORE the database is opened. Opening it creates `state.db`, and an empty
    // one sitting next to un-migrated JSON is indistinguishable from a migrated
    // store — the check would never fire again.
    assertStateMigrated(this.dataDir);
    // Capture this before seedDefaultsIfEmpty creates the standard project and
    // modes. Auth uses it to show first-run setup only to genuinely new data,
    // never as a surprise blocker after upgrading an existing installation.
    const existing = async (dir: string): Promise<boolean> => {
      try { return (await readdir(dir)).length > 0; } catch { return false; }
    };
    // Any legacy file at either exact root proves this is an upgrade. Looking
    // only in today's entity directories misclassified old roots containing
    // just runners.json/checkpoints.json and showed them a first-run overlay.
    const dataHadContent = await existing(this.dataDir);
    const sameRoot = resolve(this.dataDir) === resolve(this.configDir);
    const configHadContent = sameRoot ? dataHadContent : await existing(this.configDir);
    this.freshInstall = !dataHadContent && !configHadContent;
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.configDir, { recursive: true });
    await Promise.all([
      mkdir(this.projectsDir(), { recursive: true }),
      mkdir(this.agentsDir(), { recursive: true }),
      mkdir(this.modesDir(), { recursive: true }),
      mkdir(this.chatsDir(), { recursive: true }),
    ]);
    this.db.open();
  }

  /** Snapshot taken before boot-time seeding; stable for this process lifetime. */
  isFreshInstall(): boolean {
    return this.freshInstall;
  }

  /* -------------------------------------------------- generic helpers */

  private async listDir(dir: string): Promise<string[]> {
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name.slice(0, -".json".length));
  }

  private async readEntity<T>(
    path: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    const raw = await readJson(path);
    if (raw === undefined) return null;
    return schema.parse(raw);
  }

  private async writeEntity<T>(
    key: string,
    path: string,
    schema: z.ZodType<T>,
    value: T,
  ): Promise<T> {
    const validated = schema.parse(value);
    await this.mutex.run(key, () => writeJsonAtomic(path, validated));
    return validated;
  }

  /* ---------------------------------------------------------- projects */

  async listProjects(): Promise<Project[]> {
    const ids = await this.listDir(this.projectsDir());
    const all = await Promise.all(ids.map((id) => this.getProject(id)));
    return all.filter((p): p is Project => p !== null);
  }
  getProject(id: string): Promise<Project | null> {
    return this.readEntity(join(this.projectsDir(), `${id}.json`), ProjectSchema);
  }
  saveProject(project: Project): Promise<Project> {
    return this.writeEntity(
      `project:${project.id}`,
      join(this.projectsDir(), `${project.id}.json`),
      ProjectSchema,
      project,
    );
  }
  async deleteProject(id: string): Promise<void> {
    await this.mutex.run(`project:${id}`, () =>
      rm(join(this.projectsDir(), `${id}.json`), { force: true }),
    );
  }

  /* ------------------------------------------------------------ agents */

  async listAgents(): Promise<AgentConfig[]> {
    const ids = await this.listDir(this.agentsDir());
    const all = await Promise.all(ids.map((id) => this.getAgent(id)));
    return all.filter((a): a is AgentConfig => a !== null);
  }
  getAgent(id: string): Promise<AgentConfig | null> {
    return this.readEntity(join(this.agentsDir(), `${id}.json`), AgentConfigSchema);
  }
  saveAgent(agent: AgentConfig): Promise<AgentConfig> {
    return this.writeEntity(
      `agent:${agent.id}`,
      join(this.agentsDir(), `${agent.id}.json`),
      AgentConfigSchema,
      agent,
    );
  }
  async deleteAgent(id: string): Promise<void> {
    await this.mutex.run(`agent:${id}`, () =>
      rm(join(this.agentsDir(), `${id}.json`), { force: true }),
    );
  }

  /* ------------------------------------------------------------- modes */

  async listModes(): Promise<ModeConfig[]> {
    const ids = await this.listDir(this.modesDir());
    const all = await Promise.all(ids.map((id) => this.getMode(id)));
    return all.filter((m): m is ModeConfig => m !== null);
  }
  getMode(id: string): Promise<ModeConfig | null> {
    return this.readEntity(join(this.modesDir(), `${id}.json`), ModeConfigSchema);
  }
  saveMode(mode: ModeConfig): Promise<ModeConfig> {
    return this.writeEntity(
      `mode:${mode.id}`,
      join(this.modesDir(), `${mode.id}.json`),
      ModeConfigSchema,
      mode,
    );
  }
  async deleteMode(id: string): Promise<void> {
    await this.mutex.run(`mode:${id}`, () =>
      rm(join(this.modesDir(), `${id}.json`), { force: true }),
    );
  }

  /* ------------------------------------------------------------- chats */

  /**
   * Every chat, newest-activity `updatedAt` stamped on, optionally one project's.
   *
   * The `projectId` filter is applied AFTER the read on purpose: chats are keyed
   * by id on disk with no per-project index, so there is nothing to narrow the
   * scan to. That makes this O(all chats) for every caller, and the callers are
   * not who you would hope — WorktreeDetector runs one `listChats(project.id)`
   * per active project on a 4s timer, so a store of 353 chats re-read 353
   * `chat.json` files two or three times every four seconds, at ~110ms a pass
   * with most of it holding the event loop.
   *
   * The RECORDS are therefore cached in memory (see {@link readChatRecord}) and
   * the disk read skipped when a cached copy exists. `lastActivityAt` still
   * stats the transcript every call — see there for why that one stays honest.
   */
  async listChats(projectId?: string): Promise<Chat[]> {
    // `readdir` is the only unconditional disk hit (~0.4ms for 353 entries), and
    // it is what keeps the cache fresh in the direction that matters: a chat
    // dir added or removed underneath us is seen on the very next call.
    let entries;
    try {
      entries = await readdir(this.chatsDir(), { withFileTypes: true });
    } catch {
      return [];
    }
    const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    // Evict records whose directory is gone. Unconditional rather than gated on
    // a size comparison: one chat removed and another added between two calls
    // leaves the count unchanged, and the stale record would then survive to be
    // handed out by `getChat` — which reads the cache directly and has no
    // `readdir` of its own to correct it.
    const live = new Set(ids);
    for (const id of this.chatCache.keys()) {
      if (!live.has(id)) this.chatCache.delete(id);
    }
    const all = await Promise.all(ids.map((id) => this.getChat(id)));
    const chats = all.filter((c): c is Chat => c !== null);
    return projectId ? chats.filter((c) => c.projectId === projectId) : chats;
  }

  async getChat(id: string): Promise<Chat | null> {
    const chat = await this.readChatRecord(id);
    return chat && { ...chat, updatedAt: await this.lastActivityAt(chat) };
  }

  /**
   * The persisted chat record, served from {@link chatCache} when it's there.
   *
   * Safe to cache because this process is the ONLY writer of `dataDir`. That is
   * the invariant the entire state root rests on — `runners.json` and
   * `checkpoints.json` are whole-file read-modify-write maps guarded by an
   * IN-PROCESS mutex, which is precisely why stable and dev share `config/` but
   * never `data/` (see RUNNING.md). So every mutation of a chat record goes
   * through `saveChat` / `patchChat` / `deleteChat` below, and each writes
   * through to this map.
   *
   * The one tool that writes `dataDir` from outside is `tools/app/backsync.mjs`,
   * and it stays correct here: it ADDS chat directories (seen by the `readdir`
   * in `listChats`) and EXTENDS transcripts (seen by `lastActivityAt`, which is
   * deliberately not cached). It never rewrites an existing `chat.json`.
   */
  private async readChatRecord(id: string): Promise<Chat | null> {
    const hit = this.chatCache.get(id);
    if (hit) return hit;
    const chat = await this.readEntity(this.chatFile(id), ChatSchema);
    if (chat) this.cacheChat(chat);
    return chat;
  }

  /**
   * Take a private copy into the cache.
   *
   * The clone matters because the object a writer hands us is the same one it
   * goes on to publish on the bus (`saveChat`'s return value IS the
   * `chat-update` payload). Nothing mutates a Chat in place today, but a cached
   * record is now process-lifetime state, so an in-place edit anywhere would
   * stop being a transient bug and start being a wrong answer that outlives the
   * request. One structuredClone per MUTATION is far too cheap to argue about;
   * cloning per read would hand the whole saving back.
   */
  private cacheChat(chat: Chat): void {
    this.chatCache.set(chat.id, structuredClone(chat));
  }

  /**
   * When this chat was last ACTIVE, which is what "updatedAt" has to mean for a
   * recency-sorted sidebar.
   *
   * `chat.json` is only rewritten when the chat RECORD changes (title, mode,
   * model, a new session id) — appending a transcript row doesn't touch it. So a
   * chat that talked for an hour inside one session kept the `updatedAt` it was
   * given at session start, and after a reload the sidebar sorted a whole
   * history by near-creation timestamps. The transcript's own mtime is the
   * truthful clock, costs one stat, and repairs existing chats with no
   * migration. Live events still advance the client's order between reloads.
   *
   * Deliberately NOT covered by {@link chatCache}: the transcript is appended to
   * constantly, and `backsync.mjs` extends it from outside this process, so a
   * cached stamp would freeze the sidebar's ordering. One stat per chat is cheap
   * and — unlike the `existsSync` guards this used to sit behind — asynchronous,
   * so it does not hold the event loop.
   */
  private async lastActivityAt(chat: Chat): Promise<number> {
    try {
      const { mtimeMs } = await stat(this.messagesFile(chat.id));
      return Math.max(chat.updatedAt ?? 0, Math.round(mtimeMs));
    } catch {
      return chat.updatedAt ?? chat.createdAt; // no transcript yet
    }
  }
  async saveChat(chat: Chat): Promise<Chat> {
    const validated = ChatSchema.parse(chat);
    await mkdir(this.chatDir(chat.id), { recursive: true });
    await this.mutex.run(`chat:${chat.id}`, () =>
      writeJsonAtomic(this.chatFile(chat.id), validated),
    );
    // Write through AFTER the write lands, never before: a rejected write must
    // not leave the cache asserting a state that isn't on disk.
    this.cacheChat(validated);
    return validated;
  }

  /**
   * Merge a partial record while holding the chat file's lock. Status changes
   * race with title/session metadata during a live turn; a get-then-save pair
   * outside this lock can let either whole-file rewrite erase the other.
   */
  async patchChat(id: string, patch: Partial<Chat>): Promise<Chat | null> {
    return this.mutex.run(`chat:${id}`, async () => {
      const current = await this.readChatRecord(id);
      if (!current) return null;
      const validated = ChatSchema.parse({ ...current, ...patch, id });
      await writeJsonAtomic(this.chatFile(id), validated);
      this.cacheChat(validated);
      return validated;
    });
  }
  async deleteChat(id: string): Promise<void> {
    await this.mutex.run(`chat:${id}`, () =>
      rm(this.chatDir(id), { recursive: true, force: true }),
    );
    this.chatCache.delete(id);
    await this.deleteCheckpoints(id);
  }

  /* -------------------------------------------------- chat messages (JSONL) */

  async appendMessage(msg: ChatMessage): Promise<ChatMessage> {
    const validated = ChatMessageSchema.parse(msg);
    await mkdir(this.chatDir(validated.chatId), { recursive: true });
    await this.mutex.run(`messages:${validated.chatId}`, () =>
      appendJsonl(this.messagesFile(validated.chatId), validated),
    );
    return validated;
  }

  /**
   * Read a WINDOW of a chat's transcript, newest-biased.
   *
   * The window is sliced over RAW lines and only the surviving page is
   * JSON.parse'd + zod-validated: a long transcript is multi-megabyte with
   * thousands of rows, and validating all of them just to return the newest 200
   * was the dominant cost of opening a big chat. Row ids are matched with a cheap
   * scan over the raw line (see {@link lineHasId}) so cursor resolution doesn't
   * force a full parse either.
   *
   *   limit    — keep at most N rows (the NEWEST N of whatever the cursors left).
   *   afterId  — only rows strictly after this id (forward tail read).
   *   beforeId — only rows strictly before this id (backward paging: pass the
   *              oldest row you already hold to get the page above it).
   *
   * A CURSORLESS `limit` never touches the older bytes at all: it reads backwards
   * from EOF (see {@link readJsonlTail}). That is the shape opening a chat asks
   * for, and the one the session broker and the titler ask for, and slurping the
   * whole file to serve it cost 38ms of the 40ms it took to answer with the
   * newest 200 rows of a 17.8MB transcript — all of it on the main thread, with
   * every other request stalled behind it. Cursor paging still reads whole,
   * because resolving a cursor means finding a row that could be anywhere.
   */
  async readMessages(
    chatId: string,
    opts: { limit?: number; afterId?: string; beforeId?: string } = {},
  ): Promise<ChatMessage[]> {
    if (
      opts.limit !== undefined &&
      opts.limit >= 0 &&
      opts.afterId === undefined &&
      opts.beforeId === undefined
    ) {
      return parseMessageLines(
        await readJsonlTail(this.messagesFile(chatId), opts.limit),
      );
    }
    let lines = await readJsonlLines(this.messagesFile(chatId));
    if (opts.afterId) {
      const idx = lines.findIndex((l) => lineHasId(l, opts.afterId!));
      if (idx >= 0) lines = lines.slice(idx + 1);
    }
    if (opts.beforeId) {
      const idx = lines.findIndex((l) => lineHasId(l, opts.beforeId!));
      if (idx >= 0) lines = lines.slice(0, idx);
    }
    if (opts.limit !== undefined && opts.limit >= 0) {
      lines = lines.slice(Math.max(0, lines.length - opts.limit));
    }
    return parseMessageLines(lines);
  }

  /**
   * Walk a transcript's rows WITHOUT validating them.
   *
   * For scanners that read a couple of fields off each row and defend
   * themselves anyway — the WorktreeDetector rebuilding which chat cut which
   * branch is the whole reason this exists. It used `readMessages(chatId)` with
   * no limit, and zod is 77% of that: on a real 17.8MB / 8,235-row transcript,
   * `JSON.parse` of every row is 103ms and `ChatMessageSchema.parse` of the
   * results is another 343ms. Across one project's 157 chats and 105,314 rows
   * that was a 3.3-SECOND main-thread stall on the detector's first pass after a
   * restart, to answer questions that never needed a validated union.
   *
   * Rows arrive as plain parsed JSON, so callers must narrow what they touch. A
   * row that doesn't parse is SKIPPED rather than thrown on: this is a
   * best-effort scan over history, and one torn line must not cost the caller
   * every row after it.
   */
  async scanMessages(
    chatId: string,
    visit: (row: Record<string, unknown>) => void,
  ): Promise<void> {
    for (const line of await readJsonlLines(this.messagesFile(chatId))) {
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row && typeof row === "object") visit(row as Record<string, unknown>);
    }
  }

  /**
   * Read specific rows by id (order follows the file, not the `ids` argument).
   * Backs hydrate-on-expand: the transcript ships lean rows, and expanding a card
   * pulls back the real `tool_use.input` / `tool_result.content` for just it.
   */
  async readMessagesByIds(chatId: string, ids: string[]): Promise<ChatMessage[]> {
    if (ids.length === 0) return [];
    const wanted = new Set(ids);
    const lines = await readJsonlLines(this.messagesFile(chatId));
    const hits = lines.filter((l) => {
      for (const id of wanted) if (lineHasId(l, id)) return true;
      return false;
    });
    return parseMessageLines(hits);
  }

  /* ------------------------------------------------ chat assets (images) */

  /**
   * Resolve `<chat assets>/<name>` guarding against traversal. `basename()`
   * strips any path components, so `../` / absolute names can never escape the
   * chat's own assets dir. Returns null for an empty / dot name.
   */
  private safeAssetPath(chatId: string, name: string): string | null {
    const base = basename(String(name));
    if (!base || base === "." || base === "..") return null;
    const dir = this.chatAssetsDir(chatId);
    const abs = resolve(dir, base);
    const rel = relative(dir, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return abs;
  }

  /** Persist a chat asset (image) under assets/. Returns the relative path. */
  async writeChatAsset(chatId: string, name: string, data: Buffer): Promise<string> {
    const abs = this.safeAssetPath(chatId, name);
    if (!abs) throw new Error(`invalid asset name: ${name}`);
    await mkdir(this.chatAssetsDir(chatId), { recursive: true });
    await this.mutex.run(`asset:${chatId}:${basename(name)}`, () =>
      fsWriteFile(abs, data),
    );
    return `assets/${basename(name)}`;
  }

  /** Read a chat asset by basename. Null when absent or the name escapes. */
  async readChatAsset(chatId: string, name: string): Promise<Buffer | null> {
    const abs = this.safeAssetPath(chatId, name);
    if (!abs || !existsSync(abs)) return null;
    return fsReadFile(abs);
  }

  /**
   * Copy a file on disk into the chat's assets. Returns the relative path.
   *
   * `copyFile` rather than read-then-write: a referenced asset can be hundreds
   * of megabytes, and buffering one into a Buffer purely to hand it back to the
   * filesystem is an allocation nobody needs (and on some platforms this can be
   * a copy-on-write clone that moves no bytes at all).
   */
  async copyChatAsset(chatId: string, name: string, srcPath: string): Promise<string> {
    const abs = this.safeAssetPath(chatId, name);
    if (!abs) throw new Error(`invalid asset name: ${name}`);
    await mkdir(this.chatAssetsDir(chatId), { recursive: true });
    await this.mutex.run(`asset:${chatId}:${basename(name)}`, () => copyFile(srcPath, abs));
    return `assets/${basename(name)}`;
  }

  /** Size of a chat asset without reading it. Null when absent or escaping. */
  async statChatAsset(chatId: string, name: string): Promise<{ size: number } | null> {
    const abs = this.safeAssetPath(chatId, name);
    if (!abs) return null;
    try {
      const s = await stat(abs);
      return s.isFile() ? { size: s.size } : null;
    } catch {
      return null;
    }
  }

  /**
   * Stream a chat asset, optionally just `[start, end]`.
   *
   * Assets are no longer only thumbnails — a referenced video can be hundreds
   * of megabytes, and answering a seek by loading the whole file into a Buffer
   * to slice four bytes out of it would spike memory per request and undo the
   * point of range support.
   */
  openChatAsset(
    chatId: string,
    name: string,
    range?: { start: number; end: number },
  ): Readable | null {
    const abs = this.safeAssetPath(chatId, name);
    if (!abs || !existsSync(abs)) return null;
    return createReadStream(abs, range ? { start: range.start, end: range.end } : undefined);
  }

  /* ----------------------------------------------------------- runners */

  async listRunners(): Promise<RunnerInstance[]> {
    return this.rows("SELECT body FROM runner ORDER BY seq").map((r) =>
      RunnerInstanceSchema.parse(JSON.parse(r.body as string)),
    );
  }
  async getRunner(id: string): Promise<RunnerInstance | null> {
    const row = this.db.prepare("SELECT body FROM runner WHERE id = ?").get(id);
    return row ? RunnerInstanceSchema.parse(JSON.parse(row.body as string)) : null;
  }
  async saveRunner(runner: RunnerInstance): Promise<RunnerInstance> {
    const validated = RunnerInstanceSchema.parse(runner);
    // ON CONFLICT leaves `seq` alone, so re-saving a runner doesn't move it to
    // the end of the roster the way a rewritten JSON array would.
    this.db
      .prepare(
        "INSERT INTO runner (id, body) VALUES (?, ?)" +
          " ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      )
      .run(validated.id, JSON.stringify(validated));
    return validated;
  }
  async deleteRunner(id: string): Promise<void> {
    this.db.prepare("DELETE FROM runner WHERE id = ?").run(id);
  }

  /* ---------------------------------------------------- MCP port leases */

  async listMcpPortLeases(): Promise<McpPortLease[]> {
    // Tolerate a partially-corrupt store: a bad row costs one lease (re-leased on
    // next use), where a throw would cost every session in every project.
    return this.rows("SELECT body FROM mcp_port_lease ORDER BY seq").flatMap((r) => {
      const lease = decodeRow(McpPortLeaseSchema, r.body);
      return lease ? [lease] : [];
    });
  }

  /**
   * Replace the whole lease list under one lock. Allocation must see a
   * consistent view — two concurrent sessions each picking "the lowest free
   * port" from a stale read would pick the SAME one.
   *
   * Still a whole-list replace rather than a row diff, because that is genuinely
   * the shape of the operation: `fn` is handed every lease and returns the set
   * that should exist afterwards. The rows are tiny and there are a handful of
   * them; inventing a per-row key the allocator doesn't have would buy nothing.
   *
   * The MUTEX survives here where every other map dropped it, because `fn` is
   * allowed to be async (the allocator probes sockets) and a synchronous
   * transaction cannot be held across an await. So the transaction covers only
   * the replace, and the mutex covers the read/compute/write triple.
   */
  async updateMcpPortLeases<T>(
    fn: (leases: McpPortLease[]) => { leases: McpPortLease[]; result: T } | Promise<{ leases: McpPortLease[]; result: T }>,
  ): Promise<T> {
    return this.mutex.run("mcp-ports", async () => {
      const current = await this.listMcpPortLeases();
      const { leases, result } = await fn(current);
      const validated = leases.map((l) => McpPortLeaseSchema.parse(l));
      this.db.tx(() => {
        this.db.prepare("DELETE FROM mcp_port_lease").run();
        const ins = this.db.prepare("INSERT INTO mcp_port_lease (body) VALUES (?)");
        for (const lease of validated) ins.run(JSON.stringify(lease));
      });
      return result;
    });
  }

  /* --------------------------------------------------------- worktrees */

  /** How stale a worktree's `lastSeenAt` may get before a sighting rewrites it. */
  private static readonly LAST_SEEN_REFRESH_MS = 5 * 60_000;

  /** Upsert by path, preserving `seq` (and therefore roster order). */
  private putWorktreeRow(rec: WorktreeRecord): void {
    this.db
      .prepare(
        "INSERT INTO worktree (path, project_id, body) VALUES (?, ?, ?)" +
          " ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, body = excluded.body",
      )
      .run(rec.path, rec.projectId, JSON.stringify(rec));
  }

  private worktreeRows(): WorktreeRecord[] {
    return this.rows("SELECT body FROM worktree ORDER BY seq").map((r) =>
      WorktreeRecordSchema.parse(JSON.parse(r.body as string)),
    );
  }

  /**
   * Worktree ATTRIBUTION records, keyed by canonical path.
   *
   * Deliberately not a cache of `git worktree list` — existence is git's
   * answer, re-read on every list. What lives here is what git can't tell us:
   * which chat cut the tree, how (ui/tool/harness/external), and when. Callers
   * canonicalize the path before it gets here; the store treats it as opaque.
   */
  async listWorktreeRecords(): Promise<WorktreeRecord[]> {
    return this.worktreeRows();
  }
  async getWorktreeRecord(path: string): Promise<WorktreeRecord | null> {
    const row = this.db.prepare("SELECT body FROM worktree WHERE path = ?").get(path);
    return row ? WorktreeRecordSchema.parse(JSON.parse(row.body as string)) : null;
  }
  async saveWorktreeRecord(rec: WorktreeRecord): Promise<WorktreeRecord> {
    const validated = WorktreeRecordSchema.parse(rec);
    this.putWorktreeRow(validated);
    return validated;
  }
  async deleteWorktreeRecord(path: string): Promise<void> {
    this.db.prepare("DELETE FROM worktree WHERE path = ?").run(path);
  }

  /**
   * Reconcile one project's rows against what git currently reports.
   *
   * The plan is computed from a READ and only then applied, so a sync that
   * changes nothing takes no write lock at all — `list()` runs on every panel
   * refresh, branch lookup and subApp launch, and grabbing the database's write
   * lock dozens of times a minute to change nothing would contend with the other
   * instance for no reason. Nothing awaits between the read and the apply, so no
   * other in-process caller can interleave with it.
   *
   * A path git has never reported before is back-filled as `external`
   * (unattributed, but VISIBLE — the whole point). A row for this project that
   * git no longer reports is DELETED: git is the authority on existence, and a
   * tombstone would only accumulate and then collide with a path that gets
   * reused. `live` is always the parse of a SUCCESSFUL `git worktree list`, so
   * a repo we merely failed to read never reaches this method.
   */
  async syncWorktreeRecords(
    projectId: string,
    live: Array<{ path: string; branch: string }>,
    opts: { now?: number; key?: (p: string) => string } = {},
  ): Promise<WorktreeRecord[]> {
    const now = opts.now ?? Date.now();
    const key = opts.key ?? ((p: string) => p);
    // Every project's rows, not just this one's: the match below is by
    // NORMALIZED path across the whole roster, so a tree already attributed to
    // another project is found and updated in place rather than duplicated.
    const existing = this.worktreeRows();
    const byKey = new Map(existing.map((r) => [key(r.path), r] as const));
    const liveKeys = new Set(live.map((w) => key(w.path)));

    const upserts: WorktreeRecord[] = [];
    for (const w of live) {
      const prev = byKey.get(key(w.path));
      if (!prev) {
        const rec = WorktreeRecordSchema.parse({
          path: w.path,
          projectId,
          branch: w.branch,
          origin: "external",
          createdAt: now,
          lastSeenAt: now,
        });
        upserts.push(rec);
        byKey.set(key(w.path), rec);
        continue;
      }
      // Bumping `lastSeenAt` on every sighting would make every list() a write.
      // Refresh it only when the row is stale or has changed branch (a worktree
      // can be re-pointed with `git switch`).
      const stale = now - prev.lastSeenAt > Store.LAST_SEEN_REFRESH_MS;
      if (prev.branch !== w.branch || stale) {
        const next = WorktreeRecordSchema.parse({ ...prev, branch: w.branch, lastSeenAt: now });
        upserts.push(next);
        byKey.set(key(w.path), next);
      }
    }
    const gone = existing
      .filter((r) => r.projectId === projectId && !liveKeys.has(key(r.path)))
      .map((r) => r.path);

    if (upserts.length === 0 && gone.length === 0) return existing;
    this.db.tx(() => {
      for (const rec of upserts) this.putWorktreeRow(rec);
      const del = this.db.prepare("DELETE FROM worktree WHERE path = ?");
      for (const path of gone) del.run(path);
    });
    return this.worktreeRows();
  }

  /**
   * Upsert by path: `create` fields apply ONLY when the row is new, `update`
   * always.
   *
   * The split is what stops the detector's sweep from downgrading a row it
   * didn't write — a tree created through the tool is `origin: "tool"` with a
   * known chat, and a later reconcile pass that merely re-saw it in
   * `git worktree list` must not restate it as `external` and orphan it.
   *
   * The read and the write are ONE synchronous transaction; the read-then-save
   * shape a caller would otherwise hand-roll interleaves with that same sweep
   * and loses whichever attribution lost the race.
   */
  async upsertWorktreeRecord(
    path: string,
    create: Omit<WorktreeRecord, "path" | "createdAt" | "lastSeenAt">,
    update: Partial<Omit<WorktreeRecord, "path">> = {},
  ): Promise<WorktreeRecord> {
    return this.db.tx(() => {
      const row = this.db.prepare("SELECT body FROM worktree WHERE path = ?").get(path);
      const prev = row ? WorktreeRecordSchema.parse(JSON.parse(row.body as string)) : undefined;
      const now = Date.now();
      const result = WorktreeRecordSchema.parse({
        ...(prev ?? { ...create, createdAt: now }),
        lastSeenAt: now,
        ...update,
        path,
      });
      this.putWorktreeRow(result);
      return result;
    });
  }

  /* --------------------------------------------------------- terminals */

  /**
   * Terminal ROWS. The output lines live in their own table (see
   * {@link appendTerminalLines}) rather than inside the row, because output is
   * high-volume and the row is small and changes rarely.
   */
  async listTerminalRecords(): Promise<TerminalRecord[]> {
    return this.rows("SELECT body FROM terminal ORDER BY seq").map((r) =>
      TerminalRecordSchema.parse(JSON.parse(r.body as string)),
    );
  }
  async saveTerminalRecord(rec: TerminalRecord): Promise<TerminalRecord> {
    const validated = TerminalRecordSchema.parse(rec);
    this.db
      .prepare(
        "INSERT INTO terminal (id, log_id, body) VALUES (?, ?, ?)" +
          " ON CONFLICT(id) DO UPDATE SET log_id = excluded.log_id, body = excluded.body",
      )
      .run(validated.id, validated.logId, JSON.stringify(validated));
    return validated;
  }
  /**
   * Drop a row AND its transcript. Returns the row that was removed, if any.
   *
   * Both in ONE transaction. As two file operations this was a whole-file
   * rewrite and an unlink with a crash window between them, and a crash there
   * left a `terminals/<logId>.jsonl` no roster row referenced — an orphan
   * nothing would ever read, list or clean up.
   */
  async deleteTerminalRecord(id: string): Promise<TerminalRecord | null> {
    return this.db.tx(() => {
      const row = this.db.prepare("SELECT body FROM terminal WHERE id = ?").get(id);
      if (!row) return null;
      const removed = TerminalRecordSchema.parse(JSON.parse(row.body as string));
      this.db.prepare("DELETE FROM terminal WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM terminal_line WHERE log_id = ?").run(removed.logId);
      return removed;
    });
  }

  /** Append output lines to a terminal's transcript. */
  async appendTerminalLines(logId: string, lines: TerminalLineRecord[]): Promise<void> {
    if (lines.length === 0) return;
    // ONE transaction for the whole batch. A write-behind flush of a dev
    // server's output is routinely hundreds of lines, and a commit each would
    // make the batching pointless — the same reason this used to be one
    // appendFile rather than a loop of them.
    this.db.tx(() => {
      const ins = this.db.prepare(
        "INSERT INTO terminal_line (log_id, ts, stream, chunk) VALUES (?, ?, ?, ?)",
      );
      for (const line of lines) {
        const v = TerminalLineSchema.parse(line);
        ins.run(logId, v.ts, v.stream, v.chunk);
      }
    });
  }

  /**
   * Read a transcript back, filtered.
   *
   * The filters are here rather than in the caller because this is also the
   * programmatic read — `terminal_output({ grep, since })` and the Workspace
   * view's search both land on it, and a `tail` that windows AFTER filtering is
   * the only one that means "the last 50 lines that matched".
   *
   * `since` and `stream` go into the WHERE clause, but `q` does NOT: SQLite's
   * `lower()` folds ASCII only, and pushing the substring test down would
   * quietly stop matching the non-ASCII output `String.toLowerCase()` handles
   * today. A `q` scan has to read the candidate rows anyway. Without `q` the
   * tail becomes `ORDER BY seq DESC LIMIT n` — which is the whole point, since
   * "the last 50 lines" no longer means reading a 40 MB log to get to them.
   */
  async readTerminalLines(
    logId: string,
    opts: {
      tail?: number;
      since?: number;
      q?: string;
      stream?: TerminalLineRecord["stream"];
    } = {},
  ): Promise<TerminalLineRecord[]> {
    const where = ["log_id = ?"];
    const params: Array<string | number> = [logId];
    if (opts.since !== undefined) {
      where.push("ts >= ?");
      params.push(opts.since);
    }
    if (opts.stream) {
      where.push("stream = ?");
      params.push(opts.stream);
    }
    const select = `SELECT ts, stream, chunk FROM terminal_line WHERE ${where.join(" AND ")}`;
    const tail = opts.tail && opts.tail > 0 ? opts.tail : undefined;

    if (!opts.q && tail !== undefined) {
      const rows = this.rows(`${select} ORDER BY seq DESC LIMIT ?`, ...params, tail);
      return rows.reverse().map((r) => toTerminalLine(r));
    }
    let lines = this.rows(`${select} ORDER BY seq`, ...params).map((r) => toTerminalLine(r));
    if (opts.q) {
      const needle = opts.q.toLowerCase();
      lines = lines.filter((l) => l.chunk.toLowerCase().includes(needle));
    }
    return tail !== undefined ? lines.slice(-tail) : lines;
  }

  /**
   * Drop transcript lines older than `cutoff`, returning what's left.
   *
   * `bytes` is SQLite's `length()`, which counts CHARACTERS where the old
   * `chunk.length` counted UTF-16 units — they differ only on astral-plane
   * codepoints, and this number exists to drive a retention sweep, not to
   * reconcile against anything.
   */
  async pruneTerminalLog(
    logId: string,
    cutoff: number,
  ): Promise<{ lines: number; bytes: number }> {
    return this.db.tx(() => {
      this.db.prepare("DELETE FROM terminal_line WHERE log_id = ? AND ts < ?").run(logId, cutoff);
      const row = this.db
        .prepare(
          "SELECT COUNT(*) AS lines, COALESCE(SUM(LENGTH(chunk)), 0) AS bytes" +
            " FROM terminal_line WHERE log_id = ?",
        )
        .get(logId)!;
      return { lines: Number(row.lines), bytes: Number(row.bytes) };
    });
  }

  async deleteTerminalLog(logId: string): Promise<void> {
    this.db.prepare("DELETE FROM terminal_line WHERE log_id = ?").run(logId);
  }

  /* --------------------------------------------------------------- PRs */

  /**
   * Tracked PULL REQUESTS, keyed `owner/repo#number`.
   *
   * Unlike worktrees — where git's `worktree list` is ground truth and the row
   * only carries what git can't say — this row IS the state. Nothing else in the
   * app remembers what a PR's CI, reviewers or threads looked like: `Chat.prs`
   * holds a pointer, and every other read went straight to `gh` and kept
   * nothing. So a row here outlives its PR deliberately, and a settled PR keeps
   * its final state rather than being deleted.
   *
   * A malformed row is DROPPED rather than throwing, matching the MCP port
   * leases: one bad row costs one PR from the roster until its next poll, where
   * a throw would cost the entire catalog.
   */
  async listPrRecords(): Promise<PrRecord[]> {
    return this.rows("SELECT body FROM pr ORDER BY seq").flatMap((r) => {
      const pr = decodeRow(PrRecordSchema, r.body);
      return pr ? [pr] : [];
    });
  }
  async getPrRecord(key: string): Promise<PrRecord | null> {
    const row = this.db.prepare("SELECT body FROM pr WHERE key = ?").get(key);
    return row ? decodeRow(PrRecordSchema, row.body) : null;
  }

  /**
   * Upsert by key: `create` fields apply ONLY when the row is new, `update`
   * always — the same split {@link upsertWorktreeRecord} uses, and here for the
   * same hazard. The discovery sweep sees every open PR in a project including
   * ones a chat opened; without the split it would restate an attributed row
   * with no `chatId` and orphan it from the chat that owns it.
   *
   * The read and the write are one synchronous transaction: the discovery sweep
   * and a `create_pr` land on this concurrently, and a hand-rolled
   * get-then-save pair loses whichever attribution loses the race.
   */
  async upsertPrRecord(
    key: string,
    create: Omit<PrRecord, "key">,
    update: Partial<Omit<PrRecord, "key">> = {},
  ): Promise<PrRecord> {
    return this.db.tx(() => {
      const row = this.db.prepare("SELECT body FROM pr WHERE key = ?").get(key);
      // Lenient, matching listPrRecords: a row this build can no longer read is
      // replaced by the poll that's writing right now, rather than throwing and
      // wedging that PR out of the roster for good.
      const prev = row ? decodeRow(PrRecordSchema, row.body) : null;
      const result = PrRecordSchema.parse({ ...(prev ?? create), ...update, key });
      this.db
        .prepare(
          "INSERT INTO pr (key, body) VALUES (?, ?)" +
            " ON CONFLICT(key) DO UPDATE SET body = excluded.body",
        )
        .run(key, JSON.stringify(result));
      return result;
    });
  }

  async deletePrRecord(key: string): Promise<void> {
    this.db.prepare("DELETE FROM pr WHERE key = ?").run(key);
  }

  /* ------------------------------------------------------- checkpoints */

  async getCheckpoints(chatId: string): Promise<Checkpoint[]> {
    return this.rows(
      "SELECT body FROM checkpoint WHERE chat_id = ? ORDER BY seq",
      chatId,
    ).map((r) => CheckpointSchema.parse(JSON.parse(r.body as string)));
  }
  async getCheckpoint(chatId: string, messageId: string): Promise<Checkpoint | null> {
    const row = this.db
      .prepare("SELECT body FROM checkpoint WHERE chat_id = ? AND message_id = ?")
      .get(chatId, messageId);
    return row ? CheckpointSchema.parse(JSON.parse(row.body as string)) : null;
  }
  /**
   * One row, one INSERT. This is the write that motivated the whole move: it
   * used to read all 2.4 MB of `checkpoints.json`, splice one entry in and write
   * every byte back — once per turn, against a map that only ever grew.
   */
  async saveCheckpoint(cp: Checkpoint): Promise<Checkpoint> {
    const validated = CheckpointSchema.parse(cp);
    this.db
      .prepare(
        "INSERT INTO checkpoint (chat_id, message_id, body) VALUES (?, ?, ?)" +
          " ON CONFLICT(chat_id, message_id) DO UPDATE SET body = excluded.body",
      )
      .run(validated.chatId, validated.messageId, JSON.stringify(validated));
    return validated;
  }
  async deleteCheckpoints(chatId: string): Promise<void> {
    this.db.prepare("DELETE FROM checkpoint WHERE chat_id = ?").run(chatId);
  }

  /* ---------------------------------------------------------- settings */

  async getSettings(): Promise<AppSettings> {
    const raw = await readJson(this.settingsFile());
    if (raw === undefined) return { ...DEFAULT_SETTINGS };
    return AppSettingsSchema.parse(raw);
  }
  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    const validated = AppSettingsSchema.parse(settings);
    await this.mutex.run("settings", () =>
      writeJsonAtomic(this.settingsFile(), validated),
    );
    return validated;
  }
}
