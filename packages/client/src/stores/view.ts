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

interface ViewStore {
  view: AppView;
  setView: (view: AppView) => void;
}

/** Which top-level surface fills the main area. Sidebar toggles it; opening a
 *  chat snaps back to "chat". Kept tiny + separate so it doesn't churn the chat
 *  or project stores. */
export const useView = create<ViewStore>((set) => ({
  view: "chat",
  setView: (view) => set({ view }),
}));
