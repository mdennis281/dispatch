/**
 * The Workspace catalog's own state: which kind of resource is showing, how wide
 * to look, how it's ordered, which narrowings are on — plus the app-wide lists
 * that only this view asks for.
 *
 * Deliberately separate from `stores/terminals` and `stores/panels`, which hold
 * the ACTIVE CHAT's live data and are fed by the WS event stream. This view asks
 * a wider question ("every shell on this machine", "whose worktree is that?")
 * whose answer no chat-scoped store has, and asking it should cost a fetch when
 * the modal opens rather than a standing subscription to everything.
 *
 * The filter fields are `RegistryQuery`'s, because the server filters with the
 * same shape: what the controls here describe is exactly what the API is asked,
 * so the visual filter and the programmatic one cannot drift. That is why the
 * sort and the facet toggles are SENT rather than applied to the rows in hand —
 * `unmerged` isn't answerable in the browser at all (it needs git and the PR
 * records), and a client-side copy of the ones that are would be the second
 * implementation this design exists to avoid.
 */
import { create } from "zustand";
import type {
  RegistryQuery,
  RegistryScope,
  RegistrySort,
  TerminalInfo,
  WorktreeInfo,
} from "@dispatch/shared";
import { api } from "../lib/api.js";

/** Which catalog is on screen. `prs` is present but not yet implemented. */
export type WorkspaceKind = "worktrees" | "terminals" | "prs";

/**
 * The narrowings the modal offers, by the `RegistryQuery` field each drives.
 * Two per tab: the question that tab exists to answer, and the noise it
 * accumulates.
 */
export interface WorkspaceFilters {
  /** Terminals: running a command or holding a background one. */
  active: boolean;
  /** Terminals: hide rows whose process is gone (sends `archived: false`). */
  hideArchived: boolean;
  /** Worktrees: still holding work that isn't on the trunk. */
  unmerged: boolean;
  /** Worktrees: no owning chat. */
  unattributed: boolean;
}

const NO_FILTERS: WorkspaceFilters = {
  active: false,
  hideArchived: false,
  unmerged: false,
  unattributed: false,
};

const STORAGE_KEY = "cm.workspace.view";

interface Persisted {
  kind: WorkspaceKind;
  scope: RegistryScope;
  sort: RegistrySort;
  filters: WorkspaceFilters;
}

const SORTS: RegistrySort[] = ["recent", "created", "name"];

/** Last view, so reopening the modal resumes where you left it. */
function loadPersisted(): Persisted {
  const fallback: Persisted = {
    kind: "worktrees",
    scope: "chat",
    sort: "recent",
    filters: NO_FILTERS,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    const kind = parsed.kind;
    const scope = parsed.scope;
    const sort = parsed.sort;
    return {
      kind: kind === "terminals" || kind === "prs" ? kind : "worktrees",
      scope: scope === "chat" || scope === "project" || scope === "all" ? scope : "chat",
      sort: sort && SORTS.includes(sort) ? sort : "recent",
      // Key-by-key, never a spread of whatever was in storage: a stale build's
      // filter names would otherwise ride along as junk in the query string and
      // come back as a 400 from a server that validates what it's sent.
      filters: {
        active: parsed.filters?.active === true,
        hideArchived: parsed.filters?.hideArchived === true,
        unmerged: parsed.filters?.unmerged === true,
        unattributed: parsed.filters?.unattributed === true,
      },
    };
  } catch {
    /* a corrupt/blocked localStorage is not worth failing the modal over */
    return fallback;
  }
}

interface WorkspaceStore {
  kind: WorkspaceKind;
  scope: RegistryScope;
  sort: RegistrySort;
  filters: WorkspaceFilters;
  q: string;
  worktrees: WorktreeInfo[];
  terminals: TerminalInfo[];
  loading: boolean;
  killing: boolean;
  error?: string;
  setKind: (kind: WorkspaceKind) => void;
  setScope: (scope: RegistryScope) => void;
  setSort: (sort: RegistrySort) => void;
  toggleFilter: (key: keyof WorkspaceFilters) => void;
  setQ: (q: string) => void;
  /** Fetch the current kind for the given ids. Safe to call repeatedly. */
  load: (ids: { projectId?: string; chatId?: string }) => Promise<void>;
  /**
   * Close every live shell the CURRENT question selects, then refetch. Returns
   * how many went, so the caller can say so.
   */
  killAll: (ids: { projectId?: string; chatId?: string }) => Promise<number>;
}

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  ...loadPersisted(),
  q: "",
  worktrees: [],
  terminals: [],
  loading: false,
  killing: false,
  setKind: (kind) => {
    set({ kind });
    persist(get());
  },
  setScope: (scope) => {
    set({ scope });
    persist(get());
  },
  setSort: (sort) => {
    set({ sort });
    persist(get());
  },
  toggleFilter: (key) => {
    set((s) => ({ filters: { ...s.filters, [key]: !s.filters[key] } }));
    persist(get());
  },
  setQ: (q) => set({ q }),

  load: async ({ projectId, chatId }) => {
    const { kind } = get();
    if (kind === "prs") return;
    const query = buildQuery(get(), { projectId, chatId });
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

  killAll: async (ids) => {
    set({ killing: true, error: undefined });
    try {
      // The same query the list was fetched with — so what dies is what the
      // human can see, including the scope. `killing` gates the button rather
      // than `loading`, which the refetch below owns.
      const { killed } = await api.terminals.killAll(buildQuery(get(), ids));
      set({ killing: false });
      await get().load(ids);
      return killed;
    } catch (err) {
      set({
        killing: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  },
}));

/**
 * The current view AS a `RegistryQuery`.
 *
 * Only the facets that belong to the visible tab go in: asking the terminals
 * catalog for `unmerged` selects nothing at all (the server refuses to answer a
 * facet it has no accessor for rather than silently dropping it), so leaking a
 * worktree toggle into a terminals query would empty the list.
 *
 * `q` stays OUT deliberately — it's applied to the rows already in hand, so
 * typing in the box costs no requests.
 */
function buildQuery(
  s: Pick<WorkspaceStore, "kind" | "scope" | "sort" | "filters">,
  ids: { projectId?: string; chatId?: string },
): Partial<RegistryQuery> {
  const query: Partial<RegistryQuery> = {
    scope: s.scope,
    projectId: ids.projectId,
    chatId: ids.chatId,
    sort: s.sort,
  };
  if (s.kind === "terminals") {
    if (s.filters.active) query.active = true;
    if (s.filters.hideArchived) query.archived = false;
  } else {
    if (s.filters.unmerged) query.unmerged = true;
    if (s.filters.unattributed) query.unattributed = true;
  }
  return query;
}

function persist(s: Persisted): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ kind: s.kind, scope: s.scope, sort: s.sort, filters: s.filters }),
    );
  } catch {
    /* best-effort */
  }
}
