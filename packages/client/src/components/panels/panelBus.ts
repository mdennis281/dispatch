/**
 * Decoupling seam between the right-panel (this feature area) and the Monaco
 * viewer/diff area — so panels never import the Monaco module. Clicking a changed
 * file fires a typed `cm:open-file` window event; `monaco/CodeViewerHost` listens,
 * enriches it with the worktree branch, and opens the viewer. Plus a few pure
 * utilities shared across the three panels.
 */
import type { Chat, WorktreeInfo } from "@dispatch/shared";
import { focusPanelTab } from "../../stores/layout.js";

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

/**
 * Ask the shell to switch to a given right-panel tab (Worktrees / Apps / PRs).
 *
 * This used to be a `cm:focus-panel` window CustomEvent that `RightPanel`
 * listened for, because the selected tab was a `useState` inside that component
 * and nothing outside it could reach one. The tab now lives in `stores/layout`
 * — the mobile bottom nav renders in `App.tsx`, outside the `<aside>`, and had
 * to be able to select a tab too — so the event, its listener and the whole
 * seam collapse into a store call. Callers (the command palette) are unchanged.
 *
 * The import is deliberately one-way at runtime: the store imports only the
 * `FocusPanelTab` TYPE from this module, which erases at build time.
 */
export function requestFocusPanel(tab: FocusPanelTab): void {
  focusPanelTab(tab);
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
