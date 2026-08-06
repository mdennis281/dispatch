import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { McpCatalog } from "@dispatch/shared";
import { api } from "../lib/api.js";

interface McpStore {
  /** projectId → its last-fetched catalog. */
  byProject: Record<string, McpCatalog>;
  /** projectId → in-flight fetch flag. */
  loading: Record<string, boolean>;
  /** projectId → last fetch error (null when clear). */
  error: Record<string, string | null>;

  /** Fetch (or re-fetch with `fresh`) a project's catalog into the store. */
  load: (projectId: string, opts?: { fresh?: boolean }) => Promise<void>;
  /** Drop all cached catalogs (reconnect reset). */
  reset: () => void;
}

/** The per-project MCP catalog — the catalog overlay's data spine. Pure REST
 *  (no WS): the overlay fetches on open / project change and on Refresh. */
export const useMcp = create<McpStore>((set, get) => ({
  byProject: {},
  loading: {},
  error: {},

  load: async (projectId, opts) => {
    if (get().loading[projectId]) return;
    set((s) => ({
      loading: { ...s.loading, [projectId]: true },
      error: { ...s.error, [projectId]: null },
    }));
    try {
      const catalog = await api.mcp.catalog(projectId, opts);
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: catalog },
        loading: { ...s.loading, [projectId]: false },
      }));
    } catch (err) {
      set((s) => ({
        loading: { ...s.loading, [projectId]: false },
        error: {
          ...s.error,
          [projectId]: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  },

  reset: () => set({ byProject: {}, loading: {}, error: {} }),
}));

/** Selector: one project's catalog + its load state (stable tuple). */
export function useProjectMcp(projectId: string | null): {
  catalog: McpCatalog | undefined;
  loading: boolean;
  error: string | null;
} {
  return useMcp(
    useShallow((s) => ({
      catalog: projectId ? s.byProject[projectId] : undefined,
      loading: projectId ? !!s.loading[projectId] : false,
      error: projectId ? s.error[projectId] ?? null : null,
    })),
  );
}
