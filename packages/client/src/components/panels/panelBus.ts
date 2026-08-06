/**
 * Decoupling seam between the right-panel (this feature area) and the Monaco
 * viewer/diff area — so panels never import the Monaco module. Clicking a changed
 * file fires a typed `cm:open-file` window event; `monaco/CodeViewerHost` listens,
 * enriches it with the worktree branch, and opens the viewer. Plus a few pure
 * utilities shared across the three panels.
 */
import type { Chat, WorktreeInfo } from "@dispatch/shared";

/** Detail of the `cm:open-file` event the Monaco area consumes. */
export interface OpenFileRequest {
  worktreePath: string;
  relPath: string;
  /** Base ref for the diff's left side (defaults to the worktree's base / "main"). */
  base?: string;
}

export const OPEN_FILE_EVENT = "cm:open-file";

/** Ask the Monaco surface to open one worktree file (diff base@`base` vs working). */
export function requestOpenFile(req: OpenFileRequest): void {
  window.dispatchEvent(new CustomEvent<OpenFileRequest>(OPEN_FILE_EVENT, { detail: req }));
}

/** The right-panel tabs the command palette can jump to. (Memory is now a
 *  top-level, chat-independent view — see stores/view.ts — not a panel tab.) */
export type FocusPanelTab = "worktrees" | "agents" | "apps" | "terminals" | "prs";

export const FOCUS_PANEL_EVENT = "cm:focus-panel";

/**
 * Ask the RightPanel to switch to a given tab (Worktrees / Apps / PRs). Same
 * decoupled window-event seam as `requestOpenFile` — the command palette fires
 * it, `RightPanel` listens, so neither imports the other.
 */
export function requestFocusPanel(tab: FocusPanelTab): void {
  window.dispatchEvent(new CustomEvent<FocusPanelTab>(FOCUS_PANEL_EVENT, { detail: tab }));
}

/** True when a worktree belongs to a chat (by owned path or explicit chatId tag). */
export function worktreeMatchesChat(wt: WorktreeInfo, chat: Chat): boolean {
  return wt.chatId === chat.id || chat.worktrees.some((p) => samePath(p, wt.path));
}

/** Loose path equality (normalize slashes + drop a trailing separator). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** Best-effort copy to the OS clipboard (localhost is a secure context). */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Suggest a conventional branch name from a chat title (feat/<slug>). */
export function suggestBranch(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `feat/${slug || "new-task"}`;
}
