/**
 * Filesystem Store — the no-DB persistence layer. Everything lives under a
 * dataDir as JSON (config/entities) + JSONL (chat transcripts). All writes are
 * atomic and serialized per-file via a KeyedMutex, and every value is
 * zod-validated on the way in AND out so corrupt/legacy data surfaces loudly.
 *
 * The tree is split across TWO roots so a stable and a dev instance can share
 * what's safe to share and keep apart what isn't (see {@link Store} ctor):
 *
 * CONFIG root (`configDir`) — low-write, safe to share between instances:
 *   config.json                  — global app settings
 *   projects/<id>.json           — Project
 *   projects/<id>/memory/        — project agent-memory (+ memory-stats.json)
 *   agents/<id>.json             — AgentConfig
 *   modes/<id>.json              — ModeConfig
 *
 * STATE root (`dataDir`) — high-write, MUST stay per-instance:
 *   chats/<id>/chat.json         — Chat
 *   chats/<id>/messages.jsonl    — ChatMessage rows
 *   chats/<id>/assets/           — pasted/received images
 *   runners.json                 — RunnerInstance[]
 *   checkpoints.json             — { [chatId]: { [messageId]: Checkpoint } }
 *   worktrees.json               — WorktreeRecord[] (attribution, keyed by path)
 *   terminals.json               — TerminalRecord[] (shell roster)
 *   terminals/<logId>.jsonl      — that shell's retained output
 *   prs.json                     — PrRecord[] (PR roster, keyed `repo#number`)
 *
 * `runners.json`, `checkpoints.json`, `worktrees.json`, `terminals.json` and
 * `prs.json` are whole-file read-modify-write maps
 * guarded only by this process's {@link KeyedMutex}, so two processes sharing
 * them would silently lose each other's entries — that's the reason for the
 * split, and the reason chats stay per-instance even though sharing them would
 * be convenient. `configDir` defaults to `dataDir`, so a single-root deployment
 * (and every test) behaves exactly as before.
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
  appendJsonlBatch,
  readJsonl,
  readJsonlLines,
} from "./fsq.js";

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
    })
    .optional(),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

const DEFAULT_SETTINGS: AppSettings = { theme: "dark" };

type CheckpointMap = Record<string, Record<string, Checkpoint>>;

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

export class Store {
  private readonly mutex = new KeyedMutex();
  private readonly configDir: string;
  private freshInstall = true;

  /**
   * @param dataDir   STATE root (chats, checkpoints, runners) — per-instance.
   * @param configDir CONFIG root (settings, projects, agents, modes) — shareable
   *                  between instances. Defaults to `dataDir` for a single-root
   *                  layout, which is what every existing caller and test uses.
   */
  constructor(
    private readonly dataDir: string,
    configDir?: string,
  ) {
    this.configDir = configDir ?? dataDir;
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
  private runnersFile() {
    return join(this.dataDir, "runners.json");
  }
  /**
   * Per-INSTANCE, like runners.json and for the same reason: it's a whole-file
   * read-modify-write map guarded by an in-process mutex, so two processes
   * sharing it would silently drop each other's leases and hand two checkouts
   * one port — the exact collision the leases exist to prevent.
   */
  private mcpPortsFile() {
    return join(this.dataDir, "mcp-ports.json");
  }
  private checkpointsFile() {
    return join(this.dataDir, "checkpoints.json");
  }
  private worktreesFile() {
    return join(this.dataDir, "worktrees.json");
  }
  private terminalsFile() {
    return join(this.dataDir, "terminals.json");
  }
  /**
   * The PR roster. STATE root for the same reason as worktrees.json: a whole-file
   * read-modify-write map guarded only by this process's mutex, so a stable and a
   * dev instance sharing it would silently drop each other's rows.
   */
  private prsFile() {
    return join(this.dataDir, "prs.json");
  }
  private terminalLogsDir() {
    return join(this.dataDir, "terminals");
  }
  /**
   * A terminal's transcript. Keyed by `logId` rather than by the terminal's own
   * id, which is `${chatId}::${agentChosenName}` — neither `::` nor an arbitrary
   * agent-supplied string is a safe filename.
   */
  private terminalLogFile(logId: string) {
    return join(this.terminalLogsDir(), `${logId}.jsonl`);
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

  /** Create both roots' trees. Idempotent; call once at boot. */
  async init(): Promise<void> {
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

  async listChats(projectId?: string): Promise<Chat[]> {
    if (!existsSync(this.chatsDir())) return [];
    const entries = await readdir(this.chatsDir(), { withFileTypes: true });
    const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const all = await Promise.all(ids.map((id) => this.getChat(id)));
    const chats = all.filter((c): c is Chat => c !== null);
    return projectId ? chats.filter((c) => c.projectId === projectId) : chats;
  }
  async getChat(id: string): Promise<Chat | null> {
    const chat = await this.readEntity(this.chatFile(id), ChatSchema);
    return chat && { ...chat, updatedAt: await this.lastActivityAt(chat) };
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
    return validated;
  }

  /**
   * Merge a partial record while holding the chat file's lock. Status changes
   * race with title/session metadata during a live turn; a get-then-save pair
   * outside this lock can let either whole-file rewrite erase the other.
   */
  async patchChat(id: string, patch: Partial<Chat>): Promise<Chat | null> {
    return this.mutex.run(`chat:${id}`, async () => {
      const current = await this.readEntity(this.chatFile(id), ChatSchema);
      if (!current) return null;
      const validated = ChatSchema.parse({ ...current, ...patch, id });
      await writeJsonAtomic(this.chatFile(id), validated);
      return validated;
    });
  }
  async deleteChat(id: string): Promise<void> {
    await this.mutex.run(`chat:${id}`, () =>
      rm(this.chatDir(id), { recursive: true, force: true }),
    );
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
   */
  async readMessages(
    chatId: string,
    opts: { limit?: number; afterId?: string; beforeId?: string } = {},
  ): Promise<ChatMessage[]> {
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
    const raw = (await readJson<unknown[]>(this.runnersFile())) ?? [];
    return z.array(RunnerInstanceSchema).parse(raw);
  }
  async getRunner(id: string): Promise<RunnerInstance | null> {
    const all = await this.listRunners();
    return all.find((r) => r.id === id) ?? null;
  }
  async saveRunner(runner: RunnerInstance): Promise<RunnerInstance> {
    const validated = RunnerInstanceSchema.parse(runner);
    await this.mutex.run("runners", async () => {
      const all = (await readJson<unknown[]>(this.runnersFile())) ?? [];
      const list = z.array(RunnerInstanceSchema).parse(all);
      const idx = list.findIndex((r) => r.id === validated.id);
      if (idx >= 0) list[idx] = validated;
      else list.push(validated);
      await writeJsonAtomic(this.runnersFile(), list);
    });
    return validated;
  }
  async deleteRunner(id: string): Promise<void> {
    await this.mutex.run("runners", async () => {
      const all = (await readJson<unknown[]>(this.runnersFile())) ?? [];
      const list = z.array(RunnerInstanceSchema).parse(all).filter((r) => r.id !== id);
      await writeJsonAtomic(this.runnersFile(), list);
    });
  }

  /* ---------------------------------------------------- MCP port leases */

  async listMcpPortLeases(): Promise<McpPortLease[]> {
    const raw = (await readJson<unknown[]>(this.mcpPortsFile())) ?? [];
    // Tolerate a partially-corrupt file: a bad row costs one lease (re-leased on
    // next use), where a throw would cost every session in every project.
    return raw.flatMap((r) => {
      const p = McpPortLeaseSchema.safeParse(r);
      return p.success ? [p.data] : [];
    });
  }

  /**
   * Read-modify-write the whole lease list under one lock. Allocation must see a
   * consistent view — two concurrent sessions each picking "the lowest free
   * port" from a stale read would pick the SAME one.
   */
  async updateMcpPortLeases<T>(
    fn: (leases: McpPortLease[]) => { leases: McpPortLease[]; result: T } | Promise<{ leases: McpPortLease[]; result: T }>,
  ): Promise<T> {
    return this.mutex.run("mcp-ports", async () => {
      const raw = (await readJson<unknown[]>(this.mcpPortsFile())) ?? [];
      const current = raw.flatMap((r) => {
        const p = McpPortLeaseSchema.safeParse(r);
        return p.success ? [p.data] : [];
      });
      const { leases, result } = await fn(current);
      await writeJsonAtomic(this.mcpPortsFile(), leases);
      return result;
    });
  }

  /* --------------------------------------------------------- worktrees */

  /** How stale a worktree's `lastSeenAt` may get before a sighting rewrites it. */
  private static readonly LAST_SEEN_REFRESH_MS = 5 * 60_000;

  /**
   * Worktree ATTRIBUTION records, keyed by canonical path.
   *
   * Deliberately not a cache of `git worktree list` — existence is git's
   * answer, re-read on every list. What lives here is what git can't tell us:
   * which chat cut the tree, how (ui/tool/harness/external), and when. Callers
   * canonicalize the path before it gets here; the store treats it as opaque.
   *
   * STATE root, same as runners.json: whole-file read-modify-write under this
   * process's mutex, so two instances sharing it would lose each other's rows.
   */
  async listWorktreeRecords(): Promise<WorktreeRecord[]> {
    const raw = (await readJson<unknown[]>(this.worktreesFile())) ?? [];
    return z.array(WorktreeRecordSchema).parse(raw);
  }
  async getWorktreeRecord(path: string): Promise<WorktreeRecord | null> {
    const all = await this.listWorktreeRecords();
    return all.find((w) => w.path === path) ?? null;
  }
  async saveWorktreeRecord(rec: WorktreeRecord): Promise<WorktreeRecord> {
    const validated = WorktreeRecordSchema.parse(rec);
    await this.mutex.run("worktrees", async () => {
      const all = (await readJson<unknown[]>(this.worktreesFile())) ?? [];
      const list = z.array(WorktreeRecordSchema).parse(all);
      const idx = list.findIndex((w) => w.path === validated.path);
      if (idx >= 0) list[idx] = validated;
      else list.push(validated);
      await writeJsonAtomic(this.worktreesFile(), list);
    });
    return validated;
  }
  async deleteWorktreeRecord(path: string): Promise<void> {
    await this.mutex.run("worktrees", async () => {
      const all = (await readJson<unknown[]>(this.worktreesFile())) ?? [];
      const list = z
        .array(WorktreeRecordSchema)
        .parse(all)
        .filter((w) => w.path !== path);
      await writeJsonAtomic(this.worktreesFile(), list);
    });
  }

  /**
   * Reconcile one project's rows against what git currently reports.
   *
   * A single read-modify-write for the whole project, and a NO-OP when nothing
   * changed — `list()` runs on every panel refresh, branch lookup and subApp
   * launch, so a per-path write here would rewrite the file dozens of times a
   * minute to change nothing.
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
    let result: WorktreeRecord[] = [];
    await this.mutex.run("worktrees", async () => {
      const raw = (await readJson<unknown[]>(this.worktreesFile())) ?? [];
      const list = z.array(WorktreeRecordSchema).parse(raw);
      const byKey = new Map(list.map((r) => [key(r.path), r] as const));
      const liveKeys = new Set(live.map((w) => key(w.path)));
      let dirty = false;

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
          list.push(rec);
          byKey.set(key(w.path), rec);
          dirty = true;
          continue;
        }
        // Bumping `lastSeenAt` on every sighting would make every list() a write.
        // Refresh it only when the row is stale or has changed branch (a worktree
        // can be re-pointed with `git switch`).
        const stale = now - prev.lastSeenAt > Store.LAST_SEEN_REFRESH_MS;
        if (prev.branch !== w.branch || stale) {
          const idx = list.findIndex((r) => r.path === prev.path);
          list[idx] = WorktreeRecordSchema.parse({
            ...prev,
            branch: w.branch,
            lastSeenAt: now,
          });
          dirty = true;
        }
      }

      const kept = list.filter(
        (r) => r.projectId !== projectId || liveKeys.has(key(r.path)),
      );
      if (kept.length !== list.length) dirty = true;

      if (dirty) await writeJsonAtomic(this.worktreesFile(), kept);
      result = kept;
    });
    return result;
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
   * One mutex hold covers the read AND the write; the read-then-save shape a
   * caller would otherwise hand-roll interleaves with that same sweep and loses
   * whichever attribution lost the race.
   */
  async upsertWorktreeRecord(
    path: string,
    create: Omit<WorktreeRecord, "path" | "createdAt" | "lastSeenAt">,
    update: Partial<Omit<WorktreeRecord, "path">> = {},
  ): Promise<WorktreeRecord> {
    let result!: WorktreeRecord;
    await this.mutex.run("worktrees", async () => {
      const all = (await readJson<unknown[]>(this.worktreesFile())) ?? [];
      const list = z.array(WorktreeRecordSchema).parse(all);
      const idx = list.findIndex((w) => w.path === path);
      const now = Date.now();
      const prev = idx >= 0 ? list[idx] : undefined;
      result = WorktreeRecordSchema.parse({
        ...(prev ?? { ...create, createdAt: now }),
        lastSeenAt: now,
        ...update,
        path,
      });
      if (idx >= 0) list[idx] = result;
      else list.push(result);
      await writeJsonAtomic(this.worktreesFile(), list);
    });
    return result;
  }

  /* --------------------------------------------------------- terminals */

  /**
   * Terminal ROWS. The transcripts live beside them as JSONL (see
   * {@link appendTerminalLines}) because output is high-volume and a whole-file
   * rewrite per line would be absurd; the row is small and changes rarely.
   */
  async listTerminalRecords(): Promise<TerminalRecord[]> {
    const raw = (await readJson<unknown[]>(this.terminalsFile())) ?? [];
    return z.array(TerminalRecordSchema).parse(raw);
  }
  async saveTerminalRecord(rec: TerminalRecord): Promise<TerminalRecord> {
    const validated = TerminalRecordSchema.parse(rec);
    await this.mutex.run("terminals", async () => {
      const raw = (await readJson<unknown[]>(this.terminalsFile())) ?? [];
      const list = z.array(TerminalRecordSchema).parse(raw);
      const idx = list.findIndex((t) => t.id === validated.id);
      if (idx >= 0) list[idx] = validated;
      else list.push(validated);
      await writeJsonAtomic(this.terminalsFile(), list);
    });
    return validated;
  }
  /** Drop a row AND its transcript. Returns the row that was removed, if any. */
  async deleteTerminalRecord(id: string): Promise<TerminalRecord | null> {
    let removed: TerminalRecord | null = null;
    await this.mutex.run("terminals", async () => {
      const raw = (await readJson<unknown[]>(this.terminalsFile())) ?? [];
      const list = z.array(TerminalRecordSchema).parse(raw);
      removed = list.find((t) => t.id === id) ?? null;
      if (!removed) return;
      await writeJsonAtomic(
        this.terminalsFile(),
        list.filter((t) => t.id !== id),
      );
    });
    if (removed) await this.deleteTerminalLog((removed as TerminalRecord).logId);
    return removed;
  }

  /** Append output lines to a terminal's transcript. */
  async appendTerminalLines(logId: string, lines: TerminalLineRecord[]): Promise<void> {
    if (lines.length === 0) return;
    await mkdir(this.terminalLogsDir(), { recursive: true });
    // ONE write for the whole batch. A write-behind flush of a dev server's
    // output is routinely hundreds of lines, and a syscall each would make the
    // batching pointless.
    await this.mutex.run(`terminal-log:${logId}`, () =>
      appendJsonlBatch(this.terminalLogFile(logId), lines),
    );
  }

  /**
   * Read a transcript back, filtered.
   *
   * The filters are here rather than in the caller because this is also the
   * programmatic read — `terminal_output({ grep, since })` and the Workspace
   * view's search both land on it, and a `tail` that windows AFTER filtering is
   * the only one that means "the last 50 lines that matched".
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
    const raw = await readJsonl(this.terminalLogFile(logId));
    let lines: TerminalLineRecord[] = [];
    for (const row of raw) {
      const parsed = TerminalLineSchema.safeParse(row);
      if (parsed.success) lines.push(parsed.data);
    }
    if (opts.since !== undefined) lines = lines.filter((l) => l.ts >= opts.since!);
    if (opts.stream) lines = lines.filter((l) => l.stream === opts.stream);
    if (opts.q) {
      const needle = opts.q.toLowerCase();
      lines = lines.filter((l) => l.chunk.toLowerCase().includes(needle));
    }
    return opts.tail && opts.tail > 0 ? lines.slice(-opts.tail) : lines;
  }

  /**
   * Drop transcript lines older than `cutoff`, returning what's left.
   *
   * A rewrite, not an append — which is why it belongs on the retention sweep
   * and nowhere near the write path.
   */
  async pruneTerminalLog(
    logId: string,
    cutoff: number,
  ): Promise<{ lines: number; bytes: number }> {
    let kept: TerminalLineRecord[] = [];
    await this.mutex.run(`terminal-log:${logId}`, async () => {
      const file = this.terminalLogFile(logId);
      if (!existsSync(file)) return;
      const raw = await readJsonl(file);
      for (const row of raw) {
        const parsed = TerminalLineSchema.safeParse(row);
        if (parsed.success && parsed.data.ts >= cutoff) kept.push(parsed.data);
      }
      if (kept.length === raw.length) return;
      const body = kept.map((l) => `${JSON.stringify(l)}\n`).join("");
      await fsWriteFile(file, body, "utf8");
    });
    return {
      lines: kept.length,
      bytes: kept.reduce((n, l) => n + l.chunk.length, 0),
    };
  }

  async deleteTerminalLog(logId: string): Promise<void> {
    await this.mutex.run(`terminal-log:${logId}`, () =>
      rm(this.terminalLogFile(logId), { force: true }),
    );
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
    const raw = (await readJson<unknown[]>(this.prsFile())) ?? [];
    return raw.flatMap((r) => {
      const p = PrRecordSchema.safeParse(r);
      return p.success ? [p.data] : [];
    });
  }
  async getPrRecord(key: string): Promise<PrRecord | null> {
    const all = await this.listPrRecords();
    return all.find((p) => p.key === key) ?? null;
  }

  /**
   * Upsert by key: `create` fields apply ONLY when the row is new, `update`
   * always — the same split {@link upsertWorktreeRecord} uses, and here for the
   * same hazard. The discovery sweep sees every open PR in a project including
   * ones a chat opened; without the split it would restate an attributed row
   * with no `chatId` and orphan it from the chat that owns it.
   *
   * One mutex hold covers the read AND the write: the discovery sweep and a
   * `create_pr` land on this concurrently, and a hand-rolled get-then-save pair
   * loses whichever attribution loses the race.
   */
  async upsertPrRecord(
    key: string,
    create: Omit<PrRecord, "key">,
    update: Partial<Omit<PrRecord, "key">> = {},
  ): Promise<PrRecord> {
    let result!: PrRecord;
    await this.mutex.run("prs", async () => {
      const raw = (await readJson<unknown[]>(this.prsFile())) ?? [];
      const list = raw.flatMap((r) => {
        const p = PrRecordSchema.safeParse(r);
        return p.success ? [p.data] : [];
      });
      const idx = list.findIndex((p) => p.key === key);
      const prev = idx >= 0 ? list[idx] : undefined;
      result = PrRecordSchema.parse({ ...(prev ?? create), ...update, key });
      if (idx >= 0) list[idx] = result;
      else list.push(result);
      await writeJsonAtomic(this.prsFile(), list);
    });
    return result;
  }

  async deletePrRecord(key: string): Promise<void> {
    await this.mutex.run("prs", async () => {
      const raw = (await readJson<unknown[]>(this.prsFile())) ?? [];
      const list = raw
        .flatMap((r) => {
          const p = PrRecordSchema.safeParse(r);
          return p.success ? [p.data] : [];
        })
        .filter((p) => p.key !== key);
      await writeJsonAtomic(this.prsFile(), list);
    });
  }

  /* ------------------------------------------------------- checkpoints */

  private async readCheckpointMap(): Promise<CheckpointMap> {
    const raw = (await readJson<unknown>(this.checkpointsFile())) ?? {};
    return z.record(z.string(), z.record(z.string(), CheckpointSchema)).parse(raw);
  }

  async getCheckpoints(chatId: string): Promise<Checkpoint[]> {
    const map = await this.readCheckpointMap();
    return Object.values(map[chatId] ?? {});
  }
  async getCheckpoint(chatId: string, messageId: string): Promise<Checkpoint | null> {
    const map = await this.readCheckpointMap();
    return map[chatId]?.[messageId] ?? null;
  }
  async saveCheckpoint(cp: Checkpoint): Promise<Checkpoint> {
    const validated = CheckpointSchema.parse(cp);
    await this.mutex.run("checkpoints", async () => {
      const map = await this.readCheckpointMap();
      (map[validated.chatId] ??= {})[validated.messageId] = validated;
      await writeJsonAtomic(this.checkpointsFile(), map);
    });
    return validated;
  }
  async deleteCheckpoints(chatId: string): Promise<void> {
    await this.mutex.run("checkpoints", async () => {
      const map = await this.readCheckpointMap();
      if (map[chatId]) {
        delete map[chatId];
        await writeJsonAtomic(this.checkpointsFile(), map);
      }
    });
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
