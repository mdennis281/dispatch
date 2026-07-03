import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { RunnerInstance } from "@cm/shared";

export interface RunnerLogLine {
  stream: "stdout" | "stderr";
  line: string;
  ts: number;
}

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
