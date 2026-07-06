/**
 * ProjectConfigService — loads, syncs, and watches a managed repo's
 * self-contained `.claude-manager/` config.
 *
 * A managed repo may carry a committable `.claude-manager/` directory at its
 * root that is the SOURCE OF TRUTH for its authored claude-manager config. This
 * service:
 *   - DISCOVERS `.claude-manager/project.yaml` under a project's `repoPath`,
 *   - PARSES + VALIDATES the manifest (yaml@2 + zod) and LOADS the `agents/`,
 *     `modes/`, `instructions/` files it references into the normalized
 *     {@link ProjectConfig} — resiliently: a malformed file yields a structured
 *     error surfaced over the API, never a crash,
 *   - SYNCS the loaded authored config into the existing project store as a
 *     runtime cache (authored fields OVERRIDE the `.data` project record) so
 *     every existing consumer keeps working — precedence:
 *       `.claude-manager/` present → its fields win;
 *       absent → the current `.data` store is used as-is (back-compat), and
 *   - WATCHES `.claude-manager/` (debounced) and re-runs the above on change,
 *     emitting a `project-config-update` bus event.
 *
 * `.data` keeps ONLY runtime state; this service never persists anything but the
 * merged project record (via the normal `store.saveProject`), and only when it
 * actually changed. Projects without a `.claude-manager/` are never mutated.
 *
 * fs / yaml parsing + the fs watcher are behind small injectable seams so tests
 * can drive load + reload deterministically without a real watcher.
 */
import { join, resolve, relative, isAbsolute } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  ProjectManifestSchema,
  ProjectConfigSchema,
  ProjectConfigResultSchema,
  AgentConfigSchema,
  ConfigModeSchema,
  PermissionModeSchema,
  CONFIG_DIR_NAME,
  MANIFEST_FILE,
  DEFAULT_INSTRUCTIONS_DIR,
  DEFAULT_AGENTS_DIR,
  DEFAULT_MODES_DIR,
  DEFAULT_MEMORY_DIR,
  type Project,
  type ProjectConfig,
  type ProjectConfigResult,
  type ProjectConfigError,
  type NormalizedInstruction,
  type ConfigMode,
  type AgentConfig,
  type SubApp,
  type McpServerConfig,
} from "@cm/shared";
import type { Store } from "../store/index.js";
import type { EventBus } from "../bus.js";

/** A file-watcher handle (the subset of fs.FSWatcher this service uses). */
export interface ConfigWatcher {
  close(): void;
}

export interface ProjectConfigServiceOptions {
  store: Store;
  bus: EventBus;
  now?: () => number;
  /** Debounce for watcher-triggered reloads (ms). Default 250. */
  debounceMs?: number;
  /**
   * Injectable watch factory (tests). Given the `.claude-manager/` dir and a
   * change listener, returns a closable watcher. Defaults to a recursive
   * `fs.watch`. A factory that returns `null` disables watching.
   */
  watch?: (dir: string, onChange: () => void) => ConfigWatcher | null;
}

/* ------------------------------------------------------------------ helpers */

/** Kebab-case slug — a stable id from a free-text name / filename. */
export function slugifyConfigName(name: string): string {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

/** Collapse a (possibly multi-line) string to a single trimmed line. */
function oneLine(text: unknown): string {
  return String(text ?? "").replace(/\s*\r?\n\s*/g, " ").trim();
}

/** Coerce an unknown to a `string[]` (drops non-strings). Undefined stays undefined. */
function toStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length ? out : undefined;
}

interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

/**
 * Split a markdown file into its YAML frontmatter (between the leading `---`
 * fences) and the remaining body. No fence → all body, empty data.
 */
export function parseFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { data: {}, body: text.trim() };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: text.trim() };
  const front = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n+/, "").trimEnd();
  let data: Record<string, unknown> = {};
  const parsed = parseYaml(front) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    data = parsed as Record<string, unknown>;
  }
  return { data, body };
}

/** Normalize a manifest MCP transport into the flat store {@link McpServerConfig}. */
function transportToMcpConfig(transport: {
  type: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}): McpServerConfig {
  if (transport.type === "stdio") {
    return {
      type: "stdio",
      command: transport.command,
      args: transport.args,
      env: transport.env,
    };
  }
  return {
    type: transport.type,
    url: transport.url,
    headers: transport.headers,
  };
}

/* ---------------------------------------------------------- ProjectConfigService */

export class ProjectConfigService {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly watchFactory: (
    dir: string,
    onChange: () => void,
  ) => ConfigWatcher | null;

  /** projectId → last loaded result (the in-memory runtime cache). */
  private readonly cache = new Map<string, ProjectConfigResult>();
  /** projectId → active fs watcher. */
  private readonly watchers = new Map<string, ConfigWatcher>();
  /** projectId → debounce timer for a pending watcher-triggered reload. */
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: ProjectConfigServiceOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.now = opts.now ?? (() => Date.now());
    this.debounceMs = opts.debounceMs ?? 250;
    this.watchFactory =
      opts.watch ??
      ((dir, onChange) => {
        let w: FSWatcher;
        try {
          w = fsWatch(dir, { recursive: true }, () => onChange());
        } catch {
          return null;
        }
        // Never keep the event loop alive just to watch (clean shutdown).
        w.unref?.();
        return { close: () => w.close() };
      });
  }

  /* ----------------------------------------------------------- lifecycle */

  /** Load + watch every existing project. Best-effort; never throws. */
  async start(): Promise<void> {
    let projects: Project[];
    try {
      projects = await this.store.listProjects();
    } catch {
      return;
    }
    for (const project of projects) {
      await this.reload(project.id).catch(() => {});
      this.watchProject(project);
    }
  }

  /** Close every watcher + cancel pending reloads (teardown). */
  stop(): void {
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    for (const w of this.watchers.values()) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers.clear();
  }

  /* --------------------------------------------------------- public API */

  /** The cached result for a project (undefined until first loaded). */
  get(projectId: string): ProjectConfigResult | undefined {
    return this.cache.get(projectId);
  }

  /** The normalized config for a project, or null when it has none / it failed. */
  getConfig(projectId: string): ProjectConfig | null {
    return this.cache.get(projectId)?.config ?? null;
  }

  /** True when a project has a valid `.claude-manager/` config loaded. */
  hasConfig(projectId: string): boolean {
    return !!this.cache.get(projectId)?.config;
  }

  /**
   * Load a project's `.claude-manager/` from disk into a normalized result.
   * Pure read — no store writes, no events. Resilient: any parse/read failure
   * becomes a structured error, never a throw.
   */
  async load(project: Project): Promise<ProjectConfigResult> {
    const sourceDir = join(project.repoPath, CONFIG_DIR_NAME);
    const manifestPath = join(sourceDir, MANIFEST_FILE);

    // No `.claude-manager/` → back-compat: the `.data` store is used as-is.
    if (!existsSync(manifestPath)) {
      return ProjectConfigResultSchema.parse({ sourceDir: null, config: null, errors: [] });
    }

    const errors: ProjectConfigError[] = [];

    // --- manifest ---
    let manifestRaw: string;
    try {
      manifestRaw = await readFile(manifestPath, "utf8");
    } catch (err) {
      errors.push({ scope: "io", file: MANIFEST_FILE, message: msg(err) });
      return ProjectConfigResultSchema.parse({ sourceDir, config: null, errors });
    }

    let manifestData: unknown;
    try {
      manifestData = parseYaml(manifestRaw);
    } catch (err) {
      errors.push({ scope: "manifest", file: MANIFEST_FILE, message: `YAML parse error: ${msg(err)}` });
      return ProjectConfigResultSchema.parse({ sourceDir, config: null, errors });
    }

    const parsed = ProjectManifestSchema.safeParse(manifestData ?? {});
    if (!parsed.success) {
      errors.push({ scope: "manifest", file: MANIFEST_FILE, message: parsed.error.message });
      return ProjectConfigResultSchema.parse({ sourceDir, config: null, errors });
    }
    const manifest = parsed.data;

    // --- resolved dirs ---
    const instructionsDir = join(sourceDir, manifest.instructionsDir ?? DEFAULT_INSTRUCTIONS_DIR);
    const agentsDir = join(sourceDir, manifest.agents ?? DEFAULT_AGENTS_DIR);
    const modesDir = join(sourceDir, manifest.modes ?? DEFAULT_MODES_DIR);
    const memoryDir = join(sourceDir, manifest.memory ?? DEFAULT_MEMORY_DIR);

    // --- instructions ---
    const instructions: NormalizedInstruction[] = [];
    for (const entry of manifest.instructions ?? []) {
      if ("text" in entry) {
        instructions.push({ source: "text", text: entry.text });
        continue;
      }
      // `file` is resolved relative to the instructions dir, then the config dir
      // (so both `instructions/house.md` and a bare `house.md` work).
      const rel = entry.file;
      const abs = this.resolveInstructionFile(sourceDir, instructionsDir, rel);
      if (!abs) {
        errors.push({ scope: "instruction", file: rel, message: "path escapes the config dir" });
        continue;
      }
      try {
        const text = await readFile(abs, "utf8");
        instructions.push({ source: "file", file: rel, text: text.replace(/\r\n/g, "\n").trimEnd() });
      } catch (err) {
        errors.push({ scope: "instruction", file: rel, message: msg(err) });
      }
    }
    const instructionsText = instructions
      .map((i) => i.text)
      .filter(Boolean)
      .join("\n\n");

    // --- agents ---
    const agents = await this.loadAgents(project.id, agentsDir, errors);

    // --- modes ---
    const modes = await this.loadModes(modesDir, errors);

    // --- subApps (cwd → path, docker → dockerCompose) ---
    const subApps: SubApp[] = (manifest.subApps ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      path: s.cwd,
      install: s.install,
      dev: s.dev,
      build: s.build,
      test: s.test,
      ports: s.ports,
      url: s.url,
      dockerCompose: s.docker,
    }));

    // --- mcpServers (array → keyed record; transport flattened) ---
    const mcpServers: Record<string, McpServerConfig> = {};
    for (const server of manifest.mcpServers ?? []) {
      mcpServers[server.name] = transportToMcpConfig(server.transport);
    }

    const config: ProjectConfig = ProjectConfigSchema.parse({
      sourceDir,
      name: manifest.name,
      worktreeRoot: manifest.worktreeRoot,
      worktreeCmd: manifest.worktree,
      shipCmd: manifest.ship,
      defaults: manifest.defaults,
      instructions,
      instructionsText: instructionsText || undefined,
      subApps,
      mcpServers,
      agents,
      modes,
      memoryDir,
      agentsDir,
      modesDir,
      instructionsDir,
    });

    return ProjectConfigResultSchema.parse({ sourceDir, config, errors });
  }

  /**
   * Reload a project by id: load from disk, SYNC into the store (authored fields
   * override the `.data` record — only persisted when actually changed), cache
   * the result, and emit `project-config-update`. Returns the result (an empty
   * back-compat result when the project has no `.claude-manager/`). Never throws.
   */
  async reload(projectId: string): Promise<ProjectConfigResult> {
    const project = await this.store.getProject(projectId).catch(() => null);
    if (!project) {
      const empty = ProjectConfigResultSchema.parse({ sourceDir: null, config: null, errors: [] });
      this.cache.delete(projectId);
      return empty;
    }

    let result: ProjectConfigResult;
    try {
      result = await this.load(project);
    } catch (err) {
      // Defensive: `load` is resilient, but never let reload throw.
      result = ProjectConfigResultSchema.parse({
        sourceDir: join(project.repoPath, CONFIG_DIR_NAME),
        config: null,
        errors: [{ scope: "io", message: msg(err) }],
      });
    }

    this.cache.set(projectId, result);

    // Sync the authored config into the store so existing consumers transparently
    // see the overrides. Only touch `.data` when the project actually has authored
    // config AND the merged record differs (no churn / no back-compat mutation).
    if (result.config) {
      const merged = mergeProject(project, result.config);
      if (projectChanged(project, merged)) {
        const saved = await this.store.saveProject(merged).catch(() => null);
        if (saved) this.bus.publish({ type: "project-update", project: saved });
      }
    }

    this.bus.publish({
      type: "project-config-update",
      projectId,
      sourceDir: result.sourceDir,
      config: result.config,
      errors: result.errors,
    });
    return result;
  }

  /**
   * Watch a project's `.claude-manager/` for changes and debounced-reload. No-op
   * when the dir is absent (a back-compat project needs no watcher) or already
   * watched. Idempotent.
   */
  watchProject(project: Project): void {
    if (this.watchers.has(project.id)) return;
    const dir = join(project.repoPath, CONFIG_DIR_NAME);
    if (!existsSync(dir)) return;
    const watcher = this.watchFactory(dir, () => this.onWatchEvent(project.id));
    if (watcher) this.watchers.set(project.id, watcher);
  }

  /** Stop watching one project (e.g. it was deleted). */
  unwatchProject(projectId: string): void {
    const timer = this.debounceTimers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(projectId);
    }
    const watcher = this.watchers.get(projectId);
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
      this.watchers.delete(projectId);
    }
    this.cache.delete(projectId);
  }

  /* ---------------------------------------------------------- internals */

  /** Debounce a watcher event into a single reload. */
  private onWatchEvent(projectId: string): void {
    const existing = this.debounceTimers.get(projectId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(projectId);
      void this.reload(projectId).catch(() => {});
    }, this.debounceMs);
    timer.unref?.();
    this.debounceTimers.set(projectId, timer);
  }

  /** Resolve an instruction `file` against the instructions dir then config dir. */
  private resolveInstructionFile(
    sourceDir: string,
    instructionsDir: string,
    rel: string,
  ): string | null {
    for (const base of [instructionsDir, sourceDir]) {
      const abs = resolve(base, rel);
      const within = relative(sourceDir, abs);
      if (within && !within.startsWith("..") && !isAbsolute(within) && existsSync(abs)) {
        return abs;
      }
    }
    // Not found in either root, but still guard traversal for the error path.
    const abs = resolve(instructionsDir, rel);
    const within = relative(sourceDir, abs);
    if (!within || within.startsWith("..") || isAbsolute(within)) return null;
    return abs; // absent file → a read error is reported by the caller
  }

  /** Load `agents/*.md` into store {@link AgentConfig}s (frontmatter + body). */
  private async loadAgents(
    projectId: string,
    agentsDir: string,
    errors: ProjectConfigError[],
  ): Promise<AgentConfig[]> {
    if (!existsSync(agentsDir)) return [];
    let files: string[];
    try {
      files = (await readdir(agentsDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name);
    } catch (err) {
      errors.push({ scope: "agent", message: msg(err) });
      return [];
    }
    files.sort();
    const out: AgentConfig[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      try {
        const raw = await readFile(join(agentsDir, file), "utf8");
        const { data, body } = parseFrontmatter(raw);
        const name = typeof data.name === "string" && data.name.trim() ? data.name : file.replace(/\.md$/, "");
        const id = slugifyConfigName(name);
        if (!id) {
          errors.push({ scope: "agent", file, message: "agent name is empty" });
          continue;
        }
        if (seen.has(id)) {
          errors.push({ scope: "agent", file, message: `duplicate agent id "${id}"` });
          continue;
        }
        const permMode = PermissionModeSchema.safeParse(data.permissionMode);
        const agent = AgentConfigSchema.parse({
          id,
          name,
          instructions: body,
          permissionMode: permMode.success ? permMode.data : "default",
          allowedTools: toStringArray(data.tools),
          disallowedTools: toStringArray(data.disallowedTools),
          model: typeof data.model === "string" ? data.model : undefined,
          scope: "project",
          projectId,
        });
        seen.add(id);
        out.push(agent);
      } catch (err) {
        errors.push({ scope: "agent", file, message: msg(err) });
      }
    }
    return out;
  }

  /** Load `modes/*.yaml` into {@link ConfigMode}s. */
  private async loadModes(
    modesDir: string,
    errors: ProjectConfigError[],
  ): Promise<ConfigMode[]> {
    if (!existsSync(modesDir)) return [];
    let files: string[];
    try {
      files = (await readdir(modesDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml")))
        .map((e) => e.name);
    } catch (err) {
      errors.push({ scope: "mode", message: msg(err) });
      return [];
    }
    files.sort();
    const out: ConfigMode[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      try {
        const raw = await readFile(join(modesDir, file), "utf8");
        const data = (parseYaml(raw) ?? {}) as Record<string, unknown>;
        const name = typeof data.name === "string" && data.name.trim() ? data.name : file.replace(/\.ya?ml$/, "");
        const id = slugifyConfigName(name);
        if (!id) {
          errors.push({ scope: "mode", file, message: "mode name is empty" });
          continue;
        }
        if (seen.has(id)) {
          errors.push({ scope: "mode", file, message: `duplicate mode id "${id}"` });
          continue;
        }
        const permMode = PermissionModeSchema.safeParse(data.permissionMode);
        if (!permMode.success) {
          errors.push({ scope: "mode", file, message: `invalid or missing permissionMode` });
          continue;
        }
        const mode = ConfigModeSchema.parse({
          id,
          name,
          description: typeof data.description === "string" ? oneLine(data.description) : undefined,
          permissionMode: permMode.data,
          allowedTools: toStringArray(data.allowedTools),
          disallowedTools: toStringArray(data.disallowedTools),
          file,
        });
        seen.add(id);
        out.push(mode);
      } catch (err) {
        errors.push({ scope: "mode", file, message: msg(err) });
      }
    }
    return out;
  }
}

/* ------------------------------------------------------------- merge helpers */

/** Error-message extractor. */
function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Produce the effective project record: authored `.claude-manager/` fields
 * OVERRIDE the stored `.data` project. Absent manifest fields keep the stored
 * value (never clobbered). Identity/runtime fields (id, repoPath, createdAt,
 * defaultBranch) are always preserved. subApps are REPLACED when the manifest
 * declares any; mcpServers are MERGED (authored wins per-name) so a manually
 * added `.data` server isn't lost.
 */
export function mergeProject(stored: Project, config: ProjectConfig): Project {
  return {
    ...stored,
    name: config.name || stored.name,
    worktreeRoot: config.worktreeRoot ?? stored.worktreeRoot,
    worktreeCmd: config.worktreeCmd ?? stored.worktreeCmd,
    shipCmd: config.shipCmd ?? stored.shipCmd,
    subApps: config.subApps.length ? config.subApps : stored.subApps,
    mcpServers:
      Object.keys(config.mcpServers).length || stored.mcpServers
        ? { ...(stored.mcpServers ?? {}), ...config.mcpServers }
        : undefined,
  };
}

/** Shallow structural compare (JSON) to decide whether a re-persist is needed. */
export function projectChanged(a: Project, b: Project): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}
