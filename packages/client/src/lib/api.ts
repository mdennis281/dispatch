/**
 * Typed REST client for the @dispatch/server API (everything under /api). Thin
 * wrappers over fetch that speak the @dispatch/shared domain types. The shell feeds
 * stores from mock data today; 2b swaps these in for the live backend without
 * changing call sites.
 */
import type {
  Project,
  Chat,
  ChatMediaItem,
  ChatMessage,
  AgentConfig,
  AgentConfigInput,
  ModeConfig,
  AttentionItem,
  NotificationPrefs,
  PermissionRequest,
  RunnerInstance,
  RegistryQuery,
  TerminalInfo,
  WorktreeInfo,
  BranchInfo,
  ReapPlan,
  ReapResult,
  PRInfo,
  PrRecord,
  WorkflowDef,
  WorkflowRun,
  WorkflowWithLastRun,
  WorkflowInput,
  ImageRef,
  Checkpoint,
  ProjectMemory,
  MemoryType,
  McpCatalog,
  McpEnablementScope,
  GitStatus,
  GitBranch,
  GitCommit,
  GitCommitFile,
  GitStash,
  ProjectConfigResult,
  UsageSnapshot,
  ChatRuntimeResponse,
  MetricDimension,
  MetricEvent,
  MetricFacetsResponse,
  MetricFilter,
  MetricQueryInput,
  MetricSeriesResponse,
  MetricSpan,
  MetricSpanDimension,
  MetricSpanFacetsResponse,
  MetricSpanFilter,
  MetricSpanQueryInput,
  MetricSpanSeriesResponse,
  MetricSpanSummary,
  MetricSpanTotalsResponse,
  MetricTotalsResponse,
  UpdateStatus,
  UpdateChannel,
  ContextUsage,
  ModelOption,
  WorkflowConfig,
  WorkflowExemption,
  LaunchAgentTaskInput,
  MessagePart,
  HarnessKind,
  Effort,
  ShellTranscriptFilter,
  FsEntry,
  FsListing,
  FsDetails,
  FsRoot,
  FsPlatform,
  FsSelectKind,
  FsMutation,
  FsMutationResult,
  ReviewerStatus,
  ReviewerVerify,
} from "@dispatch/shared";
import { sessionFetch } from "../stores/auth.js";

/**
 * Global app settings — mirrors the server `AppSettingsSchema`
 * (packages/server/src/store/index.ts). The client never imports the server
 * package, so the shape is declared here and the server Zod schema validates it
 * on write.
 */
export interface AppSettings {
  /** Kept in the same shape as `ThemePref` in stores/theme.ts. */
  theme: "dark" | "light" | "system";
  defaultModeId?: string;
  webhook?: {
    kind?: "ntfy" | "pushover";
    url?: string;
    enabled?: boolean;
  };
  /** Native SDK auto-compaction: summarize + continue when the window fills. */
  autoCompact?: {
    enabled?: boolean;
    /** Optional compaction reserve window (tokens); omit = SDK default. */
    window?: number;
  };
  /**
   * App-wide default for showing the context Dispatch attaches on your behalf
   * (surfaced memories, repo snapshots) in a transcript. A project manifest or
   * an individual chat can override it; unset everywhere means off.
   */
  showInjectedContext?: boolean;
  /** App-wide defaults for which tool families appear in transcript shells. */
  shellFilter?: ShellTranscriptFilter;
  /**
   * Per-server MCP on/off pins for this install, under a project's own
   * `mcpEnabled`. Written through `api.mcp.setEnabled`, NOT through a settings
   * PUT — that endpoint is a full replace and the MCP view holds one toggle,
   * not a complete settings draft.
   */
  mcpEnabled?: Record<string, boolean>;
  /**
   * Whether an agent calling `spawn_chat` may start a chat WITHOUT asking. Off
   * by default: a spawn stops for an approval prompt, and this is the only thing
   * that lifts it (a project's manifest may override it per repo).
   */
  spawnChat?: {
    autoApprove?: boolean;
  };
  /**
   * Automatic worktree cleanup. ON when unset, unlike `spawnChat` above: the
   * reaper only removes a tree whose branch has merged, which is clean, fully
   * pushed and which nothing is running in — and left off by default it would
   * preserve the problem it exists to solve.
   */
  worktreeCleanup?: {
    enabled?: boolean;
    /** Also delete the local branch — `git worktree remove` leaves it behind. */
    deleteBranch?: boolean;
    graceMinutes?: number;
  };
  auth?: {
    enabled?: boolean;
    firstRunDismissed?: boolean;
    canonicalUrl?: string;
    rpId?: string;
  };
  /** How many chats may hold an execution slot at once. Unset = the server's
   *  own default (`DISPATCH_MAX_ACTIVE_SESSIONS`, else DEFAULT_MAX_ACTIVE_SESSIONS). */
  maxActiveSessions?: number;
  harness?: {
    defaultHarness?: HarnessKind;
    defaults?: Partial<Record<HarnessKind, { model?: string; effort?: Effort }>>;
    contextLimits?: {
      perChatTokens?: number;
      overallTokens?: number;
    };
  };
}

export interface HarnessInfo {
  kind: HarnessKind;
  runtime: { path?: string; version?: string; source: string; available: boolean };
  capabilities: {
    efforts: Effort[];
    compaction: boolean;
    fork: boolean;
    questions: boolean;
    liveModelSwitch: boolean;
    livePermissionSwitch: boolean;
    [key: string]: unknown;
  };
}

/** An OS process LISTENING on a project's port (mirrors server ProjectProcess). */
export interface ProjectProcess {
  port: number;
  pid: number;
  name?: string;
  /** True when a runner OR a chat's shell accounts for this listener. */
  tracked: boolean;
  runnerId?: string;
  subAppId?: string;
  branch?: string;
  worktreePath?: string;
  /** How Dispatch knows about it: an app runner, a chat's shell, or not at all. */
  source: "runner" | "terminal" | "orphan";
  /** Chat whose shell started it (`source: "terminal"`). */
  chatId?: string;
  chatTitle?: string;
  terminalName?: string;
  /** `${chatId}::${name}` — joins a row to its shell card in the Terminals tab. */
  terminalId?: string;
}

/** Per-pid outcome of a bulk kill (mirrors server KillResult). */
export interface KillResult {
  pid: number;
  ok: boolean;
  error?: string;
}

/** One file's structured change vs a base ref (mirrors the server FileDiff). */
export interface ServerFileDiff {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
}

/** Full worktree-vs-base diff (mirrors the server WorktreeDiff). */
export interface ServerWorktreeDiff {
  base: string;
  additions: number;
  deletions: number;
  files: ServerFileDiff[];
}

/** One candidate from the file-path picker (mirrors the server IndexedFile). */
export interface IndexedFile {
  /** Repo-relative, forward-slashed — what the picker SHOWS. */
  rel: string;
  /** Absolute, server-native separators — what gets inserted. */
  abs: string;
}

/** Response of the file-path search (mirrors the server /api/files payload). */
export interface FileSearchResult {
  /** The chat's working directory the paths are rooted at. */
  root: string;
  files: IndexedFile[];
}

/**
 * What's at a filesystem path right now (mirrors the server /api/fs/probe
 * payload). The new-project form asks before it lets you create anything: an
 * existing checkout, an empty directory and a path that doesn't exist yet are
 * three different setups, and only the server can tell them apart.
 */
export interface PathProbe {
  /** The path as resolved by the server (absolute, forward-slashed). */
  path: string;
  /** The text sent was already absolute; a relative one resolves against the server. */
  absolute: boolean;
  exists: boolean;
  isDirectory: boolean;
  /** Inside a git repo — resolved by walking up, so a nested path counts. */
  isGit: boolean;
  /** The enclosing repo's top level, when `isGit`. */
  repoRoot: string | null;
  /** No code here yet: empty, or holding only `.git`/`.dispatch`. */
  empty: boolean;
  /** The immediate parent exists — i.e. only this directory has to be created. */
  parentExists: boolean;
  /** Nearest existing ancestor — null when even the drive/root is missing. */
  existingParent: string | null;
  /** The repo's already-committed `.dispatch/project.yaml`, verbatim, if it has one. */
  dispatchConfig: string | null;
  /** That manifest's `name:` / `worktreeRoot:` — what the project will actually have. */
  dispatchName: string | null;
  dispatchWorktreeRoot: string | null;
}

/** A single file's content for the Monaco viewer/diff (mirrors WorktreeFile). */
export interface WorktreeFileContent {
  path: string;
  ref?: string;
  content: string;
  encoding: "utf8" | "base64";
  binary: boolean;
  size: number;
  exists: boolean;
  truncated: boolean;
}

/** Body accepted by POST /api/chats/:id/assets. */
export interface UploadAssetBody {
  /** Base64 or a `data:<mime>;base64,<…>` URL. */
  data: string;
  mimeType?: string;
  alt?: string;
  width?: number;
  height?: number;
  filename?: string;
}

/**
 * Resolve an ImageRef to its serve endpoint. `data:`/`http(s)`/`blob:` pass
 * through; a stored relative asset path maps to `/api/chats/:id/assets/:name`.
 *
 * NOT a `src=` you can hand to an `<img>`: that endpoint is behind the bearer
 * auth gate and a subresource request carries no token. Use `useAssetSrc` /
 * `AssetImage` (lib/assetSrc.ts), which fetch it through the session.
 */
export function assetUrl(chatId: string, image: { path: string }): string {
  const p = image.path;
  if (/^(https?:|data:|blob:)/i.test(p)) return p;
  const name = p.split(/[\\/]/).pop() ?? p;
  return `${BASE}/api/chats/${chatId}/assets/${encodeURIComponent(name)}`;
}

/**
 * The endpoint that serves a file from the PROJECT filesystem — what an agent's
 * `![chart](out/chart.png)` resolves to.
 *
 * Separate from `assetUrl` because the two answer different questions.
 * `assets/<name>` is content-addressed and immutable; a working-tree path is
 * live, relative to the chat's worktree, and confined server-side. Conflating
 * them would mean either caching a live file forever or re-fetching an
 * immutable one on every scroll.
 */
/** Every image in a chat, in transcript order — independent of the window. */
export function chatMediaUrl(chatId: string): string {
  return `${BASE}/api/chats/${chatId}/media`;
}

export function fsAssetUrl(chatId: string, path: string): string {
  return `${BASE}/api/chats/${chatId}/fs-asset?path=${encodeURIComponent(path)}`;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Base for all requests. Same-origin in prod; Vite proxies /api in dev. */
const BASE = "";

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await sessionFetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      /* non-JSON error body */
    }
    const msg =
      (detail && typeof detail === "object" && "error" in detail
        ? String((detail as { error: unknown }).error)
        : res.statusText) || `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, detail);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body);
const put = <T>(path: string, body?: unknown) => request<T>("PUT", path, body);
const del = <T>(path: string, body?: unknown) => request<T>("DELETE", path, body);

// `boolean` is in the union for the registry's facet flags: `false` is a real
// filter ("only the ones that aren't"), so it must serialize rather than be
// mistaken for "unset" — which is why the guard below tests `undefined`, not
// falsiness.
function qs(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** The typed REST surface, grouped by resource. */
export const api = {
  /* projects */
  projects: {
    list: () => get<Project[]>("/api/projects"),
    get: (id: string) => get<Project>(`/api/projects/${id}`),
    /**
     * Create a project. `initRepo` additionally creates the directory and
     * `git init`s it — for the case where the human is STARTING a project
     * rather than adopting one. Ignored when the path already exists.
     */
    create: (body: Partial<Project> & { initRepo?: boolean }) =>
      post<Project>("/api/projects", body),
    update: (id: string, body: Partial<Project>) =>
      put<Project>(`/api/projects/${id}`, body),
    remove: (id: string) => del<void>(`/api/projects/${id}`),
    worktrees: (id: string) =>
      get<WorktreeInfo[]>(`/api/projects/${id}/worktrees`),
  },

  /* chats + transcript */
  chats: {
    list: (projectId?: string) =>
      get<Chat[]>(`/api/chats${qs({ projectId })}`),
    get: (id: string) => get<Chat>(`/api/chats/${id}`),
    create: (body: { projectId: string; title?: string; modeId?: string; agentId?: string }) =>
      post<Chat>("/api/chats", body),
    update: (
      id: string,
      body: Omit<Partial<Chat>, "shellFilter"> & { shellFilter?: ShellTranscriptFilter | null },
    ) =>
      put<Chat>(`/api/chats/${id}`, body),
    remove: (id: string) => del<void>(`/api/chats/${id}`),
    /**
     * Every image in the chat, in transcript order.
     *
     * Deliberately NOT derived from `messages` above: that is a 150-row window,
     * so a gallery built from it silently reports a total that measures how far
     * the human scrolled rather than how many pictures the chat holds.
     */
    media: async (id: string) =>
      (await get<{ items: ChatMediaItem[] }>(`/api/chats/${id}/media`)).items,
    /**
     * A WINDOW of a chat's transcript, newest-first-biased and LEAN: bulky tool
     * payloads the collapsed cards don't render arrive clipped + flagged (see
     * `messagesFull` for hydrate-on-expand). Page backwards with `beforeId`.
     */
    messages: (
      id: string,
      opts?: { limit?: number; afterId?: string; beforeId?: string },
    ) =>
      get<ChatMessage[]>(
        `/api/chats/${id}/messages${qs({
          limit: opts?.limit,
          afterId: opts?.afterId,
          beforeId: opts?.beforeId,
        })}`,
      ),
    /** Verbatim rows by id — the full payload behind a clipped (lean) row. */
    messagesFull: (id: string, ids: string[]) =>
      get<ChatMessage[]>(
        `/api/chats/${id}/messages/full${qs({ ids: ids.join(",") })}`,
      ),
    checkpoints: (id: string) => get<Checkpoint[]>(`/api/chats/${id}/checkpoints`),
    /**
     * Human-approved guard lifts live on this chat's session. Live-session
     * state, so a chat that isn't running answers `[]` — there is nowhere for an
     * exemption to persist, by design.
     */
    exemptions: (id: string) => get<WorkflowExemption[]>(`/api/chats/${id}/exemptions`),
    /** Revoke one (the header chip's action). 404 when it's already gone. */
    revokeExemption: (id: string, exemptionId: string) =>
      del<void>(`/api/chats/${id}/exemptions/${exemptionId}`),
    /** Cancel the auto-resume scheduled after a usage limit (409 if none). */
    cancelResume: (id: string) => post<Chat>(`/api/chats/${id}/resume/cancel`),
    /** Live context-window breakdown (null when the subprocess isn't live). */
    contextUsage: (id: string) =>
      get<{ usage: ContextUsage | null }>(`/api/chats/${id}/context-usage`),
    /** Upload a pasted/dropped image; returns an ImageRef usable in send-message. */
    uploadAsset: (id: string, body: UploadAssetBody) =>
      post<ImageRef>(`/api/chats/${id}/assets`, body),
  },

  /* agents + modes */
  agents: {
    list: () => get<AgentConfig[]>("/api/agents"),
    create: (body: Partial<AgentConfigInput>) => post<AgentConfig>("/api/agents", body),
    update: (id: string, body: Partial<AgentConfigInput>) =>
      put<AgentConfig>(`/api/agents/${id}`, body),
    remove: (id: string) => del<void>(`/api/agents/${id}`),
  },
  modes: {
    list: () => get<ModeConfig[]>("/api/modes"),
    create: (body: Partial<ModeConfig>) => post<ModeConfig>("/api/modes", body),
    update: (id: string, body: Partial<ModeConfig>) =>
      put<ModeConfig>(`/api/modes/${id}`, body),
    remove: (id: string) => del<void>(`/api/modes/${id}`),
  },

  /* available session models (live from the Claude Code runtime, or static fallback) */
  models: {
    list: (harness: HarnessKind = "claude") =>
      get<ModelOption[]>(`/api/models?harness=${encodeURIComponent(harness)}`),
  },
  harnesses: {
    list: () => get<HarnessInfo[]>("/api/harnesses"),
  },

  /* self-contained `.dispatch/` project config */
  projectConfig: {
    /** The loaded config + errors (cached load, or a fresh one). */
    get: (projectId: string) =>
      get<ProjectConfigResult>(`/api/projects/${projectId}/config`),
    /** Re-read `.dispatch/` from disk (sync store + broadcast). */
    reload: (projectId: string) =>
      post<ProjectConfigResult>(`/api/projects/${projectId}/config/reload`),
    /**
     * Save the workflow block. The server routes it to `project.yaml` when the
     * repo has one (else the `.data` record) and reports which, so the UI can
     * say where the change landed instead of guessing.
     */
    saveWorkflow: (projectId: string, workflow: WorkflowConfig) =>
      put<{ target: "manifest" | "store"; project: Project; manifestPath?: string }>(
        `/api/projects/${projectId}/config/workflow`,
        workflow,
      ),
    saveShellFilter: (projectId: string, shellFilter: ShellTranscriptFilter | undefined) =>
      put<{ target: "manifest" | "store"; project: Project; manifestPath?: string }>(
        `/api/projects/${projectId}/config/shell-filter`,
        { shellFilter: shellFilter ?? null },
      ),
    /** Derive a `.dispatch/` from the project's `.data` record. */
    scaffold: (projectId: string, force?: boolean) =>
      post<{ created: boolean; sourceDir: string; files: string[]; result: ProjectConfigResult }>(
        `/api/projects/${projectId}/config/scaffold`,
        { force },
      ),
    /** Delete one config file/dir (path relative to the config dir), then reload. */
    deleteItem: (projectId: string, rel: string) =>
      del<ProjectConfigResult>(
        `/api/projects/${projectId}/config/item?rel=${encodeURIComponent(rel)}`,
      ),
    /** A GET URL that downloads the project's `.dispatch` archive. */
    exportUrl: (projectId: string) => `${BASE}/api/projects/${projectId}/config/export`,
    /** Import an archive (base64) into the repo, then reload. */
    import: (projectId: string, data: string) =>
      post<{ sourceDir: string; files: string[]; result: ProjectConfigResult }>(
        `/api/projects/${projectId}/config/import`,
        { data },
      ),
  },

  /* agent tasks — "describe it, an agent does it" (config authoring, commit sweep) */
  tasks: {
    /**
     * Launch a task: spawns a chat, sends it the composed briefing, and returns
     * it (with the prompt's authorship breakdown) so the caller can focus it.
     * One call for every task — the id selects the server-side briefing.
     */
    launch: (projectId: string, input: LaunchAgentTaskInput) =>
      post<{ chat: Chat; prompt: string; parts: MessagePart[] }>(
        `/api/projects/${projectId}/tasks`,
        input,
      ),
  },

  /* per-project agent memory (durable, cross-chat facts) */
  memory: {
    list: (projectId: string) =>
      get<ProjectMemory[]>(`/api/projects/${projectId}/memory`),
    get: (projectId: string, name: string) =>
      get<ProjectMemory>(
        `/api/projects/${projectId}/memory/${encodeURIComponent(name)}`,
      ),
    create: (
      projectId: string,
      body: { name: string; description: string; type: MemoryType; body: string },
    ) => post<ProjectMemory>(`/api/projects/${projectId}/memory`, body),
    update: (
      projectId: string,
      name: string,
      body: { description: string; type: MemoryType; body: string },
    ) =>
      put<ProjectMemory>(
        `/api/projects/${projectId}/memory/${encodeURIComponent(name)}`,
        body,
      ),
    remove: (projectId: string, name: string) =>
      del<void>(`/api/projects/${projectId}/memory/${encodeURIComponent(name)}`),
  },

  /* MCP catalog — every tool endpoint (custom manager + external) per project */
  mcp: {
    catalog: (projectId: string, opts?: { fresh?: boolean }) =>
      get<McpCatalog>(`/api/projects/${projectId}/mcp${qs({ fresh: opts?.fresh ? 1 : undefined })}`),
    /**
     * Pin one server on/off at a scope, or `null` to clear the pin and inherit.
     * Returns the rebuilt catalog, so the switch settles on what the server
     * actually resolved rather than on what the click optimistically assumed.
     */
    setEnabled: (
      projectId: string,
      name: string,
      scope: McpEnablementScope,
      enabled: boolean | null,
    ) =>
      put<McpCatalog>(`/api/projects/${projectId}/mcp/${encodeURIComponent(name)}/enabled`, {
        scope,
        enabled,
      }),
  },

  /* attention queue snapshot */
  attention: {
    list: (chatId?: string) =>
      get<AttentionItem[]>(`/api/attention${qs({ chatId })}`),
    /** Open permission/question requests to re-materialize inline cards on (re)connect. */
    pendingPermissions: () =>
      get<PermissionRequest[]>("/api/attention/permissions"),
  },

  /* web push — server-sent notifications (the only path an iOS app has) */
  push: {
    /** The VAPID public key `pushManager.subscribe` needs. */
    key: () => get<{ publicKey: string }>("/api/push/key"),
    devices: () =>
      get<Array<{ id: string; label?: string; createdAt: number; updatedAt: number }>>(
        "/api/push/devices",
      ),
    subscribe: (body: { subscription: unknown; prefs?: NotificationPrefs; label?: string }) =>
      post<{ id: string; prefs: NotificationPrefs }>("/api/push/subscribe", body),
    /**
     * Retune one device's filters. Server-side because iOS revokes a
     * subscription whose push handler declines to show anything — a muted event
     * has to be one that is never sent. See lib/webPush.ts.
     */
    setPrefs: (endpoint: string, prefs: NotificationPrefs) =>
      put<{ ok: true }>("/api/push/prefs", { endpoint, prefs }),
    /** "The app is in front of me" — suppresses pushes to a screen already showing it. */
    presence: (endpoint: string, inFront: boolean) =>
      post<{ ok: true }>("/api/push/presence", { endpoint, inFront }),
    test: (endpoint: string) => post<{ ok: true }>("/api/push/test", { endpoint }),
    unsubscribe: (endpoint: string) =>
      post<{ removed: boolean }>("/api/push/unsubscribe", { endpoint }),
  },

  /* runners */
  runners: {
    list: () => get<RunnerInstance[]>("/api/runners"),
    start: (body: {
      subAppId: string;
      worktreePath?: string;
      branch?: string;
      projectId?: string;
      chatId?: string;
    }) => post<RunnerInstance>("/api/runners", body),
    stop: (id: string) => del<void>(`/api/runners/${id}`),
    logs: (id: string) =>
      get<{ stream: string; line: string; ts: number }[]>(`/api/runners/${id}/logs`),
  },

  /* OS-level process inspector — what's actually holding a project's ports */
  processes: {
    list: (projectId: string) =>
      get<ProjectProcess[]>(`/api/projects/${projectId}/processes`),
    kill: (projectId: string, pids: number[]) =>
      post<KillResult[]>(`/api/projects/${projectId}/processes/kill`, { pids }),
  },

  /* persistent named shells — opened by the agent (mcp__dispatch-workspace__terminal) OR
     by a human from the Terminals panel; both land on the same shells. */
  terminals: {
    /**
     * The catalog. Passing nothing sweeps app-wide; the scope/q filters are the
     * same predicate the server applies to `mcp__dispatch-workspace__terminal_output`'s
     * list, so what the Workspace view shows and what an agent sees agree.
     */
    list: (query: Partial<RegistryQuery> = {}) =>
      get<TerminalInfo[]>(`/api/terminals${qs({ ...query })}`),
    output: (
      id: string,
      opts: { tail?: number; since?: number; q?: string; stream?: string } = {},
    ) =>
      get<{ stream: "command" | "stdout" | "stderr"; chunk: string; ts: number }[]>(
        `/api/terminals/${encodeURIComponent(id)}/output${qs(opts)}`,
      ),
    /** Open an empty shell (cwd = the chat's worktree, else the project checkout). */
    create: (chatId: string, name: string) =>
      post<TerminalInfo>("/api/terminals", { chatId, name }),
    /**
     * Run one command. The promise settles when the command does — which for a
     * build is minutes — so callers drive their spinner off the terminal's own
     * `busy` flag (pushed over the WS the instant the shell starts) rather than
     * off this fetch.
     */
    run: (chatId: string, name: string, command: string, background = false) =>
      post<{
        output: string;
        exitCode: number | null;
        cwd: string;
        error?: string;
        backgrounded?: boolean;
      }>("/api/terminals/run", { chatId, name, command, background }),
    /** Close the shell. Its transcript stays readable until retention takes it. */
    kill: (id: string) => del<{ ok: true }>(`/api/terminals/${encodeURIComponent(id)}`),
    /** Close it AND forget what it printed. */
    purge: (id: string) =>
      del<{ ok: true }>(`/api/terminals/${encodeURIComponent(id)}?purge=1`),
    /**
     * Close every LIVE shell the query selects — the same query the catalog was
     * read with, so this kills exactly the rows on screen. Transcripts survive;
     * this reclaims ports, it doesn't forget output.
     */
    killAll: (query: Partial<RegistryQuery> = {}) =>
      post<{ killed: number; ids: string[] }>("/api/terminals/kill-all", query),
  },

  /* the tracked-PR catalog — the Workspace view's third registry */
  prs: {
    /**
     * The catalog. A pure read of the server's roster: no `gh` call, so it
     * answers immediately. Clients call this ONCE on connect and then follow
     * `pr-record-update` on the socket — which is why the PRs tab renders with
     * no fetch when you open it, unlike the overlay it replaces.
     */
    list: (query: Partial<RegistryQuery> = {}) =>
      get<PrRecord[]>(`/api/prs${qs({ ...query })}`),
    /** Poll one PR now, rather than waiting out its adaptive cadence. */
    refresh: (key: string) => post<PrRecord>("/api/prs/refresh", { key }),
  },

  /* file-path picker (the browser can't see the filesystem; the server can) */
  files: {
    /**
     * Files in the chat's working directory matching `q`, ranked. `root` is that
     * directory, echoed back so a caller can tell repo-relative from absolute.
     */
    search: (chatId: string, q = "", limit?: number) =>
      get<FileSearchResult>(`/api/files${qs({ chatId, q, limit })}`),
    /**
     * The same search rooted at a PROJECT's checkout, for the command palette —
     * which is reachable with no chat open, and is the first thing you touch
     * after switching projects.
     */
    searchProject: (projectId: string, q = "", limit?: number) =>
      get<FileSearchResult>(`/api/files${qs({ projectId, q, limit })}`),
  },

  /* the filesystem itself — listings, stats, drives, and writes */
  fs: {
    /**
     * Where to start. `home`/`projectsRoot`/`sep` are what the new-project form
     * has always read; `platform` and `roots` are what the explorer needs.
     *
     * `platform` is the SERVER's, and the client must use it for every path
     * computation — the browser's own platform is irrelevant to a disk it
     * cannot see, and a Windows browser pointed at a Linux Dispatch would
     * otherwise compute `C:`-shaped breadcrumbs for `/home/me`.
     */
    roots: () =>
      get<{
        home: string;
        projectsRoot: string;
        sep: string;
        platform: FsPlatform;
        roots: FsRoot[];
      }>("/api/fs/roots"),
    /** What's at a path right now: exists / directory / git repo / has code. */
    probe: (path: string) => get<PathProbe>(`/api/fs/probe${qs({ path })}`),
    /** One directory's contents, with the stats every row shows. */
    list: (path: string, limit?: number) =>
      get<FsListing>(`/api/fs/list${qs({ path, limit })}`),
    /** The expensive facts for ONE path — ownership, mode, git authorship. */
    details: (path: string) => get<FsDetails>(`/api/fs/details${qs({ path })}`),
    /**
     * Walk `root` for names matching `q`. Bounded (results, visits, depth and
     * wall-clock) and never follows symlinks — see the service for why each
     * bound exists.
     */
    search: (
      root: string,
      q = "",
      opts: {
        limit?: number;
        select?: FsSelectKind;
        /** Dot-less, e.g. `["png","jpg"]`. */
        ext?: string[];
        showHidden?: boolean;
        includeIgnored?: boolean;
      } = {},
    ) =>
      get<{ root: string; results: FsEntry[] }>(
        `/api/fs/search${qs({
          root,
          q,
          limit: opts.limit,
          select: opts.select,
          ext: opts.ext?.join(","),
          showHidden: opts.showHidden ? "true" : undefined,
          includeIgnored: opts.includeIgnored ? "true" : undefined,
        })}`,
      ),
    /**
     * Every write, behind one call. Resolves even when the mutation failed —
     * the result carries per-path errors, because "two of five files were
     * locked" is information a thrown error would destroy.
     */
    mutate: (m: FsMutation) => post<FsMutationResult>("/api/fs/mutate", m),
  },

  /* worktrees */
  worktrees: {
    /**
     * The catalog. A bare `projectId` keeps its original meaning (that project's
     * trees); a full query widens to the chat or the whole app, through the same
     * predicate the server applies to the `worktree` MCP tool's `list`.
     */
    list: (query: string | Partial<RegistryQuery>) =>
      get<WorktreeInfo[]>(
        `/api/worktrees${qs(typeof query === "string" ? { projectId: query } : { ...query })}`,
      ),
    /** Local branches (recency-sorted) for the launch picker. */
    branches: (projectId: string) =>
      get<BranchInfo[]>(`/api/branches${qs({ projectId })}`),
    create: (body: { projectId: string; branch: string; chatId?: string; base?: string }) =>
      post<WorktreeInfo>("/api/worktrees", body),
    remove: (body: { worktreePath: string; chatId?: string; force?: boolean }) =>
      del<void>("/api/worktrees", body),
    diff: (worktreePath: string, base = "main") =>
      get<ServerWorktreeDiff>(`/api/worktrees/diff${qs({ worktreePath, base })}`),
    /**
     * Read one file (working tree, or at `ref` for the diff editor's base side).
     * `mergeBase` reads it at the fork point with `ref` instead of at its tip —
     * the same history point `diff` uses, so the viewer and the changed-file
     * list can't disagree about what this branch changed.
     */
    file: (worktreePath: string, relPath: string, ref?: string, mergeBase?: boolean) =>
      get<WorktreeFileContent>(
        `/api/worktrees/file${qs({ worktreePath, relPath, ref, mergeBase: mergeBase ? "1" : undefined })}`,
      ),
    /** Save edited working-tree file content (editable Monaco). */
    writeFile: (worktreePath: string, relPath: string, content: string) =>
      put<{ path: string; size: number }>("/api/worktrees/file", {
        worktreePath,
        relPath,
        content,
      }),
    /**
     * What the cleanup panel opens with. TWO calls on purpose, not one.
     *
     * `probe: false` answers every gate but "is the working tree dirty" from
     * batched git and in-memory state — instant, even for ninety trees. The
     * probe pass then enters each surviving tree, which costs ~35s PER TREE on
     * this repo, so it runs behind a progress indicator instead of holding the
     * first paint hostage.
     */
    cleanupPlan: (opts: { projectId?: string; probe?: boolean } = {}) =>
      get<ReapPlan>(
        `/api/worktrees/cleanup${qs({
          projectId: opts.projectId,
          probe: opts.probe ? "1" : undefined,
        })}`,
      ),
    /** Remove the approved trees. Each is re-judged server-side first. */
    cleanup: (paths: string[], deleteBranch: boolean) =>
      post<ReapResult>("/api/worktrees/cleanup", { paths, deleteBranch }),
  },

  /**
   * Working-copy git for the Source Control view. Every call is scoped to ONE
   * repo directory (`repoPath`) — the project checkout or any of its worktrees.
   * Mutations return the FRESH status so the UI never has to guess what a stage
   * or commit did; a couple also return the list they changed (branches/stashes).
   */
  git: {
    status: (repoPath: string) => get<GitStatus>(`/api/git/status${qs({ repoPath })}`),
    branches: (repoPath: string) =>
      get<GitBranch[]>(`/api/git/branches${qs({ repoPath })}`),
    log: (repoPath: string, opts?: { limit?: number; ref?: string }) =>
      get<GitCommit[]>(
        `/api/git/log${qs({ repoPath, limit: opts?.limit, ref: opts?.ref })}`,
      ),
    commitFiles: (repoPath: string, rev: string) =>
      get<GitCommitFile[]>(`/api/git/commit-files${qs({ repoPath, rev })}`),
    stashes: (repoPath: string) => get<GitStash[]>(`/api/git/stashes${qs({ repoPath })}`),
    /** One file at a snapshot: `WORKTREE`, `INDEX`, or any git rev. */
    file: (repoPath: string, relPath: string, rev?: string) =>
      get<WorktreeFileContent>(`/api/git/file${qs({ repoPath, relPath, rev })}`),

    stage: (repoPath: string, paths: string[]) =>
      post<GitStatus>("/api/git/stage", { repoPath, paths }),
    stageAll: (repoPath: string) => post<GitStatus>("/api/git/stage", { repoPath, all: true }),
    unstage: (repoPath: string, paths: string[]) =>
      post<GitStatus>("/api/git/unstage", { repoPath, paths }),
    unstageAll: (repoPath: string) =>
      post<GitStatus>("/api/git/unstage", { repoPath, all: true }),
    /** DESTRUCTIVE — deletes untracked files, reverts tracked ones. Confirm first. */
    discard: (repoPath: string, paths: string[]) =>
      post<GitStatus>("/api/git/discard", { repoPath, paths }),

    commit: (repoPath: string, message: string, opts?: { amend?: boolean }) =>
      post<{ commit: GitCommit; status: GitStatus }>("/api/git/commit", {
        repoPath,
        message,
        amend: opts?.amend,
      }),
    /** One-shot AI draft from the staged diff (throws when nothing is staged). */
    commitMessage: (repoPath: string, hint?: string) =>
      post<{ message: string }>("/api/git/commit-message", { repoPath, hint }),

    checkout: (repoPath: string, branch: string, opts?: { create?: boolean; from?: string }) =>
      post<GitStatus>("/api/git/checkout", {
        repoPath,
        branch,
        create: opts?.create,
        from: opts?.from,
      }),
    deleteBranch: (repoPath: string, branch: string, force?: boolean) =>
      del<GitBranch[]>("/api/git/branch", { repoPath, branch, force }),

    stash: (repoPath: string, opts?: { message?: string; includeUntracked?: boolean }) =>
      post<{ message: string; stashes: GitStash[]; status: GitStatus }>("/api/git/stash", {
        repoPath,
        message: opts?.message,
        includeUntracked: opts?.includeUntracked,
      }),
    stashApply: (repoPath: string, index: number, pop?: boolean) =>
      post<{ message: string; stashes: GitStash[]; status: GitStatus }>(
        "/api/git/stash/apply",
        { repoPath, index, pop },
      ),
    stashDrop: (repoPath: string, index: number) =>
      del<{ message: string; stashes: GitStash[] }>("/api/git/stash", { repoPath, index }),

    sync: (
      repoPath: string,
      op: "fetch" | "pull" | "push",
      opts?: { setUpstream?: boolean; branch?: string },
    ) =>
      post<{ message: string; status: GitStatus }>("/api/git/sync", {
        repoPath,
        op,
        setUpstream: opts?.setUpstream,
        branch: opts?.branch,
      }),
  },

  /* github control plane */
  github: {
    prs: (projectId: string, opts?: { state?: string; base?: string; limit?: number }) =>
      get<PRInfo[]>(
        `/api/github/prs${qs({ projectId, state: opts?.state, base: opts?.base, limit: opts?.limit })}`,
      ),
    /** ALL open PRs for the project — the global (not per-chat) roster. */
    projectPrs: (projectId: string) =>
      get<PRInfo[]>(`/api/github/project-prs${qs({ projectId })}`),
    pr: (projectId: string, number: number) =>
      get<PRInfo>(`/api/github/pr/${number}${qs({ projectId })}`),
    /** Rich single-PR detail: check rollup + review decision + threads + counts. */
    prDetail: (projectId: string, number: number) =>
      get<PRInfo>(`/api/github/pr/${number}/detail${qs({ projectId })}`),
    workflows: (projectId: string) =>
      get<WorkflowDef[]>(`/api/github/workflows${qs({ projectId })}`),
    /** Each workflow paired with its latest run — the default Actions view. */
    workflowsStatus: (projectId: string) =>
      get<WorkflowWithLastRun[]>(`/api/github/workflows/status${qs({ projectId })}`),
    /** The `workflow_dispatch` input schema for a workflow (for the Run form). */
    workflowInputs: (projectId: string, workflow: string) =>
      get<WorkflowInput[]>(`/api/github/workflows/inputs${qs({ projectId, workflow })}`),
    runs: (projectId: string, opts?: { workflow?: string; branch?: string; limit?: number }) =>
      get<WorkflowRun[]>(
        `/api/github/runs${qs({ projectId, workflow: opts?.workflow, branch: opts?.branch, limit: opts?.limit })}`,
      ),
    action: (body: Record<string, unknown>) =>
      post<{ ok: boolean }>("/api/github/action", body),
  },

  /* settings */
  settings: {
    get: () => get<AppSettings>("/api/settings"),
    update: (body: Partial<AppSettings>) => put<AppSettings>("/api/settings", body),
  },

  /**
   * The PR reviewer's machine account (see routes/reviewer.ts).
   *
   * App-wide, not per-project: one account reviews every repo you own, and its
   * token is a secret that must never reach `.dispatch/project.yaml` — which is
   * committed. The token is WRITE-ONLY across this boundary; nothing here ever
   * returns it, so a session that didn't set it can't read it back.
   */
  reviewer: {
    get: () => get<ReviewerStatus>("/api/reviewer"),
    /** Verified before it is stored — a rejected token is a 400, not a saved one. */
    save: (body: { token: string; projectId?: string }) =>
      put<ReviewerStatus & { verify: ReviewerVerify }>("/api/reviewer", body),
    remove: () => del<void>("/api/reviewer"),
    /** Re-check what's stored, or try a candidate token before committing to it. */
    verify: (body: { token?: string; projectId?: string } = {}) =>
      post<ReviewerVerify>("/api/reviewer/verify", body),
  },

  /* stop the whole app (see routes/shutdown.ts) */
  shutdown: () => post<{ ok: boolean; error?: string }>("/api/shutdown"),

  /* in-app release updates (see routes/update.ts) */
  update: {
    get: () => get<UpdateStatus>("/api/update"),
    /** Force a fresh GitHub check now (the "Check now" link). */
    check: () => post<UpdateStatus>("/api/update/check"),
    /** Subscribe to a channel. Answers with the new channel's head already resolved. */
    setChannel: (channel: UpdateChannel) =>
      put<UpdateStatus>("/api/update/channel", { channel }),
    /**
     * Launch the installer. The server goes down moments after this answers.
     * `tag` names the channel head explicitly, which is the only way to ask for
     * a step-back — the server refuses any tag that is not that head.
     */
    install: (tag?: string) =>
      post<{ ok: boolean; tag?: string; error?: string }>(
        "/api/update/install",
        tag ? { tag } : undefined,
      ),
  },

  /* subscription usage (5h + weekly) for the header meter */
  usage: {
    get: (harness: HarnessKind = "claude") =>
      get<UsageSnapshot>(`/api/usage?harness=${encodeURIComponent(harness)}`),
    /** Force a fresh fetch now (the "refresh" button). */
    refresh: (harness: HarnessKind = "claude") =>
      post<UsageSnapshot>(`/api/usage/refresh?harness=${encodeURIComponent(harness)}`),
  },

  /* the usage ledger behind the Metrics view.
   *
   * POST for reads, matching the server: the query carries a filter map
   * (dimension → allowed values), which has no honest query-string form and
   * would hit the URL length limit the first time someone selects thirty tools.
   */
  metrics: {
    series: (query: MetricQueryInput) => post<MetricSeriesResponse>("/api/metrics/series", query),
    totals: (query: MetricQueryInput & { groupBy: MetricDimension }) =>
      post<MetricTotalsResponse>("/api/metrics/totals", query),
    facets: (scope: { from?: number; to?: number; filter?: MetricFilter }) =>
      post<MetricFacetsResponse>("/api/metrics/facets", scope),
    recent: (scope: { from?: number; to?: number; filter?: MetricFilter; limit?: number }) =>
      post<MetricEvent[]>("/api/metrics/recent", scope),
    stats: () => get<{ rows: number; buffered: number; dropped: number }>("/api/metrics/stats"),
    /** Total runtime per chat, all time — one small object for every chat. */
    chatRuntime: () => get<ChatRuntimeResponse>("/api/metrics/chat-runtime"),
    prune: (before: number) => post<{ deleted: number }>("/api/metrics/prune", { before }),

    /* The RUNTIME half — the same window, answered in milliseconds.
     *
     * Its own paths rather than a `measure` flag on the five above: a span has
     * a `state` where an event has a `category`, so one endpoint would have to
     * accept a filter it might reject and return a union the caller narrows
     * anyway. `summary` has no counterpart at all — it is the hero row, and
     * there is no honest single-number equivalent for a count ledger. */
    spans: {
      series: (query: MetricSpanQueryInput) =>
        post<MetricSpanSeriesResponse>("/api/metrics/spans/series", query),
      totals: (query: MetricSpanQueryInput & { groupBy: MetricSpanDimension }) =>
        post<MetricSpanTotalsResponse>("/api/metrics/spans/totals", query),
      summary: (scope: { from?: number; to?: number; filter?: MetricSpanFilter }) =>
        post<MetricSpanSummary>("/api/metrics/spans/summary", scope),
      facets: (scope: { from?: number; to?: number; filter?: MetricSpanFilter }) =>
        post<MetricSpanFacetsResponse>("/api/metrics/spans/facets", scope),
      recent: (scope: {
        from?: number;
        to?: number;
        filter?: MetricSpanFilter;
        limit?: number;
      }) => post<MetricSpan[]>("/api/metrics/spans/recent", scope),
    },
  },
};

export type Api = typeof api;
