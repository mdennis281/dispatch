import { create } from "zustand";
import type { ConfigSection } from "@dispatch/shared";

/** The app's primary surface. "chat" = the transcript workspace; "memory" = the
 *  top-level, chat-independent memory browser (list+search + viewer); "git" =
 *  the project's Source Control cockpit (changes, history, branches, stashes);
 *  "files" = the filesystem browser (this machine's disks, not just the repo);
 *  "new-project" = the full-bleed project setup page;
 *  "project-settings" / "app-settings" = the two settings pages.
 *
 *  "new-project" is the one view that also hides the SIDEBAR. It isn't scoped to
 *  the active project — it's how a project comes to exist — so a rail of the
 *  current project's chats and apps beside it is noise at best and a misread at
 *  worst ("am I editing that one?"). Everything else keeps its chrome. */
export type AppView =
  | "chat"
  | "memory"
  | "git"
  | "files"
  | "new-project"
  | "project-settings"
  | "app-settings";

/**
 * The app-settings subpages.
 *
 * Declared HERE rather than beside the registry that renders them because the
 * selected subpage is navigation state — the command palette addresses it
 * ("Stop Dispatch" lands on `system`), and a store that imported a component
 * file to learn the union would be pointing the wrong way.
 */
export type AppSettingsSection =
  | "appearance"
  | "chat"
  | "context"
  | "notifications"
  | "auth"
  | "updates"
  | "system";

/**
 * The app's modal surfaces — project-scoped things that sit ON TOP of a view
 * rather than replacing it.
 *
 * These used to be opened three different ways: each of `prs`/`mcp` and the old
 * `config` overlay had its own `*Bus.ts` module firing a bespoke window
 * CustomEvent that the always-mounted overlay listened for, while `agents` and
 * the old `settings` overlay were plain `useState` in whichever component
 * happened to render the trigger. Same class of thing, three mechanisms — so
 * nothing could tell what was open, only one could be addressed by the command
 * palette without special-casing, and closing behaviour was whatever each site
 * remembered to wire.
 *
 * One field, one setter. Opening any overlay closes the previous one, which is
 * also the fix for the old bug where two of these could be stacked on top of
 * each other with no way to tell which Esc would dismiss.
 *
 * `config` and `settings` are no longer in this list: both outgrew a dialog and
 * are now full views (see `AppView` above), which is also what let their
 * subpages become addressable.
 */
/* `prs` is gone: the PR roster is a tab of the Workspace modal now, so there
 * is one list rather than two that answered the same question differently. */
export type AppOverlay = "workspace" | "mcp" | "agents" | "processes";

interface ViewStore {
  view: AppView;
  setView: (view: AppView) => void;
  /** Which subpage of the project-settings view is showing. */
  projectSection: ConfigSection;
  setProjectSection: (section: ConfigSection) => void;
  /** Which subpage of the app-settings view is showing. */
  appSection: AppSettingsSection;
  setAppSection: (section: AppSettingsSection) => void;
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
  projectSection: "workflow",
  setProjectSection: (projectSection) => set({ projectSection }),
  appSection: "appearance",
  setAppSection: (appSection) => set({ appSection }),
  overlay: null,
  openOverlay: (overlay) => set({ overlay }),
  closeOverlay: () => set({ overlay: null }),
}));

/**
 * Everything an overlay component needs, in the shape `<Modal>` already takes:
 * `const { open, close } = useOverlay("mcp")`.
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

/**
 * Open a settings page, optionally on a named subpage.
 *
 * Both pages remember which subpage you were last on, so omitting the argument
 * puts you back where you left — but a caller that MEANS a particular one (the
 * palette's "Stop Dispatch", a deep link) says so and wins.
 */
export function openProjectSettings(section?: ConfigSection): void {
  useView.setState({
    view: "project-settings",
    ...(section ? { projectSection: section } : {}),
  });
}

export function openAppSettings(section?: AppSettingsSection): void {
  useView.setState({
    view: "app-settings",
    ...(section ? { appSection: section } : {}),
  });
}
