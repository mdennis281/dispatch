/**
 * Global "code viewer" store — the single open Monaco preview/diff overlay.
 *
 * Any surface (a chat tool card, the Worktrees file list) opens the viewer by
 * calling `openCodeViewer(request)`; a single `<CodeViewerHost/>` at the app
 * root renders it. The heavy Monaco bundle is only pulled once a request is set,
 * so nothing here imports `monaco-editor`.
 */
import { create } from "zustand";
import type { Chat, ToolUseRow, WorktreeInfo } from "@dispatch/shared";

export type CodeViewerMode = "file" | "diff";

/** A 1-based inclusive line range to reveal + highlight when the viewer opens. */
export interface CodeSelection {
  /** 1-based first line. */
  startLine: number;
  /** 1-based last line (inclusive); equals startLine for a single line. */
  endLine: number;
}

export interface CodeViewerRequest {
  /** Absolute worktree root the file lives under (server reads relative to it). */
  worktreePath: string;
  /** Path relative to the worktree root (forward slashes). */
  relPath: string;
  /** Initial mode; "diff" gracefully falls back to "file" for the base side. */
  mode: CodeViewerMode;
  /** Base ref for the diff's left side (default "main"). */
  base: string;
  /** Branch label for the header chip (best-effort). */
  branch?: string;
  /** Optional line range to scroll to + highlight (from a clickable code pointer). */
  selection?: CodeSelection;
  /**
   * When true the file opens editable with a Save action (writes back to the
   * working tree). Forces "file" mode — there is no editable diff. Used by the
   * "Edit definitions" flow to author `.dispatch/project.yaml` in place.
   */
  editable?: boolean;
}

interface CodeViewerState {
  request: CodeViewerRequest | null;
  open: (r: CodeViewerRequest) => void;
  close: () => void;
}

export const useCodeViewer = create<CodeViewerState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

/** Imperative open (for click handlers outside React render). */
export function openCodeViewer(request: CodeViewerRequest): void {
  useCodeViewer.getState().open(request);
}

/* ------------------------------------------------------- path resolution */

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** True when `file` sits inside worktree root `root` (case-insensitive on Win). */
function isInside(root: string, file: string): boolean {
  const r = norm(root).toLowerCase();
  const f = norm(file).toLowerCase();
  return f === r || f.startsWith(r + "/");
}

function relativeTo(root: string, file: string): string {
  const r = norm(root);
  const f = norm(file);
  const rel = f.slice(r.length).replace(/^\/+/, "");
  return rel || f;
}

export interface WorktreeTarget {
  worktreePath: string;
  relPath: string;
  branch?: string;
  base: string;
}

/**
 * Resolve a file path (absolute or worktree-relative) against a chat's
 * worktrees. Returns null when the chat has no worktree to read from.
 */
export function resolveChatFile(
  chat: Chat | undefined,
  worktrees: WorktreeInfo[],
  filePath: string,
): WorktreeTarget | null {
  const infoByPath = new Map(worktrees.map((w) => [norm(w.path), w]));
  // A worktree belongs to the chat if the chat lists its path OR it's tagged to
  // the chat's id (mirrors the panels' worktreeMatchesChat).
  const owned = new Set<string>(chat?.worktrees ?? []);
  if (chat) for (const w of worktrees) if (w.chatId === chat.id) owned.add(w.path);
  const paths = [...owned];
  const abs = /^([a-zA-Z]:[\\/]|[\\/])/.test(filePath);

  if (abs) {
    // Prefer the deepest worktree that contains the absolute file.
    const containing = paths
      .filter((wt) => isInside(wt, filePath))
      .sort((a, b) => b.length - a.length)[0];
    if (containing) {
      const info = infoByPath.get(norm(containing));
      return {
        worktreePath: containing,
        relPath: relativeTo(containing, filePath),
        branch: info?.branch,
        base: info?.base ?? "main",
      };
    }
    return null;
  }

  // Relative path → hang it off the chat's primary worktree.
  const wt = paths[0];
  if (!wt) return null;
  const info = infoByPath.get(norm(wt));
  return {
    worktreePath: wt,
    relPath: norm(filePath),
    branch: info?.branch,
    base: info?.base ?? "main",
  };
}

/**
 * Resolve a file path against a project's repo root — the fallback for a chat
 * with no worktree (or a path that lives outside every worktree). Absolute paths
 * must sit inside `repoPath`; relative paths hang off it. Returns null when the
 * repo root is unknown or an absolute path escapes it.
 */
export function resolveRepoFile(
  repoPath: string | undefined,
  defaultBranch: string | undefined,
  filePath: string,
): WorktreeTarget | null {
  if (!repoPath) return null;
  const abs = /^([a-zA-Z]:[\\/]|[\\/])/.test(filePath);
  const base = defaultBranch || "main";
  if (abs) {
    if (!isInside(repoPath, filePath)) return null;
    return { worktreePath: repoPath, relPath: relativeTo(repoPath, filePath), base };
  }
  const rel = norm(filePath);
  if (!rel) return null;
  return { worktreePath: repoPath, relPath: rel, base };
}

/** File-touching tools whose input carries a path we can open in Monaco. */
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Update"]);
const READ_TOOLS = new Set(["Read", "NotebookRead"]);

/** Pull the file path out of a tool_use input, if it has one. */
export function toolFilePath(use: ToolUseRow): string | null {
  const input = use.input as Record<string, unknown>;
  const candidate =
    input.file_path ?? input.filePath ?? input.notebook_path ?? input.path;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

/** Whether a tool touches a file, and the default mode to open it in. */
export function toolFileMode(use: ToolUseRow): CodeViewerMode | null {
  if (EDIT_TOOLS.has(use.name)) return "diff";
  if (READ_TOOLS.has(use.name)) return "file";
  // A path on any other tool → plain file view.
  return toolFilePath(use) ? "file" : null;
}
