import { create } from "zustand";
import type { Project, AgentConfig, ModeConfig } from "@cm/shared";

interface ProjectsStore {
  projects: Project[];
  agents: AgentConfig[];
  modes: ModeConfig[];
  activeProjectId: string | null;
  setActiveProject: (id: string) => void;
  hydrate: (data: {
    projects: Project[];
    agents: AgentConfig[];
    modes: ModeConfig[];
  }) => void;
  upsertProject: (p: Project) => void;
  /** Replace just the agent/mode picker lists (e.g. after a `.claude-manager/`
   *  config reload) without disturbing projects or the active selection. */
  setConfigLists: (data: { agents: AgentConfig[]; modes: ModeConfig[] }) => void;
}

/** Projects + their agents/modes config, and which project is in focus. */
export const useProjects = create<ProjectsStore>((set) => ({
  projects: [],
  agents: [],
  modes: [],
  activeProjectId: null,
  setActiveProject: (id) => set({ activeProjectId: id }),
  hydrate: ({ projects, agents, modes }) =>
    set({
      projects,
      agents,
      modes,
      activeProjectId: projects[0]?.id ?? null,
    }),
  upsertProject: (p) =>
    set((s) => {
      const i = s.projects.findIndex((x) => x.id === p.id);
      const projects = i === -1 ? [...s.projects, p] : s.projects.map((x) => (x.id === p.id ? p : x));
      return { projects };
    }),
  setConfigLists: ({ agents, modes }) => set({ agents, modes }),
}));

/** Selector: the currently-focused project record (or null). */
export function useActiveProject(): Project | null {
  return useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
}
