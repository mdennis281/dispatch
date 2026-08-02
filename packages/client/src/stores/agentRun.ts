/**
 * Global "agent run inspector" store — the single open subagent inspector.
 *
 * Same shape as the Monaco viewer's store (components/monaco/store.ts): any
 * surface opens the inspector by id, and one `<AgentRunHost/>` at the app root
 * renders it. Runs themselves are derived from the transcript, never stored —
 * this only holds WHICH run is open and which step is focused, so a live run
 * stays live while you read it.
 */
import { useEffect, useState } from "react";
import { create } from "zustand";

export interface AgentRunTarget {
  chatId: string;
  /** The run's id — the spawning Task row's `toolUseId`. */
  runId: string;
}

interface AgentRunState {
  target: AgentRunTarget | null;
  /** Timeline step the reader clicked (scrolls the stream to it). */
  focusStepId: string | null;
  open: (t: AgentRunTarget) => void;
  /** Drill into a nested subagent, keeping the inspector open. */
  openRun: (runId: string) => void;
  focusStep: (stepId: string | null) => void;
  close: () => void;
}

export const useAgentRun = create<AgentRunState>((set) => ({
  target: null,
  focusStepId: null,
  open: (target) => set({ target, focusStepId: null }),
  openRun: (runId) =>
    set((s) => (s.target ? { target: { ...s.target, runId }, focusStepId: null } : {})),
  focusStep: (focusStepId) => set({ focusStepId }),
  close: () => set({ target: null, focusStepId: null }),
}));

/** Imperative open (for click handlers outside React render). */
export function openAgentRun(chatId: string, runId: string): void {
  useAgentRun.getState().open({ chatId, runId });
}

/**
 * A ticking clock for live elapsed times, in its own hook so only the components
 * that SHOW a timer re-render each second — a running subagent must not drag the
 * transcript through a re-render every tick.
 *
 * Returns `Date.now()`, refreshed on an interval, or a frozen value when
 * `live` is false (a finished run's duration never changes).
 */
export function useNowTick(live: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [live, intervalMs]);
  return now;
}

/**
 * Elapsed ms for a run: frozen once it finished, ticking while it runs.
 * `startedAt`/`durationMs` come from the derived run.
 */
export function useRunElapsed(
  startedAt: number,
  durationMs: number,
  live: boolean,
): number {
  const now = useNowTick(live);
  return live ? Math.max(0, now - startedAt) : durationMs;
}
