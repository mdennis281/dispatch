import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { McpCatalog, McpEnablementScope } from "@dispatch/shared";
import { api } from "../lib/api.js";

interface McpStore {
  /** projectId → its last-fetched catalog. */
  byProject: Record<string, McpCatalog>;
  /** projectId → in-flight fetch flag. */
  loading: Record<string, boolean>;
  /** projectId → last fetch error (null when clear). */
  error: Record<string, string | null>;
  /** `${projectId}:${server}` → an in-flight toggle, so its row can wait. */
  pending: Record<string, boolean>;

  /** Fetch (or re-fetch with `fresh`) a project's catalog into the store. */
  load: (projectId: string, opts?: { fresh?: boolean }) => Promise<void>;
  /**
   * Pin a server on/off at a scope (`null` clears the pin). The response IS the
   * rebuilt catalog, so the row settles on the server's resolution — including
   * a probe that now succeeds because the server was just switched back on.
   */
  setEnabled: (
    projectId: string,
    name: string,
    scope: McpEnablementScope,
    enabled: boolean | null,
  ) => Promise<void>;
  /** Drop all cached catalogs (reconnect reset). */
  reset: () => void;
}

/** The per-project MCP catalog — the catalog overlay's data spine. Pure REST
 *  (no WS): the overlay fetches on open / project change and on Refresh. */
export const useMcp = create<McpStore>((set, get) => ({
  byProject: {},
  loading: {},
  error: {},
  pending: {},

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

  setEnabled: async (projectId, name, scope, enabled) => {
    const key = `${projectId}:${name}`;
    if (get().pending[key]) return;
    set((s) => ({
      pending: { ...s.pending, [key]: true },
      error: { ...s.error, [projectId]: null },
    }));
    try {
      const catalog = await api.mcp.setEnabled(projectId, name, scope, enabled);
      set((s) => ({ byProject: { ...s.byProject, [projectId]: catalog } }));
    } catch (err) {
      set((s) => ({
        error: {
          ...s.error,
          [projectId]: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      set((s) => {
        const pending = { ...s.pending };
        delete pending[key];
        return { pending };
      });
    }
  },

  reset: () => set({ byProject: {}, loading: {}, error: {}, pending: {} }),
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

/** Selector: whether one server's toggle is mid-flight. */
export function useMcpTogglePending(projectId: string | null, name: string | null): boolean {
  return useMcp((s) => (projectId && name ? !!s.pending[`${projectId}:${name}`] : false));
}
