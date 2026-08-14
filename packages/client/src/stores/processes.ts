import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { api, type ProjectProcess } from "../lib/api.js";
import { isLiveChatTerminal, useTerminals } from "./terminals.js";

/**
 * OS port scan results, per project — hoisted out of ProcessesPanel so the
 * orphan count exists while that panel is COLLAPSED.
 *
 * The panel used to hold `rows` in local state and only fetch on expand, which
 * made its "N orphans" warning chip unreachable: the chip is what tells you to
 * open the panel, and it could only render once you already had. Owning the rows
 * here also lets the Apps tab badge count orphans without mounting the panel.
 *
 * Still on-demand, never polled — the scan shells out to `netstat`/`tasklist`.
 * Callers scan on project change and on a runner start/stop (the transition that
 * actually creates an orphan), plus explicit refreshes from the panel.
 */
interface ProcessesStore {
  byProject: Record<string, ProjectProcess[]>;
  scanning: Record<string, boolean>;
  errors: Record<string, string | null>;
  /** Rescan one project's ports. Concurrent calls share the in-flight scan. */
  scan: (projectId: string) => Promise<void>;
}

const EMPTY: ProjectProcess[] = [];
/** Stable empty result — a fresh `[]` from a selector re-renders every tick. */
const EMPTY_PIDS: number[] = [];

/** Coalesces the scans fired by a project switch and a panel expand in the same tick. */
const inFlight = new Map<string, Promise<void>>();

export const useProcesses = create<ProcessesStore>((set) => ({
  byProject: {},
  scanning: {},
  errors: {},

  scan: (projectId) => {
    const pending = inFlight.get(projectId);
    if (pending) return pending;

    const run = (async () => {
      set((s) => ({
        scanning: { ...s.scanning, [projectId]: true },
        errors: { ...s.errors, [projectId]: null },
      }));
      try {
        const rows = await api.processes.list(projectId);
        set((s) => ({ byProject: { ...s.byProject, [projectId]: rows } }));
      } catch (err) {
        set((s) => ({
          errors: {
            ...s.errors,
            [projectId]: err instanceof Error ? err.message : String(err),
          },
        }));
      } finally {
        inFlight.delete(projectId);
        set((s) => ({ scanning: { ...s.scanning, [projectId]: false } }));
      }
    })();

    inFlight.set(projectId, run);
    return run;
  },
}));

/** One project's scanned listeners (stable reference — safe as a selector result). */
export function useProjectProcesses(projectId: string): ProjectProcess[] {
  return useProcesses((s) => s.byProject[projectId] ?? EMPTY);
}

/** The listeners attributed to ONE shell — what that terminal card is holding. */
export function useTerminalPorts(
  projectId: string | undefined,
  terminalId: string,
): ProjectProcess[] {
  return useProcesses(
    useShallow((s) =>
      projectId
        ? (s.byProject[projectId] ?? EMPTY).filter((r) => r.terminalId === terminalId)
        : EMPTY,
    ),
  );
}

/**
 * Everything ONE chat is running: the pids of its live shells plus the pids of
 * every listener attributed to them.
 *
 * Both halves are needed. A shell that has just started `pnpm dev` holds no port
 * yet but is very much running something, and a Vite that hopped two ports is
 * only reachable through the shell it descends from. Killing the shell pid
 * tree-kills the rest, but the listener pids are included anyway: a runner-
 * started process re-parented by a restart would otherwise survive a kill that
 * claimed to clear the chat.
 */
export function useChatProcessPids(
  chatId: string,
  projectId: string | undefined,
): number[] {
  // `useShallow` on both: these selectors build a new array every call, and a
  // fresh reference each time is a re-render on every unrelated store write.
  const fromPorts = useProcesses(
    useShallow((s) =>
      projectId
        ? (s.byProject[projectId] ?? EMPTY)
            .filter((r) => r.chatId === chatId)
            .map((r) => r.pid)
        : EMPTY_PIDS,
    ),
  );
  const fromShells = useTerminals(
    useShallow((s) =>
      Object.values(s.byId)
        .filter((t) => isLiveChatTerminal(t, chatId))
        .map((t) => t.pid)
        .filter((p): p is number => typeof p === "number"),
    ),
  );
  return useMemo(
    () => [...new Set([...fromShells, ...fromPorts])],
    [fromShells, fromPorts],
  );
}

/** Listeners nothing owns: the count worth surfacing before anything is expanded. */
export function useOrphanCount(projectId: string | undefined): number {
  return useProcesses((s) =>
    projectId ? (s.byProject[projectId] ?? EMPTY).filter((r) => !r.tracked).length : 0,
  );
}
