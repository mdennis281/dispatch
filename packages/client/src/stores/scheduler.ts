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
import type { ChatStatus, SchedulerSnapshot } from "@dispatch/shared";
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

/**
 * The status a chat is DRAWN with, which is not always the one it has.
 *
 * A chat whose blocking call has answered (`watch_pr` saw CI finish, a `wait`
 * ran out) but which gave its slot up while it was blocked is parked to RESUME:
 * the broker holds the answer until a slot frees. Its status stays `waiting`,
 * and must — the turn is live, so a message still steers it instead of opening
 * a new one. But drawn as Waiting it sat beside every chat still parked on CI,
 * and the two want opposite things from the human: this one is done waiting
 * and Run now lets it finish; the other has nothing to run yet. So it is drawn
 * as what it is — back in the scheduler's queue.
 *
 * Any turn-live status, not just `waiting`: a permission answered while the
 * cap is full parks the same way with the status still `awaiting-input`, and a
 * card that is genuinely still open is marked by the attention store on its
 * own, so nothing a human must act on is hidden by reading Queued here.
 */
export function displayStatus(
  status: ChatStatus | undefined,
  resumeQueued: boolean,
): ChatStatus | undefined {
  if (!resumeQueued) return status;
  return status === "waiting" || status === "running" || status === "awaiting-input"
    ? "queued"
    : status;
}

/** Does the scheduler hold this chat's answer until it gets a slot back? */
export function isResumeQueued(snapshot: SchedulerSnapshot | null, chatId: string): boolean {
  return snapshot?.queued.some((q) => q.chatId === chatId && q.kind === "resume") ?? false;
}

/**
 * {@link displayStatus} for one row. The selector returns a boolean, so a
 * scheduler push re-renders only the rows whose answer flipped — the sidebar
 * draws hundreds of these.
 */
export function useDisplayStatus(chatId: string, status: ChatStatus | undefined): ChatStatus | undefined {
  const resumeQueued = useScheduler((s) => isResumeQueued(s.snapshot, chatId));
  return displayStatus(status, resumeQueued);
}
