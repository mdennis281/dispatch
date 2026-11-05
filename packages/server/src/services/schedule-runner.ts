/**
 * ScheduleRunner — fires each project's `.dispatch/schedules/*.md` as a fresh
 * chat when its cron comes due.
 *
 * What it is careful about, in the order that bites a timer like this:
 *
 * - **Two instances, one repo.** Stable and dev share `config/` and the repo's
 *   `.dispatch/`, so both load every schedule — but not `data/`, so neither sees
 *   the other's run state. Both firing would double every run. Only the
 *   instance `active` names fires (the installed app; see the container), the
 *   same line the issue watcher draws. "Run now" ignores it: that is a human
 *   asking, not a timer.
 * - **At most once per slot.** The slot is recorded as honoured BEFORE the chat
 *   is started. A crash between the two then costs one run rather than causing
 *   a duplicate on reboot — for a job nobody is watching, a missing run shows up
 *   in the history while a duplicate does real work twice.
 * - **Missed slots fire once, not N times.** See `scheduleDue`: a laptop asleep
 *   for a week on an hourly schedule wakes to ONE catch-up run, or none.
 * - **No pile-ups.** A slot that comes due while the previous run is still
 *   working (or waiting on the human) is passed over and says so, rather than
 *   stacking a second chat onto the same job.
 * - **A failure doesn't retry every tick.** A launch that throws (no provider, a
 *   persona that was deleted) records its error against the slot and waits for
 *   the next one, so a broken schedule shows one error instead of a spawn loop.
 *
 * Spawning goes through an injected `spawn`, so this file never learns what a
 * chat is beyond the fields it lists.
 */
import {
  describeCron,
  formatLocalTime,
  isChatWorking,
  MISSED_COUNT_CAP,
  realProjects,
  scheduleDue,
  nextFireAfter,
  type Chat,
  type MessagePart,
  type Schedule,
  type ScheduleRun,
  type ScheduleState,
  type ScheduleTrigger,
  type ScheduleView,
} from "@dispatch/shared";
import type { Store } from "../store/index.js";

/** How often the timer ticks. Each schedule then decides whether it is due. */
export const SCHEDULE_TICK_MS = 30_000;

/** Past runs a view lists. */
const RUNS_LISTED = 20;

/** Past runs a new run's briefing names inline; the rest are a `chat_find` away. */
export const RUNS_BRIEFED = 5;

export interface ScheduleSpawn {
  projectId: string;
  schedule: Schedule;
  trigger: ScheduleTrigger;
  /** Newest first, at most {@link RUNS_BRIEFED}. */
  previous: ScheduleRun[];
  /** 1-based: this run's position in the schedule's history. */
  runNumber: number;
}

export interface ScheduleRunnerOptions {
  store: Pick<
    Store,
    "listProjects" | "listChats" | "getChat" | "listScheduleStates" | "getScheduleState" | "saveScheduleState"
  >;
  /** The project's loaded schedules. */
  schedulesFor: (projectId: string) => Schedule[];
  /** Start the run's chat. Throws with a human-readable reason when it can't. */
  spawn: (input: ScheduleSpawn) => Promise<{ chatId: string }>;
  /** Whether THIS process fires on the timer. Read per tick, never cached. */
  active?: () => boolean;
  tickMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** What one schedule's check did on a pass. For tests and the run-now reply. */
export interface ScheduleOutcome {
  projectId: string;
  scheduleId: string;
  action: "wait" | "fired" | "skipped" | "failed" | "seen";
  chatId?: string;
  reason?: string;
}

/** A chat that is still on the job — working, or blocked on the human. */
function stillGoing(chat: Pick<Chat, "status"> | null): boolean {
  return !!chat && (isChatWorking(chat.status) || chat.status === "awaiting-input");
}

export class ScheduleRunner {
  private readonly opts: ScheduleRunnerOptions;
  private readonly store: ScheduleRunnerOptions["store"];
  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<ScheduleRunnerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<ScheduleRunnerOptions["clearTimer"]>;

  private timer: unknown;
  private running = false;
  private disposed = false;
  /** Passes and manual runs go one at a time, so two can't both claim a slot. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: ScheduleRunnerOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.tickMs = opts.tickMs ?? SCHEDULE_TICK_MS;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setInterval(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer = opts.clearTimer ?? ((h) => clearInterval(h as NodeJS.Timeout));
  }

  /** Does this instance fire on the timer? */
  get active(): boolean {
    return this.opts.active?.() ?? true;
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.timer = this.setTimer(() => void this.sweep().catch(() => {}), this.tickMs);
    // First pass now rather than a tick from now: it is the one that notices
    // slots missed while the app was off, and catch-up should not wait.
    void this.sweep().catch(() => {});
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  async drain(): Promise<void> {
    await this.chain.catch(() => {});
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** One pass over every project's schedules. */
  sweep(): Promise<ScheduleOutcome[]> {
    return this.serial(() => this.runSweep());
  }

  /**
   * Start a run NOW, regardless of cadence, `enabled`, or which instance this
   * is. Leaves `lastFireAt` alone — a manual run is extra, not the next slot,
   * so the schedule keeps its rhythm.
   */
  runNow(projectId: string, scheduleId: string): Promise<{ chatId: string }> {
    return this.serial(async () => {
      const schedule = this.opts.schedulesFor(projectId).find((s) => s.id === scheduleId);
      if (!schedule) throw new Error(`no schedule "${scheduleId}" in this project`);
      const now = this.now();
      const state = (await this.store.getScheduleState(projectId, scheduleId)) ?? {
        projectId,
        scheduleId,
        firstSeenAt: now,
      };
      return this.launch(projectId, schedule, state, "manual", now);
    });
  }

  /** Every schedule in a project with its state, next fire and past runs. */
  async list(projectId: string): Promise<ScheduleView[]> {
    const schedules = this.opts.schedulesFor(projectId);
    if (!schedules.length) return [];
    const [states, chats] = await Promise.all([
      this.store.listScheduleStates(projectId).catch(() => []),
      this.store.listChats(projectId).catch(() => []),
    ]);
    const stateOf = new Map(states.map((s) => [s.scheduleId, s]));
    const now = this.now();
    return schedules.map((schedule) => {
      const state = stateOf.get(schedule.id) ?? null;
      return {
        schedule,
        state,
        nextRunAt: schedule.enabled
          ? nextFireAfter(schedule.cron, Math.max(now, state?.lastFireAt ?? 0), schedule.timezone)
          : null,
        runs: runsOf(chats, schedule.id).slice(0, RUNS_LISTED),
      };
    });
  }

  private async runSweep(): Promise<ScheduleOutcome[]> {
    if (this.disposed || !this.active) return [];
    const out: ScheduleOutcome[] = [];
    for (const project of realProjects(await this.store.listProjects().catch(() => []))) {
      const schedules = this.opts.schedulesFor(project.id);
      if (!schedules.length) continue;
      const states = new Map(
        (await this.store.listScheduleStates(project.id).catch(() => [])).map((s) => [s.scheduleId, s]),
      );
      for (const schedule of schedules) {
        if (this.disposed) return out;
        out.push(await this.check(project.id, schedule, states.get(schedule.id) ?? null));
      }
    }
    return out;
  }

  private async check(projectId: string, schedule: Schedule, state: ScheduleState | null): Promise<ScheduleOutcome> {
    const base = { projectId, scheduleId: schedule.id };
    const now = this.now();
    if (!state) {
      // First sighting: start the clock. Nothing before now counts as missed.
      await this.store.saveScheduleState({ projectId, scheduleId: schedule.id, firstSeenAt: now });
      return { ...base, action: "seen" };
    }
    const due = scheduleDue(schedule, state, now);
    if (due.action === "wait") return { ...base, action: "wait" };

    const pass = async (reason: string): Promise<ScheduleOutcome> => {
      await this.store.saveScheduleState({ ...state, lastFireAt: due.slot, lastSkip: reason });
      return { ...base, action: "skipped", reason };
    };
    // A disabled schedule still CONSUMES its slots. Otherwise re-enabling it
    // would find every slot since it was switched off "missed" and fire a
    // catch-up the moment the box is ticked.
    if (!schedule.enabled) return pass("disabled");
    if (due.action === "skip") {
      const n = due.missed >= MISSED_COUNT_CAP ? `${MISSED_COUNT_CAP}+` : String(due.missed);
      return pass(`missed ${n} run${due.missed === 1 ? "" : "s"} while Dispatch was not running (catch-up is off)`);
    }
    const last = state.lastChatId ? await this.store.getChat(state.lastChatId).catch(() => null) : null;
    if (stillGoing(last)) return pass("the previous run was still going");

    try {
      const { chatId } = await this.launch(projectId, schedule, state, due.action === "fire" ? "schedule" : "catch-up", now, due.slot);
      return { ...base, action: "fired", chatId };
    } catch (err) {
      return { ...base, action: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Claim the slot (if any), then start the chat. Throws on a failed launch,
   * AFTER recording it.
   */
  private async launch(
    projectId: string,
    schedule: Schedule,
    state: ScheduleState,
    trigger: ScheduleTrigger,
    now: number,
    slot?: number,
  ): Promise<{ chatId: string }> {
    const claimed: ScheduleState = slot === undefined ? state : { ...state, lastFireAt: slot };
    if (slot !== undefined) await this.store.saveScheduleState(claimed);

    const all = runsOf(await this.store.listChats(projectId).catch(() => []), schedule.id);
    try {
      const { chatId } = await this.opts.spawn({
        projectId,
        schedule,
        trigger,
        previous: all.slice(0, RUNS_BRIEFED),
        runNumber: all.length + 1,
      });
      const { lastError: _e, lastSkip: _s, ...rest } = claimed;
      await this.store.saveScheduleState({ ...rest, lastRunAt: now, lastChatId: chatId, lastTrigger: trigger });
      return { chatId };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.store.saveScheduleState({ ...claimed, lastError: reason, lastTrigger: trigger }).catch(() => {});
      throw err;
    }
  }
}

/** A schedule's past runs, newest first. */
function runsOf(chats: Chat[], scheduleId: string): ScheduleRun[] {
  return chats
    .filter((c) => c.scheduleId === scheduleId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((c) => ({
      chatId: c.id,
      title: c.title,
      status: c.status ?? "idle",
      createdAt: c.createdAt,
      ...(c.archived ? { archived: true } : {}),
    }));
}

/* ------------------------------------------------------------- briefing */

const TRIGGER_TEXT: Record<ScheduleTrigger, string> = {
  schedule: "on schedule",
  "catch-up": "as a catch-up — Dispatch was not running when the last slot came due",
  manual: "by hand (Run now)",
};

/**
 * The run chat's title: `**<schedule name>**: 2026-11-04 09:00 CST`. The time
 * is the body because it is what tells one run from the next in a list that is
 * otherwise the same name forty times.
 */
export function scheduleRunTitle(schedule: Pick<Schedule, "name">, now: number): string {
  return `**${schedule.name}**: ${formatLocalTime(now, undefined, { seconds: false })}`;
}

/**
 * The run's first message. The app's framing goes in a `brief` part (rendered
 * as Dispatch talking, not the human); the authored prompt goes in as
 * `instructions`, since a human did write it.
 *
 * The brief exists for one reason the human asked for explicitly: a run is a
 * FRESH chat, so on its own it knows nothing about the previous ones. It names
 * the recent runs inline and says how to search the rest, so "what changed since
 * last time" is one tool call rather than something the agent has to think of.
 */
export function scheduleRunParts(input: ScheduleSpawn & { projectName?: string }): MessagePart[] {
  const { schedule, trigger, previous, runNumber, projectId } = input;
  const lines: string[] = [
    `This chat was started by the scheduled chat **${schedule.name}** (\`${schedule.id}\`, ` +
      `${describeCron(schedule.cron).replace(/^./, (c) => c.toLowerCase())}), ${TRIGGER_TEXT[trigger]}. ` +
      `This is run #${runNumber}. Nobody watched it start, so whatever you report is what the human reads later.`,
    "",
  ];
  if (previous.length) {
    lines.push(`Previous runs, newest first (each was its own chat):`);
    for (const r of previous) {
      lines.push(
        `- \`${r.chatId}\` — ${formatLocalTime(r.createdAt, undefined, { seconds: false })}, ${r.status}` +
          (r.archived ? " (archived)" : ""),
      );
    }
    lines.push(
      "",
      "Before you start, look at what the last run found or did, so this run builds on it rather than repeating it:",
      `- \`mcp__dispatch-chat__chat_read({ chatId: "<id>" })\` opens one of those runs (digest view by default).`,
      `- \`mcp__dispatch-chat__chat_find({ project: "${projectId}", schedule: "${schedule.id}" })\` lists every earlier run; ` +
        `add \`query: "<words>"\` to search their transcripts${previous.length >= RUNS_BRIEFED ? " — there may be more than the ones above" : ""}.`,
    );
  } else {
    lines.push(
      "This is the first run of this schedule — there is no earlier run to build on. Later runs will be pointed at this chat, " +
        "so end with a short summary of what you found and did.",
    );
  }
  return [
    { kind: "brief", label: `Scheduled run — ${schedule.name}`, text: lines.join("\n") },
    { kind: "instructions", label: "Scheduled prompt", text: schedule.prompt },
  ];
}

