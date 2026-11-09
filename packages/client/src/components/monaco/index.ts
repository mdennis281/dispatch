/**
 * Monaco code preview + diff — public surface.
 *
 * Open the viewer from anywhere with `openCodeViewer({ worktreePath, relPath,
 * mode, base })`; `toolFileTarget(use, chat, worktrees)` resolves what a chat
 * tool card would open. Mount `<CodeViewerHost/>` once at the app root.
 */
import type { Chat, ToolUseRow, WorktreeInfo } from "@dispatch/shared";
import {
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
