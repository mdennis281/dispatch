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
import type { Effort, HarnessKind, ShellTranscriptFilter, WorkflowConfig } from "@dispatch/shared";
import type { AppSettings, ProjectDefaultsPatch } from "../lib/api.js";

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

interface AppDraftPair {
  saved: AppSettings | null;
  draft: AppSettings | null;
}

/**
 * Which slice of the settings object each editable section owns.
 *
 * This exists so the rail's warn dot can point at the section you actually
 * edited. Comparing the whole object per section would light up all four the
 * moment any one of them changed, which tells you there are unsaved edits
 * somewhere — the thing the save bar already says — while implying it about
 * three sections that are untouched.
 *
 * `harness` is deliberately split: the model/effort defaults are a Chat
 * decision and the token limits are a Context one, even though the server
 * stores them under one key.
 */
const SECTION_SLICE: Record<
  "appearance" | "chat" | "context" | "notifications",
  (s: AppSettings) => unknown
> = {
  appearance: (s) => s.theme,
  chat: (s) => [
    s.defaultModeId,
    s.showInjectedContext,
    s.shellFilter,
    s.spawnChat,
    s.harness?.defaultHarness,
    s.harness?.defaults,
  ],
  context: (s) => [s.autoCompact, s.harness?.contextLimits, s.maxActiveSessions],
  notifications: (s) => s.webhook,
};

/** The sections with unsaved edits. Empty when nothing has changed. */
export function dirtyAppSections(s: AppDraftPair): Set<string> {
  const out = new Set<string>();
  const { saved, draft } = s;
  if (!saved || !draft) return out;
  for (const [id, slice] of Object.entries(SECTION_SLICE)) {
    if (JSON.stringify(slice(saved)) !== JSON.stringify(slice(draft))) out.add(id);
  }
  return out;
}

/**
 * Whether ANYTHING is unsaved — what the save bar keys off.
 *
 * Deliberately a whole-object comparison rather than the union of the slices
 * above: a field added to `AppSettings` and not yet routed to a section would
 * otherwise be editable, unsaved, and invisible. This way the worst case is a
 * save bar with no dot beside it, not an edit you can't save.
 *
 * Both sides go through the same normalizer on load, so this is an honest
 * comparison rather than "did any control render its effective value".
 */
export function appSettingsDirty(s: AppDraftPair): boolean {
  if (!s.saved || !s.draft) return false;
  return JSON.stringify(s.saved) !== JSON.stringify(s.draft);
}

/* ------------------------------------------------------------ project */

/**
 * The project LAYER of the chat-posture settings, as the pane edits it: one
 * key per manifest `defaults.*` key plus `spawnChat.autoApprove`, where
 * `undefined` means "inherit from the app". The same shape whether it came
 * from the loaded config or from the pane, so "did anything change?" is a
 * plain comparison and the save can be diffed into a patch (`null` for a key
 * that went back to inheriting).
 */
export interface ChatDefaultsDraft {
  harness?: HarnessKind;
  mode?: string;
  effort?: Effort;
  model?: string;
  showInjectedContext?: boolean;
  autoApprove?: boolean;
}

/** The manifest patch that turns `saved` into `draft` — only the keys that moved. */
export function chatDefaultsPatch(
  saved: ChatDefaultsDraft,
  draft: ChatDefaultsDraft,
): ProjectDefaultsPatch {
  const out: ProjectDefaultsPatch = {};
  const moved = <K extends keyof ChatDefaultsDraft>(key: K) => saved[key] !== draft[key];
  const value = <K extends keyof ChatDefaultsDraft>(key: K) => draft[key] ?? null;
  for (const key of ["harness", "mode", "effort", "model", "showInjectedContext"] as const) {
    if (moved(key)) (out.defaults ??= {})[key] = value(key) as never;
  }
  if (moved("autoApprove")) out.spawnChat = { autoApprove: value("autoApprove") };
  return out;
}

interface ProjectDraftStore {
  /** Which project these edits belong to — switching projects drops them
   *  rather than carrying one project's workflow into another. */
  projectId: string | null;
  /** null = no local edits, so a watcher edit or another client shows through
   *  instead of being shadowed by a stale copy. */
  workflow: WorkflowConfig | null;
  /** null = untouched; `undefined` is a deliberate reset to app inheritance. */
  shellFilter: ShellTranscriptFilter | undefined | null;
  /** null = untouched, like `workflow`. */
  chatDefaults: ChatDefaultsDraft | null;
  bind: (projectId: string | null) => void;
  setWorkflow: (workflow: WorkflowConfig) => void;
  setShellFilter: (filter: ShellTranscriptFilter | undefined) => void;
  setChatDefaults: (draft: ChatDefaultsDraft) => void;
  discard: () => void;
}

export const useProjectSettingsDraft = create<ProjectDraftStore>((set) => ({
  projectId: null,
  workflow: null,
  shellFilter: null,
  chatDefaults: null,
  bind: (projectId) =>
    set((s) =>
      s.projectId === projectId
        ? s
        : { projectId, workflow: null, shellFilter: null, chatDefaults: null },
    ),
  setWorkflow: (workflow) => set({ workflow }),
  setShellFilter: (shellFilter) => set({ shellFilter }),
  setChatDefaults: (chatDefaults) => set({ chatDefaults }),
  discard: () => set({ workflow: null, shellFilter: null, chatDefaults: null }),
}));
