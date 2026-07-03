/**
 * Typed REST client for the @cm/server API (everything under /api). Thin
 * wrappers over fetch that speak the @cm/shared domain types. The shell feeds
 * stores from mock data today; 2b swaps these in for the live backend without
 * changing call sites.
 */
import type {
  Project,
  Chat,
  ChatMessage,
  AgentConfig,
  ModeConfig,
  AttentionItem,
  PermissionRequest,
  RunnerInstance,
  WorktreeInfo,
  PRInfo,
  WorkflowDef,
  WorkflowRun,
  WorkflowWithLastRun,
  WorkflowInput,
  ImageRef,
  Checkpoint,
} from "@cm/shared";

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
    create: (body: Partial<Project>) => post<Project>("/api/projects", body),
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
    messages: (id: string, opts?: { limit?: number; afterId?: string }) =>
      get<ChatMessage[]>(
        `/api/chats/${id}/messages${qs({ limit: opts?.limit, afterId: opts?.afterId })}`,
      ),
    checkpoints: (id: string) => get<Checkpoint[]>(`/api/chats/${id}/checkpoints`),
    /** Upload a pasted/dropped image; returns an ImageRef usable in send-message. */
    uploadAsset: (id: string, body: UploadAssetBody) =>
      post<ImageRef>(`/api/chats/${id}/assets`, body),
  },

  /* agents + modes */
  agents: {
    list: () => get<AgentConfig[]>("/api/agents"),
    create: (body: Partial<AgentConfig>) => post<AgentConfig>("/api/agents", body),
    update: (id: string, body: Partial<AgentConfig>) =>
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
    start: (body: { worktreePath: string; subAppId: string; projectId?: string; chatId?: string }) =>
      post<RunnerInstance>("/api/runners", body),
    stop: (id: string) => del<void>(`/api/runners/${id}`),
    logs: (id: string) =>
      get<{ stream: string; line: string; ts: number }[]>(`/api/runners/${id}/logs`),
  },

  /* worktrees */
  worktrees: {
    list: (projectId: string) =>
      get<WorktreeInfo[]>(`/api/worktrees${qs({ projectId })}`),
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
};

export type Api = typeof api;
