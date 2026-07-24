/**
 * Filesystem Store — the no-DB persistence layer. Everything lives under a
 * dataDir as JSON (config/entities) + JSONL (chat transcripts). All writes are
 * atomic and serialized per-file via a KeyedMutex, and every value is
 * zod-validated on the way in AND out so corrupt/legacy data surfaces loudly.
 *
 * On-disk layout (dataDir):
 *   config.json                  — global app settings
 *   projects/<id>.json           — Project
 *   agents/<id>.json             — AgentConfig
 *   modes/<id>.json              — ModeConfig
 *   chats/<id>/chat.json         — Chat
 *   chats/<id>/messages.jsonl    — ChatMessage rows
 *   chats/<id>/assets/           — pasted/received images
 *   runners.json                 — RunnerInstance[]
 *   checkpoints.json             — { [chatId]: { [messageId]: Checkpoint } }
 */
import { join, resolve, relative, isAbsolute, basename } from "node:path";
import {
  readdir,
  mkdir,
  rm,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
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
} from "@cm/shared";
import {
  KeyedMutex,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  readJsonl,
} from "./fsq.js";

/** Global app settings (config.json). Kept permissive by design. */
export const AppSettingsSchema = z.object({
  theme: z.enum(["dark", "light"]).default("dark"),
  defaultModeId: z.string().optional(),
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
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

const DEFAULT_SETTINGS: AppSettings = { theme: "dark" };

type CheckpointMap = Record<string, Record<string, Checkpoint>>;

export class Store {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly dataDir: string) {}

  /* ------------------------------------------------------------ paths */

  private projectsDir() {
    return join(this.dataDir, "projects");
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
   * recalled/surfaced). Deliberately in the `.data` store — NEVER the committable
   * `.claude-manager/memory/` dir — so it's per-machine runtime signal that can't
   * churn the repo. Owned by {@link MemoryStatsStore}; created on demand.
   */
  projectMemoryStatsFile(projectId: string) {
    return join(this.projectsDir(), projectId, "memory-stats.json");
  }
  private agentsDir() {
    return join(this.dataDir, "agents");
  }
  private modesDir() {
    return join(this.dataDir, "modes");
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
  /** Absolute path to a chat's asset dir (images). Created on demand. */
  chatAssetsDir(chatId: string) {
    return join(this.chatDir(chatId), "assets");
  }
  private runnersFile() {
    return join(this.dataDir, "runners.json");
  }
  private checkpointsFile() {
    return join(this.dataDir, "checkpoints.json");
  }
  private settingsFile() {
    return join(this.dataDir, "config.json");
  }

  /** Create the dataDir tree. Idempotent; call once at boot. */
  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await Promise.all([
      mkdir(this.projectsDir(), { recursive: true }),
      mkdir(this.agentsDir(), { recursive: true }),
      mkdir(this.modesDir(), { recursive: true }),
      mkdir(this.chatsDir(), { recursive: true }),
    ]);
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
  getChat(id: string): Promise<Chat | null> {
    return this.readEntity(this.chatFile(id), ChatSchema);
  }
  async saveChat(chat: Chat): Promise<Chat> {
    const validated = ChatSchema.parse(chat);
    await mkdir(this.chatDir(chat.id), { recursive: true });
    await this.mutex.run(`chat:${chat.id}`, () =>
      writeJsonAtomic(this.chatFile(chat.id), validated),
    );
    return validated;
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

  async readMessages(
    chatId: string,
    opts: { limit?: number; afterId?: string } = {},
  ): Promise<ChatMessage[]> {
    const rows = await readJsonl(this.messagesFile(chatId));
    let msgs = rows.map((r) => ChatMessageSchema.parse(r));
    if (opts.afterId) {
      const idx = msgs.findIndex((m) => m.id === opts.afterId);
      if (idx >= 0) msgs = msgs.slice(idx + 1);
    }
    if (opts.limit !== undefined && opts.limit >= 0) {
      msgs = msgs.slice(Math.max(0, msgs.length - opts.limit));
    }
    return msgs;
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
