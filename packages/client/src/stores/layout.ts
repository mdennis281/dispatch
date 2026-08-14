/**
 * Where the shell's chrome is right now.
 *
 * Four fields, and only one of them is a user preference:
 *
 *   `mode`     — derived from `matchMedia` ONLY (see lib/useBreakpoint). Never
 *                user-set: a "force desktop layout" toggle is a promise the
 *                620px of fixed chrome can't keep on a 390px screen.
 *   `leftOpen` — the off-canvas sidebar, sm only.
 *   `pane`     — which surface fills the main area below `lg`. On sm the Ship/Run
 *                panes REPLACE the transcript; on md they open the right panel as
 *                a drawer over it.
 *   `panelTab` — the right panel's selected tab. Lifted out of `RightPanel`'s
 *                `useState` because the bottom nav lives in `App.tsx`, outside the
 *                `<aside>`, and cannot reach a component's local state.
 *
 * Only `panelTab` persists. `leftOpen` and `pane` deliberately do not: a
 * persisted drawer flag is how an app comes back from a reload with a sheet
 * already open over content the user never asked to leave.
 *
 * Persistence is the house pattern (`lib/taskPrefs.ts`, `lib/composerPrefs.ts`):
 * a guarded localStorage read/write, no zustand `persist` middleware — that
 * middleware appears nowhere else in this repo, and one store hydrating
 * differently from the other thirty is a debugging tax nobody signed up for.
 */
import { create } from "zustand";
import type { FocusPanelTab } from "../components/panels/panelBus.js";
import { currentMode, watchBreakpoint, type LayoutMode } from "../lib/useBreakpoint.js";

export type { LayoutMode };

/** Which surface fills the main area below `lg`. */
export type Pane = "chat" | "ship" | "run";

/**
 * The two halves the five right-panel tabs already split into: "ship" is the
 * state of your CHANGE, "run" is the state of your PROCESSES. See the docblock
 * on `RightPanel` — the bottom nav reuses this taxonomy rather than inventing a
 * second one, so a nav slot and a tab can never disagree about where a panel is.
 */
export type PanelGroup = "ship" | "run";

export const PANEL_GROUP: Record<FocusPanelTab, PanelGroup> = {
  worktrees: "ship",
  prs: "ship",
  agents: "run",
  terminals: "run",
  apps: "run",
};

/** The tab a group opens on when it's selected from outside (nav slot, segment). */
export const GROUP_HOME: Record<PanelGroup, FocusPanelTab> = {
  ship: "worktrees",
  run: "agents",
};

const KEY = "cm:panel-tab";
const DEFAULT_TAB: FocusPanelTab = "worktrees";

function backing(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked by cookie policy
  }
}

function loadTab(): FocusPanelTab {
  try {
    const raw = backing()?.getItem(KEY);
    // Validated against the live map, not a cast: a tab id renamed in a later
    // release must degrade to Worktrees, not render an empty panel body.
    return raw && Object.prototype.hasOwnProperty.call(PANEL_GROUP, raw)
      ? (raw as FocusPanelTab)
      : DEFAULT_TAB;
  } catch {
    return DEFAULT_TAB;
  }
}

function persistTab(tab: FocusPanelTab): void {
  try {
    backing()?.setItem(KEY, tab);
  } catch {
    /* quota / private mode — a lost preference beats a thrown save */
  }
}

interface LayoutStore {
  mode: LayoutMode;
  leftOpen: boolean;
  pane: Pane;
  panelTab: FocusPanelTab;
  setMode: (mode: LayoutMode) => void;
  setLeftOpen: (open: boolean) => void;
  setPane: (pane: Pane) => void;
  setPanelTab: (tab: FocusPanelTab) => void;
}

export const useLayout = create<LayoutStore>((set) => ({
  mode: currentMode(),
  leftOpen: false,
  pane: "chat",
  panelTab: loadTab(),

  /**
   * Breakpoint transitions are resolved HERE, not in a component effect. An
   * effect watching `mode` runs once per subscribed component, so "closing the
   * drawer on md → sm" would fire five times and fight anything that reopened it
   * in between.
   */
  setMode: (mode) =>
    set((s) => {
      if (s.mode === mode) return s;
      return {
        mode,
        // Closed on EVERY transition, not just md → sm. `leftOpen` is only ever
        // set on sm, so any other mode can only be carrying a stale `true` from
        // an earlier visit — and an inline sidebar that becomes a drawer must not
        // appear already-open.
        leftOpen: false,
        // Entering lg strands any Ship/Run pane: the right panel is inline there,
        // so a leftover "run" would hide the transcript behind a panel that is
        // already visible beside it.
        pane: mode === "lg" ? "chat" : s.pane,
      };
    }),

  setLeftOpen: (leftOpen) => set({ leftOpen }),

  setPane: (pane) =>
    set((s) => {
      if (pane === "chat") return { pane };
      // Keep the tab and the pane in the same group. Landing on Ship while
      // `panelTab` is "terminals" would show the Run tabs under a Ship-lit slot.
      if (PANEL_GROUP[s.panelTab] === pane) return { pane };
      const panelTab = GROUP_HOME[pane];
      persistTab(panelTab);
      return { pane, panelTab };
    }),

  setPanelTab: (panelTab) =>
    set((s) => {
      persistTab(panelTab);
      // Derive the pane from the tab's group so a deep link (command palette →
      // "Jump to Terminals") can never select a tab whose pane is hidden. Not on
      // lg: the right panel is inline there, so the pane isn't in play and
      // moving it would only strand a Ship/Run pane for the next resize down.
      if (s.mode === "lg") return { panelTab };
      return { panelTab, pane: PANEL_GROUP[panelTab] };
    }),
}));

/** The current breakpoint. The one accessor components should use. */
export function useLayoutMode(): LayoutMode {
  return useLayout((s) => s.mode);
}

/** Select a right-panel tab from outside React (command palette, panelBus). */
export function focusPanelTab(tab: FocusPanelTab): void {
  useLayout.getState().setPanelTab(tab);
}

/**
 * Dismiss the left drawer. A no-op above sm, so callers (chat rows, nav buttons,
 * the project picker) can fire it unconditionally instead of each re-deriving
 * "am I in a drawer right now?".
 */
export function dismissLeftDrawer(): void {
  if (useLayout.getState().leftOpen) useLayout.setState({ leftOpen: false });
}

// Registered at module load — the mode has to be right on the first render, and
// nothing but this module should be listening to the queries.
watchBreakpoint((mode) => useLayout.getState().setMode(mode));
