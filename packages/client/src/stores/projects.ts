import { create } from "zustand";
import type { Project, AgentConfig, ModeConfig } from "@dispatch/shared";

/**
 * Which project you were last working in, remembered per browser.
 *
 * `hydrate` used to land on `projects[0]` unconditionally, so every refresh
 * threw you back to whichever project happens to sort first and you re-picked
 * yours by hand. In an installed PWA served through a reverse proxy a reload is
 * routine — a dropped socket, a swipe-down, a redeploy — so that was a tax paid
 * several times a day.
 *
 * Kept in localStorage rather than in the server's app settings ON PURPOSE:
 * where you are is a fact about THIS browser, not about the account. The phone
 * and the desktop are usually pointed at different work, and a single shared
 * "active project" would have them yanking each other around on every load.
 *
 * Guarded read/write, the house pattern (`stores/layout`, `lib/taskPrefs`):
 * localStorage throws under a blocking cookie policy and doesn't exist at all in
 * the node test environment.
 */
const LAST_PROJECT_KEY = "cm:last-project";

function backing(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked by cookie policy
  }
}

function rememberProject(id: string): void {
  try {
    backing()?.setItem(LAST_PROJECT_KEY, id);
  } catch {
    /* quota / private mode — a lost preference beats a thrown save */
  }
}

/**
 * The project to open on: the remembered one, else the first.
 *
 * Validated against the list rather than trusted. An id can outlive the project
 * it names — removed from `.dispatch/`, or written by a dev instance on another
 * port that shares this origin's storage — and a focus on a project that isn't
 * there renders an empty shell with nothing lit in the rail. Falling back to
 * `projects[0]` is what the hydrate did before, so a stale entry costs exactly
 * the old behaviour and nothing more.
 */
function initialProject(projects: Project[]): string | null {
  let remembered: string | null = null;
  try {
    remembered = backing()?.getItem(LAST_PROJECT_KEY) ?? null;
  } catch {
    remembered = null;
  }
  if (remembered && projects.some((p) => p.id === remembered)) return remembered;
  return projects[0]?.id ?? null;
}

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
  /** Replace just the agent/mode picker lists (e.g. after a `.dispatch/`
   *  config reload) without disturbing projects or the active selection. */
  setConfigLists: (data: { agents: AgentConfig[]; modes: ModeConfig[] }) => void;
}

/** Projects + their agents/modes config, and which project is in focus. */
export const useProjects = create<ProjectsStore>((set) => ({
  projects: [],
  agents: [],
  modes: [],
  activeProjectId: null,
  setActiveProject: (id) => {
    rememberProject(id);
    set({ activeProjectId: id });
  },
  hydrate: ({ projects, agents, modes }) => {
    const activeProjectId = initialProject(projects);
    // Write back the fallback too, so a first-ever load starts remembering from
    // where it actually landed instead of staying blank until the first manual
    // switch. A `null` (no projects exist yet) deliberately does NOT clear the
    // entry: an empty roster is not evidence that the remembered project is
    // gone, and forgetting on one would lose it for good.
    if (activeProjectId) rememberProject(activeProjectId);
    set({ projects, agents, modes, activeProjectId });
  },
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
