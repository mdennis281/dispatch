/**
 * ProjectConfigService — loads, syncs, and watches a managed repo's
 * self-contained `.dispatch/` config.
 *
 * A managed repo may carry a committable `.dispatch/` directory at its
 * root that is the SOURCE OF TRUTH for its authored Dispatch config. This
 * service:
 *   - DISCOVERS `.dispatch/project.yaml` under a project's `repoPath`,
 *   - PARSES + VALIDATES the manifest (yaml@2 + zod) and LOADS the `agents/`,
 *     `modes/`, `instructions/` files it references into the normalized
 *     {@link ProjectConfig} — resiliently: a malformed file yields a structured
 *     error surfaced over the API, never a crash,
 *   - SYNCS the loaded authored config into the existing project store as a
 *     runtime cache (authored fields OVERRIDE the `.data` project record) so
 *     every existing consumer keeps working — precedence:
 *       `.dispatch/` present → its fields win;
 *       absent → the current `.data` store is used as-is (back-compat), and
 *   - WATCHES `.dispatch/` (debounced) and re-runs the above on change,
 *     emitting a `project-config-update` bus event.
 *
 * `.data` keeps ONLY runtime state; this service never persists anything but the
 * merged project record (via the normal `store.saveProject`), and only when it
 * actually changed. Projects without a `.dispatch/` are never mutated.
 *
 * fs / yaml parsing + the fs watcher are behind small injectable seams so tests
 * can drive load + reload deterministically without a real watcher.
 */
import { join, resolve, relative, isAbsolute } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { configDirFor } from "@dispatch/cli/core";
import { parse as parseYaml } from "yaml";
import {
  ProjectManifestSchema,
  ProjectConfigSchema,
  ProjectConfigResultSchema,
  AgentConfigSchema,
  ConfigModeSchema,
  ModeConfigSchema,
  SkillConfigSchema,
  PermissionModeSchema,
  EffortSchema,
  MANIFEST_FILE,
  resolveWorkflow,
  expandEnvVars,
  expandEnvList,
  expandEnvRecord,
  DEFAULT_INSTRUCTIONS_DIR,
  DEFAULT_AGENTS_DIR,
  DEFAULT_MODES_DIR,
  DEFAULT_MEMORY_DIR,
  DEFAULT_SKILLS_DIR,
  type Project,
  type ProjectConfig,
  type ProjectConfigResult,
  type ProjectConfigError,
  type NormalizedInstruction,
  type ConfigMode,
  type ModeConfig,
  type AgentConfig,
  type SkillConfig,
  type SubApp,
  type McpServerConfig,
  type WorkflowConfig,
} from "@dispatch/shared";
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
   * Injectable watch factory (tests). Given the `.dispatch/` dir and a
   * change listener, returns a closable watcher. Defaults to a recursive
   * `fs.watch`. A factory that returns `null` disables watching.
   */
  watch?: (dir: string, onChange: () => void) => ConfigWatcher | null;
}

/* ------------------------------------------------------------------ helpers */

/**
 * Upper bound on the authored-instructions text injected into a session's
 * system prompt. Long-form instructions live in the append; a runaway file is
 * clamped (with a visible marker) so it can't blow the prompt budget.
 */
export const MAX_INSTRUCTION_INJECTION_CHARS = 24_000;

/**
 * Render a project's concatenated authored instructions into a clearly-delimited,
 * bounded system-prompt append section. Returns null for empty/blank text so an
 * unconfigured (or instruction-less) project injects nothing.
 */
export function renderInstructionsInjection(
  text: string | null | undefined,
): string | null {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  const bounded =
    trimmed.length > MAX_INSTRUCTION_INJECTION_CHARS
      ? `${trimmed.slice(0, MAX_INSTRUCTION_INJECTION_CHARS)}\n\n… (instructions truncated)`
      : trimmed;
  return [
    "## Project instructions",
    "_Authored in `.dispatch/` — project-specific house rules for this repo._",
    "",
    bounded,
  ].join("\n");
}

/** Map a config-authored {@link ConfigMode} onto the store {@link ModeConfig}
 *  shape (a named permission posture) so it flows through the same mode
 *  registry the broker/UI already consume. Config modes are project-scoped. */
export function configModeToModeConfig(
  mode: ConfigMode,
  projectId: string,
): ModeConfig {
  return ModeConfigSchema.parse({
    id: mode.id,
    name: mode.name,
    permissionMode: mode.permissionMode,
    scope: "project",
    projectId,
  });
}

/**
 * Merge two id-keyed lists with `preferred` winning on id collision: every
 * `preferred` entry, plus each `fallback` entry whose id isn't already present.
 * Used so config-sourced agents/modes take precedence over `.data`-defined ones.
 */
export function mergeById<T extends { id: string }>(
  preferred: T[],
  fallback: T[],
): T[] {
  const seen = new Set(preferred.map((e) => e.id));
  return [...preferred, ...fallback.filter((e) => !seen.has(e.id))];
}

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

/**
 * Normalize a manifest MCP transport into the flat store {@link McpServerConfig},
 * expanding `${VAR}` / `${VAR:-default}` placeholders from the manager's own
 * environment on the way through.
 *
 * `project.yaml` is COMMITTED, so an MCP server that needs an API key writes a
 * placeholder rather than the key; the substitution happens here, at load, so the
 * secret only ever exists in memory. A placeholder with no matching variable
 * expands to "" and is collected in `missing` — the server still gets built (one
 * unset key must not stop a project's sessions from starting) and the caller
 * turns the gap into a visible config warning.
 */
function transportToMcpConfig(
  transport: {
    type: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  },
  missing?: Set<string>,
): McpServerConfig {
  const opts = { onMissing: (name: string) => missing?.add(name) };
  const str = (v: string | undefined): string | undefined =>
    v === undefined ? undefined : expandEnvVars(v, opts);

  if (transport.type === "stdio") {
    return {
      type: "stdio",
      command: str(transport.command),
      args: expandEnvList(transport.args, opts),
      env: expandEnvRecord(transport.env, opts),
    };
  }
  return {
    type: transport.type,
    url: str(transport.url),
    headers: expandEnvRecord(transport.headers, opts),
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
        // An FSWatcher is an EventEmitter, and the try/catch above only covers a
        // SYNCHRONOUS failure to start watching. Runtime failures arrive later, as
        // an `'error'` EVENT — and Node throws an unlistened `'error'` emit as an
        // uncaught exception, which killed the whole server. That is not a rare
        // path here: this watches `<repoPath>/.dispatch` RECURSIVELY, the tree
        // MemoryCommitter and TrunkSync run `git add`/`commit`/`rebase` inside,
        // and Windows' ReadDirectoryChangesW readily reports EPERM/UNKNOWN when a
        // watched subtree is renamed under it. One watcher exists per project, so
        // every project added is another emitter that could take the process down.
        // A dead watcher just means this project stops live-reloading its config
        // until the next `watchProject` — strictly better than losing every session.
        w.on("error", () => {
          try {
            w.close();
          } catch {
            /* already gone */
          }
        });
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

  /** True when a project has a valid `.dispatch/` config loaded. */
  hasConfig(projectId: string): boolean {
    return !!this.cache.get(projectId)?.config;
  }

  /**
   * This project's spawn-chat consent override, or null when it doesn't author
   * one (then the app setting decides — which defaults to asking). Null and
   * `false` are deliberately distinct: a project may insist on the prompt even
   * where the human turned auto-approve on globally.
   */
  getSpawnAutoApprove(projectId: string): boolean | null {
    return this.cache.get(projectId)?.config?.spawnChat?.autoApprove ?? null;
  }

  /* ----------------------------------------------------- agent/mode registry */

  /**
   * Every config-sourced agent across all loaded projects (already
   * project-scoped {@link AgentConfig}s). The broker + the `GET /api/agents`
   * listing merge these OVER the `.data` store (config wins on id collision).
   */
  configAgents(): AgentConfig[] {
    const out: AgentConfig[] = [];
    for (const result of this.cache.values()) {
      if (result.config) out.push(...result.config.agents);
    }
    return out;
  }

  /** A config-sourced agent by id (first match across projects), else null. */
  getAgent(id: string): AgentConfig | null {
    for (const result of this.cache.values()) {
      const found = result.config?.agents.find((a) => a.id === id);
      if (found) return found;
    }
    return null;
  }

  /**
   * Every config-sourced mode mapped onto the store {@link ModeConfig} shape,
   * across all loaded projects. Consumed by the broker's permission-mode
   * resolution + the `GET /api/modes` listing (config wins on id collision).
   */
  configModes(): ModeConfig[] {
    const out: ModeConfig[] = [];
    for (const [projectId, result] of this.cache) {
      for (const mode of result.config?.modes ?? []) {
        out.push(configModeToModeConfig(mode, projectId));
      }
    }
    return out;
  }

  /** A config-sourced mode by id (first match across projects), else null. */
  getMode(id: string): ModeConfig | null {
    for (const [projectId, result] of this.cache) {
      const found = result.config?.modes.find((m) => m.id === id);
      if (found) return configModeToModeConfig(found, projectId);
    }
    return null;
  }

  /**
   * The bounded, clearly-delimited system-prompt append for a project's authored
   * custom instructions (from its `.dispatch/` config), or null when the
   * project has no config / no instructions — so nothing is injected.
   */
  buildInstructionsInjection(projectId: string): string | null {
    return renderInstructionsInjection(this.getConfig(projectId)?.instructionsText);
  }

  /**
   * A project's config-sourced external MCP servers (name → config), or `{}` when
   * it has no `.dispatch/`. The broker merges these into every session's
   * `Options.mcpServers` (config wins over the `.data` record; the in-process
   * `manager` server is always applied last and never clobbered), and the MCP
   * catalog probes them — so a config-declared server appears wherever a session's
   * servers do. Kept config-first (not just the store-synced copy) so a live
   * watcher edit is reflected even for a session that captured a stale project.
   */
  getMcpServers(projectId: string): Record<string, McpServerConfig> {
    return { ...(this.getConfig(projectId)?.mcpServers ?? {}) };
  }

  /**
   * A project's config-sourced sub-apps (mapped onto the store {@link SubApp}
   * shape), or `[]` when it has no `.dispatch/`. These are merged over the
   * `.data` record (config wins on id; `.data`-only sub-apps survive) into the
   * project the RunnerService + Apps panel consume.
   */
  getSubApps(projectId: string): SubApp[] {
    return [...(this.getConfig(projectId)?.subApps ?? [])];
  }

  /**
   * A project's config-sourced skills (loaded from `.dispatch/skills/`),
   * or `[]` when it has no `.dispatch/`. The broker MATERIALIZES these into
   * a session's effective `<cwd>/.claude/skills/` at launch (a merge that never
   * clobbers a skill the repo already ships) so the Agent SDK discovers them.
   * Consulted config-first (not the store) so a live watcher edit is reflected.
   */
  getSkills(projectId: string): SkillConfig[] {
    return [...(this.getConfig(projectId)?.skills ?? [])];
  }

  /**
   * Load a project's `.dispatch/` from disk into a normalized result.
   * Pure read — no store writes, no events. Resilient: any parse/read failure
   * becomes a structured error, never a throw.
   */
  async load(project: Project): Promise<ProjectConfigResult> {
    const sourceDir = configDirFor(project.repoPath);
    const manifestPath = join(sourceDir, MANIFEST_FILE);

    // No config dir → back-compat: the `.data` store is used as-is.
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
    const skillsDir = join(sourceDir, manifest.skills ?? DEFAULT_SKILLS_DIR);
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
        instructions.push({
          source: "file",
          file: rel,
          // Where it ACTUALLY resolved (see NormalizedInstruction.rel) — the
          // authored `rel` may be relative to either root.
          rel: relative(sourceDir, abs).replace(/\\/g, "/"),
          text: text.replace(/\r\n/g, "\n").trimEnd(),
        });
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

    // --- skills ---
    const skills = await this.loadSkills(skillsDir, errors);

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
      env: s.env,
      url: s.url,
      dockerCompose: s.docker,
    }));

    // --- mcpServers (array → keyed record; transport flattened + env-expanded) ---
    const mcpServers: Record<string, McpServerConfig> = {};
    for (const server of manifest.mcpServers ?? []) {
      // A `${VAR}` the manager's environment doesn't define is a config problem
      // worth SHOWING (the server will just fail to authenticate otherwise), but
      // not worth failing the load over — so it lands in `errors`, not a throw.
      const missing = new Set<string>();
      mcpServers[server.name] = transportToMcpConfig(server.transport, missing);
      if (missing.size) {
        errors.push({
          scope: "manifest",
          file: MANIFEST_FILE,
          message:
            `MCP server "${server.name}" references unset environment ` +
            `variable(s): ${[...missing].join(", ")}. They expand to an empty ` +
            `string — set them where Dispatch runs.`,
        });
      }
    }

    // --- workflow sanity (non-fatal) ---
    await this.checkWorkflowCoherence(project, manifest, errors);

    const config: ProjectConfig = ProjectConfigSchema.parse({
      sourceDir,
      name: manifest.name,
      worktreeRoot: manifest.worktreeRoot,
      worktreeCmd: manifest.worktree,
      shipCmd: manifest.ship,
      workflow: manifest.workflow,
      spawnChat: manifest.spawnChat,
      defaults: manifest.defaults,
      instructions,
      instructionsText: instructionsText || undefined,
      subApps,
      mcpServers,
      agents,
      modes,
      skills,
      memoryDir,
      agentsDir,
      modesDir,
      skillsDir,
      instructionsDir,
    });

    return ProjectConfigResultSchema.parse({ sourceDir, config, errors });
  }

  /**
   * Catch a workflow that PROMISES more than the repo can deliver, at config
   * load rather than three PRs later.
   *
   * The specific shape being caught: `profile: review` + `autoMerge: on-green`
   * on a repo that has NO CI workflows and configures NO reviewers. "Green" is
   * then trivially true — zero checks reported, nothing failing — so auto-merge
   * would land every PR on the strength of no evidence at all, with nobody
   * having looked at it either. That is exactly what happened on the run this
   * check was written for, and it went unnoticed until a human read the PRs by
   * hand. The new-project case ("this repo's CI flow is always trash at first")
   * is the same shape.
   *
   * Deliberately a WARNING, never fatal: a small repo with no CI is a legitimate
   * state, `pr.requireChecks` already refuses the merge at the moment it
   * matters, and breaking a project's config load over a policy opinion would be
   * a wildly disproportionate response.
   */
  private async checkWorkflowCoherence(
    project: Project,
    manifest: { workflow?: WorkflowConfig; ship?: string },
    errors: ProjectConfigError[],
  ): Promise<void> {
    const wf = resolveWorkflow({ workflow: manifest.workflow, shipCmd: manifest.ship });
    if (wf.autoMerge !== "on-green") return;
    if (wf.pr.reviewers.length > 0) return;

    let hasCi: boolean;
    try {
      const entries = await readdir(join(project.repoPath, ".github", "workflows"));
      hasCi = entries.some((f) => /\.ya?ml$/i.test(f));
    } catch (err) {
      // ENOENT = no workflows dir, which IS the condition. Any other error means
      // we couldn't tell, and a warning on a guess is worse than no warning.
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return;
      hasCi = false;
    }
    if (hasCi) return;

    errors.push({
      scope: "manifest",
      file: MANIFEST_FILE,
      message:
        "`workflow.autoMerge: on-green` is vacuous here: this repo has no GitHub Actions " +
        "workflows, so no check ever reports and \"green\" is trivially true — and " +
        "`workflow.pr.reviewers` is empty, so nobody is asked to look either. Add a CI " +
        "workflow, list reviewers under `workflow.pr.reviewers`, or turn auto-merge off. " +
        "Until then `pr.requireChecks`/`pr.requireReview` will refuse the merge.",
    });
  }

  /**
   * Reload a project by id: load from disk, SYNC into the store (authored fields
   * override the `.data` record — only persisted when actually changed), cache
   * the result, and emit `project-config-update`. Returns the result (an empty
   * back-compat result when the project has no `.dispatch/`). Never throws.
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
        sourceDir: configDirFor(project.repoPath),
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
   * Watch a project's `.dispatch/` for changes and debounced-reload. No-op
   * when the dir is absent (a back-compat project needs no watcher) or already
   * watched. Idempotent.
   */
  watchProject(project: Project): void {
    if (this.watchers.has(project.id)) return;
    const dir = configDirFor(project.repoPath);
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
          // `effort:` is optional and free-form in frontmatter; an unknown level
          // means "inherit the chat's" rather than a load error for the whole agent.
          effort: EffortSchema.safeParse(data.effort).data,
          scope: "project",
          projectId,
          // The id is a slug of `name`, which need not match the filename — keep
          // the real one so the UI can open/delete exactly this file.
          file,
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

  /**
   * Load `.dispatch/skills/` into {@link SkillConfig}s. Two layouts:
   *   - a skill DIRECTORY `skills/<dir>/SKILL.md` (frontmatter `{ name,
   *     description }` + body; the whole dir is the skill), and
   *   - a FLAT `skills/<name>.md` single-file skill.
   * Resilient: a dir without a `SKILL.md`, a duplicate id, or a read failure
   * yields a structured `skill` error and the other skills still load.
   */
  private async loadSkills(
    skillsDir: string,
    errors: ProjectConfigError[],
  ): Promise<SkillConfig[]> {
    if (!existsSync(skillsDir)) return [];
    let entries: { name: string; isDir: boolean; isFile: boolean }[];
    try {
      entries = (await readdir(skillsDir, { withFileTypes: true })).map((e) => ({
        name: e.name,
        isDir: e.isDirectory(),
        isFile: e.isFile(),
      }));
    } catch (err) {
      errors.push({ scope: "skill", message: msg(err) });
      return [];
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const out: SkillConfig[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      // A skill directory: `skills/<dir>/SKILL.md` (+ any supporting files).
      if (entry.isDir) {
        const file = join(skillsDir, entry.name, "SKILL.md");
        if (!existsSync(file)) {
          errors.push({ scope: "skill", file: `${entry.name}/SKILL.md`, message: "missing SKILL.md" });
          continue;
        }
        await this.pushSkill(out, seen, errors, {
          file,
          rel: `${entry.name}/SKILL.md`,
          dir: entry.name,
          layout: "dir",
          fallbackName: entry.name,
        });
        continue;
      }
      // A flat single-file skill: `skills/<name>.md`.
      if (entry.isFile && entry.name.toLowerCase().endsWith(".md")) {
        const base = entry.name.replace(/\.md$/i, "");
        await this.pushSkill(out, seen, errors, {
          file: join(skillsDir, entry.name),
          rel: entry.name,
          dir: base,
          layout: "flat",
          fallbackName: base,
        });
      }
    }
    return out;
  }

  /** Read one skill's SKILL.md/`.md`, build a {@link SkillConfig}, dedupe by id. */
  private async pushSkill(
    out: SkillConfig[],
    seen: Set<string>,
    errors: ProjectConfigError[],
    src: { file: string; rel: string; dir: string; layout: "dir" | "flat"; fallbackName: string },
  ): Promise<void> {
    try {
      const raw = await readFile(src.file, "utf8");
      const { data } = parseFrontmatter(raw);
      const name =
        typeof data.name === "string" && data.name.trim() ? data.name.trim() : src.fallbackName;
      const id = slugifyConfigName(name);
      if (!id) {
        errors.push({ scope: "skill", file: src.rel, message: "skill name is empty" });
        return;
      }
      if (seen.has(id)) {
        errors.push({ scope: "skill", file: src.rel, message: `duplicate skill id "${id}"` });
        return;
      }
      const skill = SkillConfigSchema.parse({
        id,
        name,
        description: typeof data.description === "string" ? oneLine(data.description) : undefined,
        dir: src.dir,
        path: src.file,
        layout: src.layout,
      });
      seen.add(id);
      out.push(skill);
    } catch (err) {
      errors.push({ scope: "skill", file: src.rel, message: msg(err) });
    }
  }
}

/* ------------------------------------------------------------- merge helpers */

/** Error-message extractor. */
function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Produce the effective project record: authored `.dispatch/` fields
 * OVERRIDE the stored `.data` project. Absent manifest fields keep the stored
 * value (never clobbered). Identity/runtime fields (id, repoPath, createdAt,
 * defaultBranch) are always preserved. subApps AND mcpServers are MERGED
 * (authored wins per-id/-name; a `.data`-only entry survives) so a manually
 * added sub-app or MCP server isn't lost.
 */
export function mergeProject(stored: Project, config: ProjectConfig): Project {
  return {
    ...stored,
    name: config.name || stored.name,
    worktreeRoot: config.worktreeRoot ?? stored.worktreeRoot,
    worktreeCmd: config.worktreeCmd ?? stored.worktreeCmd,
    shipCmd: config.shipCmd ?? stored.shipCmd,
    workflow: config.workflow ?? stored.workflow,
    // A manifest-backed project uses absence to mean "inherit from the app".
    // Keeping the stored value here would resurrect an override the user reset.
    shellFilter: config.defaults?.shellFilter,
    subApps: mergeById(config.subApps, stored.subApps),
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
