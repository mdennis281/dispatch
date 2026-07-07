import { create } from "zustand";

/** The app's primary surface. "chat" = the transcript workspace; "memory" = the
 *  top-level, chat-independent memory browser (list+search + viewer). */
export type AppView = "chat" | "memory";

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
