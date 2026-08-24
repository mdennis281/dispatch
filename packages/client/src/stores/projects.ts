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
 *
 * READ-ONLY, deliberately: a failed match does NOT clear the entry, and a
 * hydrate never writes one. `setActiveProject` is the sole writer, because the
 * only thing worth remembering is a project the USER chose.
 *
 * That single-writer rule is load-bearing, not tidiness. `hydrateFromMock` runs
 * this same `hydrate` — on a dev instance sitting at the login screen, an
 * unconditional timer in `main.tsx` seeds the offline fixture before anyone has
 * signed in. A hydrate that wrote back would stamp the fixture's project id over
 * the real preference, and the live hydrate that followed would find that id
 * missing from the real roster and stamp `projects[0]` over it in turn — losing
 * the project you were actually in, with no user action anywhere in the story.
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
  hydrate: ({ projects, agents, modes }) =>
    set({ projects, agents, modes, activeProjectId: initialProject(projects) }),
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
