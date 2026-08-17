/**
 * The Workspace catalog's own state: which kind of resource is showing, how wide
 * to look, and the text filter — plus the app-wide lists that only this view
 * asks for.
 *
 * Deliberately separate from `stores/terminals` and `stores/panels`, which hold
 * the ACTIVE CHAT's live data and are fed by the WS event stream. This view asks
 * a wider question ("every shell on this machine", "whose worktree is that?")
 * whose answer no chat-scoped store has, and asking it should cost a fetch when
 * the modal opens rather than a standing subscription to everything.
 *
 * The filter fields are `RegistryQuery`'s, because the server filters with the
 * same shape: what the controls here describe is exactly what the API is asked,
 * so the visual filter and the programmatic one cannot drift.
 */
import { create } from "zustand";
import type { RegistryScope, TerminalInfo, WorktreeInfo } from "@dispatch/shared";
import { api } from "../lib/api.js";

/** Which catalog is on screen. `prs` is present but not yet implemented. */
export type WorkspaceKind = "worktrees" | "terminals" | "prs";

const STORAGE_KEY = "cm.workspace.view";

interface Persisted {
  kind: WorkspaceKind;
  scope: RegistryScope;
}

/** Last kind+scope, so reopening the modal resumes where you left it. */
function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      const kind = parsed.kind;
      const scope = parsed.scope;
      return {
        kind: kind === "terminals" || kind === "prs" ? kind : "worktrees",
        scope: scope === "chat" || scope === "project" || scope === "all" ? scope : "chat",
      };
    }
  } catch {
    /* a corrupt/blocked localStorage is not worth failing the modal over */
  }
  return { kind: "worktrees", scope: "chat" };
}

interface WorkspaceStore {
  kind: WorkspaceKind;
  scope: RegistryScope;
  q: string;
  worktrees: WorktreeInfo[];
  terminals: TerminalInfo[];
  loading: boolean;
  error?: string;
  setKind: (kind: WorkspaceKind) => void;
  setScope: (scope: RegistryScope) => void;
  setQ: (q: string) => void;
  /** Fetch the current kind for the given ids. Safe to call repeatedly. */
  load: (ids: { projectId?: string; chatId?: string }) => Promise<void>;
}

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  ...loadPersisted(),
  q: "",
  worktrees: [],
  terminals: [],
  loading: false,
  setKind: (kind) => {
    set({ kind });
    persist(kind, get().scope);
  },
  setScope: (scope) => {
    set({ scope });
    persist(get().kind, scope);
  },
  setQ: (q) => set({ q }),

  load: async ({ projectId, chatId }) => {
    const { kind, scope } = get();
    if (kind === "prs") return;
    // `q` is applied CLIENT-side (below, in the view) rather than sent: typing
    // in the box shouldn't be a request per keystroke, and these lists are small
    // enough that the same predicate over the fetched rows is instant.
    const query = { scope, projectId, chatId };
    set({ loading: true, error: undefined });
    try {
      if (kind === "worktrees") {
        set({ worktrees: await api.worktrees.list(query), loading: false });
      } else {
        set({ terminals: await api.terminals.list(query), loading: false });
      }
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));

function persist(kind: WorkspaceKind, scope: RegistryScope): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ kind, scope }));
  } catch {
    /* best-effort */
  }
}
