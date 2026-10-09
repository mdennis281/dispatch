/**
 * The global pause: stop every chat, hold the queue shut, optionally kill the
 * processes the chats left behind, and on resume tell each interrupted chat
 * what happened.
 *
 * The broker owns the mechanism (the gate in `schedule`, the interrupts); this
 * owns everything around it — persistence across a restart, the kill sweep, and
 * the resume note — so the broker never needs to know about terminals or the
 * process table.
 *
 * PERSISTED, PER INSTANCE. The state lives in `dataDir`, not `configDir`: the
 * stable and dev instances share config, and a pause clicked in a dev build
 * must not stop the instance trusted with long work. It is persisted at all
 * because the most likely thing to happen during a pause is a restart — and a
 * restart that silently lifted it would hand every held chat to
 * `RestartResumeService`, which would then start them all.
 */
import { pauseResumeNote, PauseStateSchema, type PauseState, type MessagePart } from "@dispatch/shared";
import { readJson, writeJsonAtomic } from "../store/fsq.js";
import type { SessionBroker } from "./session-broker.js";

export interface PauseServiceDeps {
  broker: SessionBroker;
  /** `<dataDir>/pause.json`. */
  file: string;
  /** Every chat currently holding processes (session or shells). */
  chatsWithProcesses: () => Promise<string[]>;
  /** Kill one chat's session subtree, shells and residue. */
  killChat: (chatId: string) => Promise<void>;
  /** Settle the process tally once the whole sweep is done. */
  afterKill?: (chatIds: string[]) => Promise<void>;
  /** Send to a chat, lazily re-creating its session (it may be long gone). */
  send: (chatId: string, text: string, opts: { parts: MessagePart[] }) => Promise<void>;
  now?: () => number;
}

export class PauseService {
  private readonly now: () => number;

  constructor(private readonly deps: PauseServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Boot: re-arm a pause that outlived the last process. Never throws. */
  async restore(): Promise<void> {
    try {
      const raw = await readJson(this.deps.file);
      if (raw === undefined || raw === null) return;
      const parsed = PauseStateSchema.safeParse(raw);
      if (parsed.success) this.deps.broker.restorePause(parsed.data);
    } catch (err) {
      // An unreadable file must not wedge boot; an un-restored pause is
      // recoverable by clicking Pause again, a dead server is not.
      console.error("[Dispatch] pause state unreadable (starting unpaused):", err);
    }
  }

  snapshot() {
    return this.deps.broker.schedulerSnapshot();
  }

  async pause(): Promise<PauseState> {
    const state = await this.deps.broker.pauseAll();
    await this.persist(state);
    return state;
  }

  /**
   * Kill every chat's processes. Only while paused: killing a RUNNING chat's
   * subprocess is just a crash with extra steps, and the resume note is what
   * tells the agent its shells are gone — without a pause there is no resume.
   */
  async killProcesses(): Promise<{ chatIds: string[] }> {
    if (!this.deps.broker.pause) throw new Error("not paused");
    const ids = await this.deps.chatsWithProcesses();
    // Settled, not all: one chat that won't die must not spare the rest.
    await Promise.allSettled(ids.map((id) => this.deps.killChat(id)));
    // Shell kills are fire-and-forget, so a scan right after the sweep still
    // sees them exiting — and caches that for the TTL. The panel then offers
    // to kill processes that are already gone. Seen on the first live run.
    await this.deps.afterKill?.(ids);
    const state = this.deps.broker.markKilled(ids);
    if (state) await this.persist(state);
    return { chatIds: ids };
  }

  /**
   * Lift the pause. The notes are sent while the gate is still shut so they
   * park as `queued` like everything else, then `resumeAll` moves those chats
   * to the head of the queue and opens it — the cap still applies, so twenty
   * interrupted chats do not all restart at once.
   */
  async resume(): Promise<{ notified: string[] }> {
    const state = this.deps.broker.pause;
    if (!state) return { notified: [] };
    const now = this.now();
    const notified: string[] = [];
    for (const chatId of state.interrupted) {
      const text = pauseResumeNote(state, chatId, now);
      try {
        // A `brief`, not bare text: nobody typed this, and rendered flat it
        // would sit in the human's speech bubble as though they wrote it.
        await this.deps.send(chatId, text, {
          parts: [{ kind: "brief", label: "Resumed after pause", text }],
        });
        notified.push(chatId);
      } catch (err) {
        // A deleted chat, or one whose project is gone. Resuming the rest
        // matters more than this one note.
        console.error(`[Dispatch] resume note to ${chatId} failed:`, err);
      }
    }
    this.deps.broker.resumeAll(notified);
    await this.persist(null);
    return { notified };
  }

  private async persist(state: PauseState | null): Promise<void> {
    await writeJsonAtomic(this.deps.file, state).catch((err: unknown) => {
      console.error("[Dispatch] failed to persist pause state:", err);
    });
  }
}
