/**
 * The section index — what the left rail lists, and what it collapses.
 *
 * Declared here rather than discovered from the DOM so the sidebar can render
 * the index for a screen BEFORE that screen mounts, and so a collapsed section
 * still has a row you can use to bring it back. A section that vanishes from
 * the index when you collapse it is a section you cannot reopen.
 */
import type { Route } from "./nav.js";

export interface SectionDef {
  id: string;
  label: string;
  /** Sections that start collapsed — long tails nobody opens on arrival. */
  closed?: boolean;
}

export const SECTIONS: Record<Route["at"], SectionDef[]> = {
  program: [
    { id: "objective", label: "Objective" },
    { id: "settings", label: "Settings", closed: true },
    { id: "phases", label: "Phases" },
    { id: "acceptance", label: "Program acceptance" },
    { id: "teams", label: "Teams" },
  ],
  phase: [
    { id: "phase-detail", label: "Detail" },
    { id: "phase-acceptance", label: "Phase acceptance" },
    { id: "phase-dag", label: "Waves and tasks" },
    { id: "phase-schedule", label: "Concurrency" },
    { id: "phase-qa", label: "QA history" },
  ],
  task: [
    { id: "task-brief", label: "Brief" },
    { id: "task-acceptance", label: "Task acceptance" },
    { id: "task-graph", label: "Dependencies" },
    { id: "task-prs", label: "Pull requests" },
    { id: "task-satisfies", label: "Satisfies" },
    { id: "task-agents", label: "Agents" },
  ],
  agent: [
    { id: "agent-live", label: "Live state" },
    { id: "agent-why", label: "Why this role" },
    { id: "agent-tools", label: "Toolset" },
    { id: "agent-skills", label: "Skills" },
    { id: "agent-instructions", label: "Instructions" },
    { id: "agent-hires", label: "Hire menu" },
  ],
};

/** Section open/closed state plus the scroll-to hook, owned by the shell. */
export interface SectionState {
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  setOpen: (id: string, open: boolean) => void;
  /** Open it if collapsed, then scroll it into view. */
  focus: (id: string) => void;
  register: (id: string, el: HTMLElement | null) => void;
  /** Which section is nearest the top of the scroll area right now. */
  active?: string;
}

/** Default open map for a route, honouring each section's `closed` flag. */
export function defaultOpen(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const defs of Object.values(SECTIONS)) {
    for (const d of defs) out[d.id] = !d.closed;
  }
  return out;
}
