import { create } from "zustand";

/** The app's primary surface. "chat" = the transcript workspace; "memory" = the
 *  top-level, chat-independent memory browser (list+search + viewer); "git" =
 *  the project's Source Control cockpit (changes, history, branches, stashes);
 *  "new-project" = the full-bleed project setup page.
 *
 *  "new-project" is the one view that also hides the SIDEBAR. It isn't scoped to
 *  the active project — it's how a project comes to exist — so a rail of the
 *  current project's chats and apps beside it is noise at best and a misread at
 *  worst ("am I editing that one?"). Everything else keeps its chrome. */
export type AppView = "chat" | "memory" | "git" | "new-project";

/**
 * The app's modal surfaces — project-scoped things that sit ON TOP of a view
 * rather than replacing it.
 *
 * These used to be opened three different ways: `prs`/`mcp`/`config` each had
 * their own `*Bus.ts` module firing a bespoke window CustomEvent that the
 * always-mounted overlay listened for, while `settings` and `agents` were plain
 * `useState` in whichever component happened to render the trigger. Same class
 * of thing, three mechanisms — so nothing could tell what was open, only one
 * could be addressed by the command palette without special-casing, and closing
 * behaviour was whatever each site remembered to wire.
 *
 * One field, one setter. Opening any overlay closes the previous one, which is
 * also the fix for the old bug where two of these could be stacked on top of
 * each other with no way to tell which Esc would dismiss.
 */
export type AppOverlay =
  | "prs"
  | "mcp"
  | "config"
  | "settings"
  | "agents"
  | "processes";

interface ViewStore {
  view: AppView;
  setView: (view: AppView) => void;
  overlay: AppOverlay | null;
  openOverlay: (overlay: AppOverlay) => void;
  closeOverlay: () => void;
}

/** Which top-level surface fills the main area, and which overlay (if any) is
 *  on top of it. Sidebar toggles the view; opening a chat snaps back to "chat".
 *  Kept tiny + separate so it doesn't churn the chat or project stores. */
export const useView = create<ViewStore>((set) => ({
  view: "chat",
  setView: (view) => set({ view }),
  overlay: null,
  openOverlay: (overlay) => set({ overlay }),
  closeOverlay: () => set({ overlay: null }),
}));

/**
 * Everything an overlay component needs, in the shape `<Modal>` already takes:
 * `const { open, close } = useOverlay("prs")`.
 *
 * Subscribing to the BOOLEAN rather than to `overlay` itself is the point — an
 * overlay re-renders when it opens or closes, not every time some other one does.
 */
export function useOverlay(id: AppOverlay): { open: boolean; close: () => void } {
  const open = useView((s) => s.overlay === id);
  const close = useView((s) => s.closeOverlay);
  return { open, close };
}

/** Open an overlay from outside React (command palette handlers, callbacks). */
export function openOverlay(overlay: AppOverlay): void {
  useView.getState().openOverlay(overlay);
}

/** Switch the main surface from outside React. */
export function setView(view: AppView): void {
  useView.getState().setView(view);
}
