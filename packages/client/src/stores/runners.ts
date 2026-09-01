import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { RunnerInstance, RunnerLogLine } from "@dispatch/shared";

export type { RunnerLogLine } from "@dispatch/shared";

interface RunnersStore {
  byId: Record<string, RunnerInstance>;
  order: string[];
  logs: Record<string, RunnerLogLine[]>;

  hydrate: (runners: RunnerInstance[], logs?: Record<string, RunnerLogLine[]>) => void;
  upsert: (runner: RunnerInstance) => void;
  appendLog: (runnerId: string, line: RunnerLogLine) => void;
}

const LOG_CAP = 500;

export const useRunners = create<RunnersStore>((set) => ({
  byId: {},
  order: [],
  logs: {},

  hydrate: (runners, logs = {}) => {
    const byId: Record<string, RunnerInstance> = {};
    for (const r of runners) byId[r.id] = r;
    set({ byId, order: runners.map((r) => r.id), logs });
  },

  upsert: (runner) =>
    set((s) => ({
      byId: { ...s.byId, [runner.id]: runner },
      order: s.order.includes(runner.id) ? s.order : [...s.order, runner.id],
    })),

  appendLog: (runnerId, line) =>
    set((s) => {
      const next = [...(s.logs[runnerId] ?? []), line];
      if (next.length > LOG_CAP) next.splice(0, next.length - LOG_CAP);
      return { logs: { ...s.logs, [runnerId]: next } };
    }),
}));

/**
 * Does this runner belong on THIS chat's Apps tab?
 *
 * `chatId` on a runner is a provenance tag, not ownership — nothing on the
 * server keys lifecycle off it (a runner outlives the chat that started it and
 * is only stopped explicitly or by `runner.stopAll()` at shutdown). The
 * Sidebar's Apps section is deliberately project-scoped and launches with no
 * chatId at all, which put those runners in exactly NO panel: the sidebar's own
 * rows find them by branch, but the right panel filtered on
 * `chatId === chat.id` and dropped them, so the logs, the URL, the port and
 * even Stop were unreachable for a subApp the user had just started from the
 * sidebar two seconds earlier.
 *
 * Hence: this chat's own runners PLUS ACTIVE project-level ones. Completed
 * project-level history belongs to the project, not every chat: including it
 * made each Apps tab accumulate the same long roster of stopped processes. A
 * runner owned by a DIFFERENT chat stays out — it has a panel of its own.
 */
export function belongsToChat(
  r: RunnerInstance,
  chatId: string,
  projectId: string | undefined,
): boolean {
  if (r.chatId) return r.chatId === chatId;
  const active =
    r.status === "starting" || r.status === "running" || r.status === "stopping";
  return active && !!projectId && r.projectId === projectId;
}

/** Selector: runners scoped to a chat (right-panel "Apps"). */
export function useChatRunners(chatId: string | null): RunnerInstance[] {
  return useRunners(
    useShallow((s) =>
      s.order
        .map((id) => s.byId[id]!)
        .filter((r): r is RunnerInstance => !!r && (!chatId || r.chatId === chatId)),
    ),
  );
}
