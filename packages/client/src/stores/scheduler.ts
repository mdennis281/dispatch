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
import { useNotices } from "./notices.js";

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
  /** Start one queued chat now, past the cap and ahead of the queue. */
  runNow: (chatId: string) => Promise<void>;
  /**
   * Scoped pauses with a request in flight, keyed `project:<id>` / `chat:<id>`
   * — per target, see below.
   */
  scopedBusy: Record<string, true>;
  pauseProject: (projectId: string) => Promise<void>;
  resumeProject: (projectId: string) => Promise<void>;
  pauseChat: (chatId: string) => Promise<void>;
  resumeChat: (chatId: string) => Promise<void>;
  /** Lift every project and chat pause — never the global one. */
  resumeAllScoped: () => Promise<void>;
}

export const useScheduler = create<SchedulerStore>((set, get) => {
  async function run<T>(which: Exclude<Busy, null>, fn: () => Promise<T>): Promise<T | undefined> {
    if (get().busy) return undefined;
    set({ busy: which });
    try {
      return await fn();
    } catch (err) {
      // Every caller fires and forgets, so this is the only place a failure can
      // surface — and a silent failure here means someone pressed the
      // emergency stop and watched the button flip back with nothing stopped.
      useNotices.getState().push({
        level: "error",
        text: `${which === "pause" ? "Pause" : which === "resume" ? "Resume" : "Kill"} failed`,
        detail: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    } finally {
      // Re-read rather than wait for the push: the push is debounced, and a
      // button that still says "Pause" a beat after you pressed it reads as
      // not having worked. After a failure it shows what actually happened.
      await get().load();
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
    // Not through `run`: that gate is one-at-a-time for the global controls,
    // and a per-chat override must not be swallowed because a pause is in
    // flight elsewhere (nor block one).
    runNow: async (chatId) => {
      try {
        await api.scheduler.runNow(chatId);
      } catch (err) {
        useNotices.getState().push({
          level: "error",
          text: "Couldn't start that chat",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      await get().load();
    },
    // Per target rather than through `run`: toggling two projects in a row
    // is the normal use, and the one-at-a-time gate would drop the second
    // click while the first's interrupts land.
    scopedBusy: {},
    pauseProject: (id) =>
      scopedToggle(`project:${id}`, "Pause project", () => api.scheduler.pauseProject(id)),
    resumeProject: (id) =>
      scopedToggle(`project:${id}`, "Resume project", () => api.scheduler.resumeProject(id)),
    pauseChat: (id) => scopedToggle(`chat:${id}`, "Pause chat", () => api.scheduler.pauseChat(id)),
    resumeChat: (id) => scopedToggle(`chat:${id}`, "Resume chat", () => api.scheduler.resumeChat(id)),
    resumeAllScoped: async () => {
      await run("resume", () => api.scheduler.resumeAllScoped());
    },
  };

  async function scopedToggle(key: string, label: string, fn: () => Promise<unknown>) {
    if (get().scopedBusy[key]) return;
    set((s) => ({ scopedBusy: { ...s.scopedBusy, [key]: true } }));
    try {
      await fn();
    } catch (err) {
      useNotices.getState().push({
        level: "error",
        text: `${label} failed`,
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await get().load();
      set((s) => {
        const { [key]: _, ...rest } = s.scopedBusy;
        return { scopedBusy: rest };
      });
    }
  }
});
