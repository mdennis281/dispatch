/**
 * Unsaved settings edits, held OUTSIDE the components that render them.
 *
 * This is the one thing that had to change when settings stopped being modals.
 * A modal is a place you are trapped in until you answer, so a draft in local
 * state and a "you have unsaved changes" confirmation on close was enough. A
 * page isn't: the sidebar, the bottom nav and every chat row are one tap away
 * at all times, and there is no single exit to intercept. Local state would mean
 * a half-typed webhook URL disappears because you glanced at a chat.
 *
 * So the drafts live here and survive navigation. Leaving a settings page with
 * unsaved edits is now non-destructive — the section rail still carries its
 * warn dot and the save bar is still there when you come back — which is a
 * better answer than the confirmation dialog it replaces, because it doesn't
 * make you decide anything at the moment you were trying to do something else.
 */
import { create } from "zustand";
import type { ShellTranscriptFilter, WorkflowConfig } from "@dispatch/shared";
import type { AppSettings } from "../lib/api.js";

/* ---------------------------------------------------------------- app */

interface AppDraftStore {
  /** What the server last told us. `null` until the page has loaded once. */
  saved: AppSettings | null;
  /** The edited copy. Also `null` before the first load. */
  draft: AppSettings | null;
  /** Seed both from a server response — the page only calls this when `draft`
   *  is null, so a load can never clobber edits in progress. */
  hydrate: (settings: AppSettings) => void;
  patch: (p: Partial<AppSettings>) => void;
  /** Replace wholesale (the nested `patch*` helpers build their own object). */
  set: (draft: AppSettings) => void;
  /** Throw the edits away, keeping the loaded baseline. */
  discard: () => void;
  /** After a successful PUT: the response becomes the new baseline. */
  commit: (settings: AppSettings) => void;
}

export const useAppSettingsDraft = create<AppDraftStore>((set) => ({
  saved: null,
  draft: null,
  hydrate: (settings) => set({ saved: settings, draft: settings }),
  patch: (p) => set((s) => (s.draft ? { draft: { ...s.draft, ...p } } : s)),
  set: (draft) => set({ draft }),
  discard: () => set((s) => ({ draft: s.saved })),
  commit: (settings) => set({ saved: settings, draft: settings }),
}));

/** Field-by-field, over the shape the server round-trips. Both sides go through
 *  the same normalizer on load, so this is an honest comparison rather than
 *  "did any control render its effective value". */
export function appSettingsDirty(s: {
  saved: AppSettings | null;
  draft: AppSettings | null;
}): boolean {
  if (!s.saved || !s.draft) return false;
  return JSON.stringify(s.saved) !== JSON.stringify(s.draft);
}

/* ------------------------------------------------------------ project */

interface ProjectDraftStore {
  /** Which project these edits belong to — switching projects drops them
   *  rather than carrying one project's workflow into another. */
  projectId: string | null;
  /** null = no local edits, so a watcher edit or another client shows through
   *  instead of being shadowed by a stale copy. */
  workflow: WorkflowConfig | null;
  /** null = untouched; `undefined` is a deliberate reset to app inheritance. */
  shellFilter: ShellTranscriptFilter | undefined | null;
  bind: (projectId: string | null) => void;
  setWorkflow: (workflow: WorkflowConfig) => void;
  setShellFilter: (filter: ShellTranscriptFilter | undefined) => void;
  discard: () => void;
}

export const useProjectSettingsDraft = create<ProjectDraftStore>((set) => ({
  projectId: null,
  workflow: null,
  shellFilter: null,
  bind: (projectId) =>
    set((s) =>
      s.projectId === projectId
        ? s
        : { projectId, workflow: null, shellFilter: null },
    ),
  setWorkflow: (workflow) => set({ workflow }),
  setShellFilter: (shellFilter) => set({ shellFilter }),
  discard: () => set({ workflow: null, shellFilter: null }),
}));
