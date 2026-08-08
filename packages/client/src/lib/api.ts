/**
 * Typed REST client for the @dispatch/server API (everything under /api). Thin
 * wrappers over fetch that speak the @dispatch/shared domain types. The shell feeds
 * stores from mock data today; 2b swaps these in for the live backend without
 * changing call sites.
 */
import type {
  Project,
  Chat,
  ChatMessage,
  AgentConfig,
  AgentConfigInput,
  ModeConfig,
  AttentionItem,
  PermissionRequest,
  RunnerInstance,
  TerminalInfo,
  WorktreeInfo,
  BranchInfo,
  PRInfo,
  WorkflowDef,
  WorkflowRun,
  WorkflowWithLastRun,
  WorkflowInput,
  ImageRef,
  Checkpoint,
  ProjectMemory,
  MemoryType,
  McpCatalog,
  GitStatus,
  GitBranch,
  GitCommit,
  GitCommitFile,
  GitStash,
  ProjectConfigResult,
  UsageSnapshot,
  ContextUsage,
  ModelOption,
  WorkflowConfig,
  LaunchAgentTaskInput,
  MessagePart,
} from "@dispatch/shared";

/**
 * Global app settings — mirrors the server `AppSettingsSchema`
 * (packages/server/src/store/index.ts). The client never imports the server
 * package, so the shape is declared here and the server Zod schema validates it
 * on write.
 */
export interface AppSettings {
  theme: "dark" | "light";
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
}

/** An OS process LISTENING on a project's port (mirrors server ProjectProcess). */
export interface ProjectProcess {
  port: number;
  pid: number;
  name?: string;
  /** True when this port belongs to an active Dispatch runner. */
  tracked: boolean;
  runnerId?: string;
  subAppId?: string;
  branch?: string;
  worktreePath?: string;
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
 * Resolve an ImageRef to a URL the browser can render. `data:`/`http(s)`/`blob:`
 * pass through; a stored relative asset path maps to its serve endpoint.
 */
export function assetUrl(chatId: string, image: { path: string }): string {
  const p = image.path;
  if (/^(https?:|data:|blob:)/i.test(p)) return p;
  const name = p.split(/[\\/]/).pop() ?? p;
  return `${BASE}/api/chats/${chatId}/assets/${encodeURIComponent(name)}`;
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
  const res = await fetch(`${BASE}${path}`, {
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

function qs(params: Record<string, string | number | undefined>): string {
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
    update: (id: string, body: Partial<Chat>) =>
      put<Chat>(`/api/chats/${id}`, body),
    remove: (id: string) => del<void>(`/api/chats/${id}`),
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
    list: () => get<ModelOption[]>("/api/models"),
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
  },

  /* attention queue snapshot */
  attention: {
    list: (chatId?: string) =>
      get<AttentionItem[]>(`/api/attention${qs({ chatId })}`),
    /** Open permission/question requests to re-materialize inline cards on (re)connect. */
    pendingPermissions: () =>
      get<PermissionRequest[]>("/api/attention/permissions"),
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

  /* persistent named shells — opened by the agent (mcp__manager__terminal) OR
     by a human from the Terminals panel; both land on the same shells. */
  terminals: {
    list: (chatId?: string) =>
      get<TerminalInfo[]>(`/api/terminals${qs({ chatId })}`),
    output: (id: string) =>
      get<{ stream: "command" | "stdout" | "stderr"; chunk: string; ts: number }[]>(
        `/api/terminals/${encodeURIComponent(id)}/output`,
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
    run: (chatId: string, name: string, command: string) =>
      post<{ output: string; exitCode: number | null; cwd: string; error?: string }>(
        "/api/terminals/run",
        { chatId, name, command },
      ),
    kill: (id: string) => del<{ ok: true }>(`/api/terminals/${encodeURIComponent(id)}`),
  },

  /* file-path picker (the browser can't see the filesystem; the server can) */
  files: {
    /**
     * Files in the chat's working directory matching `q`, ranked. `root` is that
     * directory, echoed back so a caller can tell repo-relative from absolute.
     */
    search: (chatId: string, q = "", limit?: number) =>
      get<FileSearchResult>(`/api/files${qs({ chatId, q, limit })}`),
  },

  /* filesystem questions the new-project form has to ask before it can act */
  fs: {
    /** Where this human keeps projects (learned from the ones they already have). */
    roots: () => get<{ home: string; projectsRoot: string; sep: string }>("/api/fs/roots"),
    /** What's at a path right now: exists / directory / git repo / has code. */
    probe: (path: string) => get<PathProbe>(`/api/fs/probe${qs({ path })}`),
  },

  /* worktrees */
  worktrees: {
    list: (projectId: string) =>
      get<WorktreeInfo[]>(`/api/worktrees${qs({ projectId })}`),
    /** Local branches (recency-sorted) for the launch picker. */
    branches: (projectId: string) =>
      get<BranchInfo[]>(`/api/branches${qs({ projectId })}`),
    create: (body: { projectId: string; branch: string; chatId?: string; base?: string }) =>
      post<WorktreeInfo>("/api/worktrees", body),
    remove: (body: { worktreePath: string; chatId?: string; force?: boolean }) =>
      del<void>("/api/worktrees", body),
    diff: (worktreePath: string, base = "main") =>
      get<ServerWorktreeDiff>(`/api/worktrees/diff${qs({ worktreePath, base })}`),
    /** Read one file (working tree, or at `ref` for the diff editor's base side). */
    file: (worktreePath: string, relPath: string, ref?: string) =>
      get<WorktreeFileContent>(
        `/api/worktrees/file${qs({ worktreePath, relPath, ref })}`,
      ),
    /** Save edited working-tree file content (editable Monaco). */
    writeFile: (worktreePath: string, relPath: string, content: string) =>
      put<{ path: string; size: number }>("/api/worktrees/file", {
        worktreePath,
        relPath,
        content,
      }),
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

  /* stop the whole app (see routes/shutdown.ts) */
  shutdown: () => post<{ ok: boolean; error?: string }>("/api/shutdown"),

  /* subscription usage (5h + weekly) for the header meter */
  usage: {
    get: () => get<UsageSnapshot>("/api/usage"),
    /** Force a fresh fetch now (the "refresh" button). */
    refresh: () => post<UsageSnapshot>("/api/usage/refresh"),
  },
};

export type Api = typeof api;
