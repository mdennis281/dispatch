import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { ProjectMemory } from "@cm/shared";

interface MemoryStore {
  /** projectId → its memories (kept sorted by name). */
  byProject: Record<string, ProjectMemory[]>;
  /** projectIds whose list we've fetched this session (avoids refetch loops). */
  loaded: Record<string, boolean>;

  /** Replace a project's full list (REST hydrate). */
  setForProject: (projectId: string, memories: ProjectMemory[]) => void;
  /** Create/update one memory in place (WS `memory-update`). */
  upsert: (memory: ProjectMemory) => void;
  /** Remove one memory by name (WS `memory-deleted`). */
  remove: (projectId: string, name: string) => void;
  /** Drop all cached memory (reconnect reset). */
  reset: () => void;
}

function sortByName(list: ProjectMemory[]): ProjectMemory[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

/** Per-project durable agent memory — the Memory panel's data spine. */
export const useMemory = create<MemoryStore>((set) => ({
  byProject: {},
  loaded: {},

  setForProject: (projectId, memories) =>
    set((s) => ({
      byProject: { ...s.byProject, [projectId]: sortByName(memories) },
      loaded: { ...s.loaded, [projectId]: true },
    })),

  upsert: (memory) =>
    set((s) => {
      const list = s.byProject[memory.projectId] ?? [];
      const i = list.findIndex((m) => m.name === memory.name);
      const next = i === -1 ? [...list, memory] : list.map((m) => (m.name === memory.name ? memory : m));
      return { byProject: { ...s.byProject, [memory.projectId]: sortByName(next) } };
    }),

  remove: (projectId, name) =>
    set((s) => {
      const list = s.byProject[projectId];
      if (!list) return s;
      return {
        byProject: { ...s.byProject, [projectId]: list.filter((m) => m.name !== name) },
      };
    }),

  reset: () => set({ byProject: {}, loaded: {} }),
}));

const EMPTY: ProjectMemory[] = [];

/** Selector: one project's memories (stable empty array when none). */
export function useProjectMemories(projectId: string | null): ProjectMemory[] {
  return useMemory(useShallow((s) => (projectId ? s.byProject[projectId] ?? EMPTY : EMPTY)));
}
