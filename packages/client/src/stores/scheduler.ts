/**
 * The app-wide scheduler: what is running, what is queued, and whether a
 * global pause is holding it all.
 *
 * Server truth, pushed. The broker broadcasts a `scheduler` snapshot whenever
 * membership changes, because queue ORDER and slot occupancy exist only on the
 * server — per-chat `status` alone can say a chat is queued but not where, and
 * not whether a running chat is actually holding a slot or blocked on CI.
 */
import { create } from "zustand";
import type { SchedulerSnapshot } from "@dispatch/shared";
import { api } from "../lib/api.js";

type Busy = "pause" | "resume" | "kill" | null;

interface SchedulerStore {
  snapshot: SchedulerSnapshot | null;
  /** Which control is in flight — one at a time, so nothing double-fires. */
  busy: Busy;
  set: (snapshot: SchedulerSnapshot) => void;
  load: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  /** Kill every chat's processes; resolves to how many chats were reaped. */
  kill: () => Promise<number>;
}

export const useScheduler = create<SchedulerStore>((set, get) => {
  async function run<T>(which: Exclude<Busy, null>, fn: () => Promise<T>): Promise<T | undefined> {
    if (get().busy) return undefined;
    set({ busy: which });
    try {
      const out = await fn();
      // Re-read rather than wait for the push: the push is debounced, and a
      // button that still says "Pause" a beat after you pressed it reads as
      // not having worked.
      await get().load();
      return out;
    } finally {
      set({ busy: null });
    }
  }
  return {
    snapshot: null,
    busy: null,
    set: (snapshot) => set({ snapshot }),
    load: async () => {
      try {
        set({ snapshot: await api.scheduler.get() });
      } catch {
        // Best-effort: an older server has no route and the control hides.
      }
    },
    pause: async () => {
      await run("pause", () => api.scheduler.pause());
    },
    resume: async () => {
      await run("resume", () => api.scheduler.resume());
    },
    kill: async () => (await run("kill", () => api.scheduler.kill()))?.chatIds.length ?? 0,
  };
});
