/**
 * Project ↔ chat selection, kept in step.
 *
 * The invariant this module exists to hold: **the open chat always belongs to
 * the focused project.** Selection used to be two independent `set()` calls in
 * two stores, and every caller had to remember to do both. Most didn't — so
 * clicking an Attention item for another project's chat rendered that chat
 * beside the WRONG project's sidebar, panels and Source Control, and switching
 * projects left the previous project's transcript sitting in the main area with
 * nothing highlighted in the rail beside it.
 *
 * Route selection through these three functions instead of poking
 * `setActiveProject` / `setActiveChat` directly:
 *   - {@link selectProject} — switch focus; the open chat goes with it.
 *   - {@link selectChat}    — open a chat, bringing its project along.
 *   - {@link reconcileActiveChat} — re-establish the invariant after a hydrate.
 *
 * These live outside the stores because the rule spans two of them, and neither
 * store should have to import the other.
 */
import type { Chat } from "@dispatch/shared";
import { useChats, chatsForProject } from "./chats.js";
import { useProjects } from "./projects.js";
import { useView } from "./view.js";

/**
 * Focus a project. Switching AWAY closes the open chat: it belongs to the
 * project you just left, so the main area falls back to the empty state and the
 * user picks from the (now correct) sidebar. Re-selecting the project already in
 * focus is a no-op — `ManageConfigDialog` re-sets it to force a config reload,
 * and that must not throw away what you were reading.
 */
export function selectProject(projectId: string): void {
  const projects = useProjects.getState();
  if (projects.activeProjectId === projectId) return;
  projects.setActiveProject(projectId);
  useChats.getState().setActiveChat(null);
}

/**
 * Open a chat, switching to its project first when it lives in another one —
 * the Attention Queue, the command palette and desktop-notification clicks are
 * all cross-project entry points.
 *
 * Also snaps back to the chat surface: opening a chat while the Memory or
 * Source Control view fills the main area otherwise looks like nothing happened.
 *
 * A chat the store hasn't seen yet is still selected. The `#chat=` deep link
 * fires on a timer that can beat hydrate, and the id becoming real a moment
 * later is the normal case; until then the main area shows the empty state.
 */
export function selectChat(chatId: string): void {
  const chat = useChats.getState().byId[chatId];
  if (chat) {
    const projects = useProjects.getState();
    if (chat.projectId !== projects.activeProjectId) projects.setActiveProject(chat.projectId);
  }
  useChats.getState().setActiveChat(chatId);
  useView.getState().setView("chat");
}

/**
 * The chat the main area may actually render: the open one, but ONLY while it
 * belongs to the focused project.
 *
 * The functions above keep the two selections in step; this is what makes the
 * rule structural rather than a convention every future caller has to remember.
 * Everything beside the transcript — sidebar, right panel, Source Control — is
 * scoped to the active project, so a foreign chat here is a mixed-scope window.
 * An id the store hasn't seen (a deep link that beat hydrate) is likewise not
 * renderable yet.
 */
export function visibleChat(
  s: { activeChatId: string | null; byId: Record<string, Chat> },
  activeProjectId: string | null,
): Chat | undefined {
  const chat = s.activeChatId ? s.byId[s.activeChatId] : undefined;
  return chat && chat.projectId === activeProjectId ? chat : undefined;
}

/**
 * Re-establish the invariant after a hydrate, which sets the two selections from
 * two independent lists (`projects[0]` and the globally-most-recent chat) and so
 * can land them in different projects.
 *
 * Unlike a project switch this prefers to KEEP a selection — a boot that opens
 * on the empty state when the project has chats is a worse landing than the
 * most recent one, which is what the un-scoped hydrate was reaching for anyway.
 */
export function reconcileActiveChat(): void {
  const chats = useChats.getState();
  const activeProjectId = useProjects.getState().activeProjectId;
  if (!activeProjectId) {
    // No project in focus (none exist yet) — nothing is legitimately open.
    if (chats.activeChatId !== null) chats.setActiveChat(null);
    return;
  }
  const active = chats.activeChatId ? chats.byId[chats.activeChatId] : undefined;
  if (active && active.projectId === activeProjectId) return;
  chats.setActiveChat(chatsForProject(chats, activeProjectId)[0]?.id ?? null);
}
