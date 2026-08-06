/**
 * Monaco code preview + diff — public surface.
 *
 * Open the viewer from anywhere with `openCodeViewer({ worktreePath, relPath,
 * mode, base })`, or use the ready-made helpers that resolve a chat's worktree:
 * `openToolFile(use, chat, worktrees)` (from a chat tool card) and
 * `openWorktreeFile(...)` (from the Worktrees file list). Mount `<CodeViewerHost/>`
 * once at the app root.
 */
import type { Chat, ToolUseRow, WorktreeInfo } from "@dispatch/shared";
import {
  openCodeViewer,
  resolveChatFile,
  toolFilePath,
  toolFileMode,
  type CodeViewerMode,
} from "./store.js";

export { CodeViewerHost } from "./CodeViewerHost.js";
export {
  useCodeViewer,
  openCodeViewer,
  resolveChatFile,
  resolveRepoFile,
  toolFilePath,
  toolFileMode,
  type CodeViewerMode,
  type CodeViewerRequest,
  type CodeSelection,
  type WorktreeTarget,
} from "./store.js";

/**
 * The file a chat tool card would open, or null if it touches no readable file
 * / the chat has no worktree. Use this to gate the "Open" affordance (disable,
 * don't error) and to open it on click.
 */
export function toolFileTarget(
  use: ToolUseRow,
  chat: Chat | undefined,
  worktrees: WorktreeInfo[],
): { mode: CodeViewerMode; worktreePath: string; relPath: string; branch?: string; base: string } | null {
  const mode = toolFileMode(use);
  const path = toolFilePath(use);
  if (!mode || !path) return null;
  const target = resolveChatFile(chat, worktrees, path);
  if (!target) return null;
  return { mode, ...target };
}

/** Open the file a chat tool card touched (diff for edits, plain view for reads). */
export function openToolFile(
  use: ToolUseRow,
  chat: Chat | undefined,
  worktrees: WorktreeInfo[],
): boolean {
  const t = toolFileTarget(use, chat, worktrees);
  if (!t) return false;
  openCodeViewer(t);
  return true;
}

/** Open a specific worktree file (from the Worktrees file list). */
export function openWorktreeFile(input: {
  worktreePath: string;
  relPath: string;
  mode?: CodeViewerMode;
  base?: string;
  branch?: string;
}): void {
  openCodeViewer({
    worktreePath: input.worktreePath,
    relPath: input.relPath,
    mode: input.mode ?? "diff",
    base: input.base ?? "main",
    branch: input.branch,
  });
}
