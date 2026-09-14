import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { ProjectConfigDefaults, ProjectConfigResult } from "@dispatch/shared";
import { api } from "../lib/api.js";

interface ConfigStore {
  /** projectId → its last-loaded `.dispatch/` result (config + errors). */
  byProject: Record<string, ProjectConfigResult>;
  /** projectId → in-flight fetch flag. */
  loading: Record<string, boolean>;
  /** projectId → last fetch/reload error (null when clear). */
  error: Record<string, string | null>;

  /** Fetch the cached load into the store. */
  load: (projectId: string) => Promise<void>;
  /** Force a disk re-read (POST …/config/reload). */
  reload: (projectId: string) => Promise<void>;
  /** Apply a `project-config-update` WS event's payload (live refresh). */
  set: (projectId: string, result: ProjectConfigResult) => void;
  /** Drop all cached results (reconnect reset). */
  reset: () => void;
}

/** The per-project `.dispatch/` config — the Project config view's spine.
 *  Fetched on open + on Reload; also live-updated by the `project-config-update`
 *  WS event (a watcher edit / a scaffold / an import). */
export const useConfig = create<ConfigStore>((set, get) => ({
  byProject: {},
  loading: {},
  error: {},

  load: async (projectId) => {
    if (get().loading[projectId]) return;
    set((s) => ({
      loading: { ...s.loading, [projectId]: true },
      error: { ...s.error, [projectId]: null },
    }));
    try {
      const result = await api.projectConfig.get(projectId);
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: result },
        loading: { ...s.loading, [projectId]: false },
      }));
    } catch (err) {
      set((s) => ({
        loading: { ...s.loading, [projectId]: false },
        error: { ...s.error, [projectId]: err instanceof Error ? err.message : String(err) },
      }));
    }
  },

  reload: async (projectId) => {
    set((s) => ({
      loading: { ...s.loading, [projectId]: true },
      error: { ...s.error, [projectId]: null },
    }));
    try {
      const result = await api.projectConfig.reload(projectId);
      set((s) => ({
        byProject: { ...s.byProject, [projectId]: result },
        loading: { ...s.loading, [projectId]: false },
      }));
    } catch (err) {
      set((s) => ({
        loading: { ...s.loading, [projectId]: false },
        error: { ...s.error, [projectId]: err instanceof Error ? err.message : String(err) },
      }));
    }
  },

  set: (projectId, result) =>
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: result },
      error: { ...s.error, [projectId]: null },
    })),

  reset: () => set({ byProject: {}, loading: {}, error: {} }),
}));

/**
 * The PROJECT layer of the layered settings — the manifest's `defaults` block
 * and `spawnChat` — for a project, loading it on first use.
 *
 * The config store is otherwise only filled when the Project config page opens
 * or a `project-config-update` event arrives, so a chat opened cold would
 * resolve its effort as though the manifest said nothing, then flip once the
 * page was visited. Every resolver hook goes through here so the layer is
 * fetched the first time anything asks. `undefined` while it loads (and for a
 * project with no config dir) reads as "the project says nothing", which is
 * the right answer for both.
 */
export function useProjectLayer(
  projectId: string | null | undefined,
): (ProjectConfigDefaults & { spawnChat?: { autoApprove?: boolean } }) | undefined {
  const entry = useConfig((s) => (projectId ? s.byProject[projectId] : undefined));
  const known = entry !== undefined;
  useEffect(() => {
    if (projectId && !known) void useConfig.getState().load(projectId);
  }, [projectId, known]);
  const config = entry?.config;
  if (!config) return undefined;
  return { ...(config.defaults ?? {}), ...(config.spawnChat ? { spawnChat: config.spawnChat } : {}) };
}

/** Selector: one project's config result + load state (stable tuple). */
export function useProjectConfig(projectId: string | null): {
  result: ProjectConfigResult | undefined;
  loading: boolean;
  error: string | null;
} {
  return useConfig(
    useShallow((s) => ({
      result: projectId ? s.byProject[projectId] : undefined,
      loading: projectId ? !!s.loading[projectId] : false,
      error: projectId ? s.error[projectId] ?? null : null,
    })),
  );
}
