/**
 * AUTO-RESUME AFTER A DELIBERATE RESTART.
 *
 * Updating Dispatch stops every agent mid-sentence. Until now that was simply
 * the end of them: `UpdatingScreen` says so in static copy ("Agents that were
 * mid-run are stopped with the server; their transcripts are intact"), and a
 * chat that had been working for twenty minutes came back as a dead row with no
 * way to pick it up but to read the transcript and re-type the ask. Every piece
 * needed to do better already existed — `chat.sessionId` is durable, both
 * adapters implement resume, `ResumeScheduler` is a working template for
 * "continue this chat later" — and nothing at boot pulled the trigger.
 *
 * ── How it knows the restart was deliberate ─────────────────────────────────
 * It doesn't detect anything. {@link capture} runs from `services.dispose()`,
 * which ONLY executes on a graceful teardown, so writing a record at all is the
 * proof. A crash, an OOM or a `taskkill /F` runs no shutdown handler and leaves
 * no record, and {@link restore} then finds nothing to do — those chats keep
 * today's behaviour and come back red. No uptime heuristic, no crash counter,
 * and structurally no way to get into a resume→crash→resume loop, because the
 * crash half can never write the ticket for the next round.
 *
 * "Was it an UPDATE specifically?" is answered separately and after the fact, by
 * comparing the build sha recorded at shutdown against the one now running. That
 * costs the stopping path no knowledge of why it was asked to stop — which is
 * what lets it cover `pnpm app:upgrade` (which tells the server nothing at all)
 * as well as the in-app installer.
 *
 * ── Why it is not part of ResumeScheduler ───────────────────────────────────
 * That service is a TIMER against a known future instant, persisted in the
 * single-slot `chat.resume`. This one has no instant to wait for (the moment is
 * "now, once we're listening") and must not fight it for that slot: a chat can
 * be waiting out a usage limit AND be interrupted by an update, and collapsing
 * the two would drop one of them.
 */
import {
  type Chat,
  type ChatInterruption,
  type MessagePart,
  type RestartResumeStatus,
} from "@dispatch/shared";
import type { Store } from "../store/index.js";
import type { EventBus } from "../bus.js";
import { readInstalledRelease } from "./release.js";

/**
 * How long an interruption stays resumable.
 *
 * A restart you watched happen is the case this exists for; a laptop that was
 * off for a week is not. Continuing a three-day-old turn means an agent acting
 * on a working tree that has since moved, against a PR that may already have
 * landed — worse than the dead row it replaced. Beyond this the record settles
 * as `skipped` and the chat is left exactly as it is today.
 */
export const RESUME_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Grace between the server answering and the first resumed turn.
 *
 * Resuming spawns agent process trees — a `claude` process plus its MCP children
 * each — and both `upgrade.mjs`'s health gate and `UpdatingScreen`'s reload poll
 * `/api/health`, so doing that with the port still closed reads as an update
 * that hung.
 *
 * `restore()` is therefore called from `start.ts` AFTER `app.listen()` resolves,
 * NOT from `services.start()`. Arming it inside `start()` did not hold: what
 * runs after it is unbounded — `runner.reconcile()` awaits a
 * `docker compose down` per persisted docker runner (routinely 5-30s), then the
 * terminal reconcile/sweep, then `seedDefaultsIfEmpty` and `ensureSetupState` —
 * and the timer fires from the event loop during any of those awaits. This
 * delay is breathing room ON TOP of a guarantee the CALL SITE provides.
 */
export const RESUME_START_DELAY_MS = 2_000;

/** Text sent when there is nothing of the human's left to replay. */
export function continuationPrompt(cause: "update" | "restart"): string {
  const why =
    cause === "update"
      ? "Dispatch was updated to a new build and restarted"
      : "The Dispatch server was restarted";
  return (
    `${why}, which cut your previous turn short part-way through. ` +
    "Before you continue: check the real state of whatever you had in flight — " +
    "files you were editing, a command you had just run, a PR you were opening — " +
    "because the last action may or may not have completed. " +
    "Then pick the task back up from where it actually stands, not from where you " +
    "assumed it was."
  );
}

export interface RestartResumeDeps {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  genId?: () => string;
  /** Build sha of the running payload; absent on a source checkout. */
  readSha?: () => string | undefined;
  startDelayMs?: number;
  maxAgeMs?: number;
}

export interface RestartResumeOpts {
  store: Store;
  bus: EventBus;
  /**
   * Deliver a message, ensuring a live session first — same seam and same
   * reason as `ResumeScheduler`: the subprocess is long gone by now, and how a
   * session gets rebuilt belongs to the route layer's `ensureSession`.
   */
  send: (chatId: string, text: string, parts?: MessagePart[]) => Promise<void>;
  /** Stop a resumed turn without tearing the session down (the undo button). */
  interrupt: (chatId: string) => Promise<void>;
  deps?: RestartResumeDeps;
}

/** One chat this boot acted on, for the banner. */
interface Settled {
  chatId: string;
  title: string;
  projectId: string;
  /** What it was doing when the server stopped. */
  was: ChatInterruption["status"];
  outcome: NonNullable<ChatInterruption["settledAs"]>;
}

export class RestartResumeService {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly send: RestartResumeOpts["send"];
  private readonly interrupt: RestartResumeOpts["interrupt"];
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly genId: () => string;
  private readonly readSha: () => string | undefined;
  private readonly startDelayMs: number;
  private readonly maxAgeMs: number;

  /**
   * What this boot resumed. In memory on purpose — it describes THIS process's
   * startup, so a banner that outlived the process it is reporting on would be
   * lying. The durable half is `settledAt` on each chat.
   */
  private settled: Settled[] = [];
  /**
   * chatId -> the attention id we raised for it, until the human speaks.
   *
   * Nothing else would ever clear these. `attention-resolve` is published in
   * only three places — the broker's permission path, `resolveIdleAttention`
   * (which clears ONLY `session.idleAttentionId`), and chat deletion — and the
   * popover's rows navigate rather than dismiss. Without this edge a `question`
   * item raised here outlives the answer it asked for, and since `question`
   * counts as blocking it inflates the header badge for the life of the process.
   */
  private readonly pendingAttention = new Map<string, string>();
  private offChatMessage?: () => void;
  private cause: "update" | "restart" = "restart";
  private ranAt: number | null = null;
  private dismissed = false;
  private timer: unknown;
  private inflight: Promise<void> | null = null;
  private disposed = false;

  constructor(opts: RestartResumeOpts) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.send = opts.send;
    this.interrupt = opts.interrupt;
    this.now = opts.deps?.now ?? (() => Date.now());
    this.setTimer =
      opts.deps?.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // A pending resume must never be the reason the process won't exit.
        (t as unknown as { unref?: () => void }).unref?.();
        return t;
      });
    this.clearTimer =
      opts.deps?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.genId = opts.deps?.genId ?? (() => Math.random().toString(36).slice(2, 11));
    this.readSha = opts.deps?.readSha ?? (() => readInstalledRelease()?.sha ?? undefined);
    this.startDelayMs = opts.deps?.startDelayMs ?? RESUME_START_DELAY_MS;
    this.maxAgeMs = opts.deps?.maxAgeMs ?? RESUME_MAX_AGE_MS;
  }

  /* ------------------------------------------------------------- shutdown */

  /**
   * Persist a resume ticket for every chat that was mid-flight.
   *
   * MUST be called before `broker.dispose()`, with a snapshot taken from
   * `broker.interruptionSnapshot()`: teardown overwrites each status with `done`
   * and empties every outbox, so afterwards there is nothing left to record.
   *
   * Best-effort per chat. One unwritable record must not stop the other chats
   * getting theirs, and none of it may stop the shutdown — this runs inside the
   * 20s grace window that also has to tree-kill subApps and flush transcripts.
   */
  async capture(
    live: Array<{ chatId: string; status: string; pending: string[] }>,
  ): Promise<number> {
    const sha = safely(() => this.readSha());
    const at = this.now();
    let written = 0;
    for (const entry of live) {
      const status = asInterruptedStatus(entry.status);
      if (!status) continue;
      try {
        const chat = await this.store.getChat(entry.chatId);
        if (!chat || chat.archived) continue;
        const interruption: ChatInterruption = {
          at,
          status,
          pending: entry.pending,
          ...(sha ? { sha } : {}),
        };
        // `patchChat`, never a get-then-save of the whole record: this runs
        // BEFORE `broker.dispose()`, so a live session's `writeChain` may still
        // be flushing `status` / `lastUserMessageAt` patches. A whole-file
        // rewrite from out here would put the pre-flush record back.
        //
        // No bus publish: every client is being told the server is going away,
        // and a `chat-update` racing the socket close is noise at best.
        if (await this.store.patchChat(entry.chatId, { interruption })) written += 1;
      } catch {
        /* one unwritable record must not cost the others theirs */
      }
    }
    return written;
  }

  /* ----------------------------------------------------------------- boot */

  /**
   * Arm the boot pass. Returns immediately — the work happens on a short timer
   * so the server is listening before any agent subprocess is spawned (see
   * {@link RESUME_START_DELAY_MS}).
   */
  restore(): void {
    if (this.disposed) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      // `.catch` on the promise itself, not around an await: this runs from a
      // timer with no caller, so an unhandled rejection here would be fatal to
      // the process. `drain()` only attaches a handler later, if ever.
      this.inflight = this.run()
        .catch(() => {})
        .finally(() => {
          this.inflight = null;
        });
    }, this.startDelayMs);
  }

  /** Wait for an armed boot pass to finish (tests + shutdown). */
  async drain(): Promise<void> {
    while (this.inflight) await this.inflight;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    this.offChatMessage?.();
    this.offChatMessage = undefined;
    this.pendingAttention.clear();
  }

  /* --------------------------------------------------------------- banner */

  /** What this boot did, for the banner. `null` once there is nothing to say. */
  status(): RestartResumeStatus | null {
    if (this.dismissed || this.ranAt === null) return null;
    const resumed = this.settled.filter((s) => s.outcome === "resumed");
    const needsInput = this.settled.filter((s) => s.outcome === "needs-input");
    if (resumed.length === 0 && needsInput.length === 0) return null;
    return {
      at: this.ranAt,
      cause: this.cause,
      resumed: resumed.map(toEntry),
      needsInput: needsInput.map(toEntry),
    };
  }

  /** Hide the banner for the rest of this process's life. */
  dismiss(): void {
    this.dismissed = true;
    this.publish();
  }

  /**
   * The undo: stop every turn this boot started on its own.
   *
   * `interrupt`, not `stop` — the point is to take back the continuation WE
   * sent, not to tear down a session the human may now want to steer by hand.
   * Returns the chat ids it interrupted.
   */
  async stopResumed(): Promise<string[]> {
    const ids = this.settled.filter((s) => s.outcome === "resumed").map((s) => s.chatId);
    for (const id of ids) {
      await this.interrupt(id).catch(() => {});
      await this.notice(id, "Auto-resume stopped — this chat is yours again.");
    }
    this.dismissed = true;
    this.publish();
    return ids;
  }

  /* ------------------------------------------------------------ internals */

  private async run(): Promise<void> {
    if (this.disposed) return;
    this.ranAt = this.now();
    const chats = await this.store.listChats().catch(() => [] as Chat[]);
    const pending = chats.filter((c) => c.interruption && !c.interruption.settledAt);
    if (pending.length === 0) return;

    // Derived once, from any record: they all come from the same shutdown, so
    // one comparison answers it for the whole batch.
    const sha = safely(() => this.readSha());
    const recorded = pending.find((c) => c.interruption?.sha)?.interruption?.sha;
    this.cause = sha && recorded && sha !== recorded ? "update" : "restart";

    // Sequential, not `Promise.all`. Each resume spawns an agent process tree
    // (~1.3 GB with its MCP children), and `sendMessage` does real async work
    // before the spawn — memory surfacing, config reads. The broker's own cap
    // parks the overflow as `queued`, but starting fifteen of these in the same
    // tick is how a boot turns into a swap storm on the way to that cap.
    for (const chat of pending) {
      if (this.disposed) return;
      await this.settle(chat).catch(() => {});
    }
    this.publish();
  }

  private async settle(chat: Chat): Promise<void> {
    const record = chat.interruption;
    if (!record) return;
    const outcome = this.classify(chat, record);

    if (outcome === "needs-input") {
      await this.mark(chat.id, record, "needs-input");
      this.remember(chat, record, "needs-input");
      await this.notice(
        chat.id,
        "This chat was waiting on you when Dispatch restarted, so it was not " +
          "continued automatically — the prompt it was blocked on is gone. " +
          "Send a message to pick it back up.",
      );
      // The Attention Queue is the app's whole answer to "which chat needs you",
      // and this chat needs a human by construction. `question` rather than
      // `idle`: it is unfinished work blocked on a person, which is what that
      // weight means, and it must not sort below a finished-turn notice.
      const attentionId = `interrupted:${chat.id}:${record.at}`;
      this.pendingAttention.set(chat.id, attentionId);
      this.watchForReplies();
      this.bus.publish({
        type: "attention-add",
        item: {
          id: attentionId,
          chatId: chat.id,
          projectId: chat.projectId,
          kind: "question",
          summary: "Interrupted by a restart while waiting on you",
          createdAt: this.now(),
        },
      });
      return;
    }

    if (outcome === "skipped") {
      await this.mark(chat.id, record, "skipped");
      return;
    }

    try {
      await this.resume(chat, record);
      await this.mark(chat.id, record, "resumed");
      this.remember(chat, record, "resumed");
    } catch (err) {
      await this.mark(chat.id, record, "failed");
      await this.notice(
        chat.id,
        `Could not continue automatically after the restart: ${
          err instanceof Error ? err.message : String(err)
        }`,
        "error",
      );
    }
  }

  private classify(
    chat: Chat,
    record: ChatInterruption,
  ): "resumed" | "needs-input" | "skipped" {
    // Archived since the shutdown — somebody has already decided this is over.
    if (chat.archived) return "skipped";
    if (this.now() - record.at > this.maxAgeMs) return "skipped";
    // Blocked on a human. The permission prompt / question it was waiting on
    // died with the process, so "continue" would mean answering a question that
    // no longer exists — and the agent could re-take an action it believed had
    // been approved. Hand it back instead.
    if (record.status === "awaiting-input") return "needs-input";
    // Nothing to resume INTO and nothing of the human's to replay: a bare
    // "carry on" to a model with no context is noise, not a continuation.
    if (!chat.sessionId && record.pending.length === 0) return "skipped";
    return "resumed";
  }

  private async resume(chat: Chat, record: ChatInterruption): Promise<void> {
    const cause = this.cause;
    const what = cause === "update" ? "Dispatch updated and restarted" : "Dispatch restarted";
    // A replayed message is ALREADY in the transcript: `sendMessage` emits the
    // `user` row BEFORE pushing to the outbox (which is why a `queued` session
    // has a populated outbox at all), so the replay appends a second, identical
    // row. Say so, or the human sees their own sentence twice with nothing to
    // mark which copy the agent never got.
    await this.notice(
      chat.id,
      record.pending.length > 0
        ? what +
            (record.pending.length === 1
              ? " — the message above never reached the agent, so it is being sent again."
              : " — the messages above never reached the agent, so they are being sent again.")
        : what + " — continuing this chat automatically.",
    );

    // A message the human already typed but the runtime never received is a
    // better continuation than anything we could compose, so replay it verbatim
    // and as THEIRS. Sending it as a `brief` would file their own words under
    // Dispatch's name in the transcript.
    if (record.pending.length > 0) {
      for (const text of record.pending) await this.send(chat.id, text);
      return;
    }

    const prompt = continuationPrompt(cause);
    // A `brief`, not bare text: nobody typed this. Rendered flat it lands in the
    // human's speech bubble and the chat reads as though they came back and
    // asked it to carry on. A lone brief composes to its own text, so the model
    // receives exactly the prompt above.
    await this.send(chat.id, prompt, [
      {
        kind: "brief",
        label: cause === "update" ? "Resumed after update" : "Resumed after restart",
        text: prompt,
      },
    ]);
  }

  /**
   * Resolve our attention item the moment the human answers.
   *
   * Subscribed lazily — a boot that resumed everything raises no items and pays
   * for no listener — and torn down again once the last one clears, so it never
   * outlives the thing it is watching for.
   */
  private watchForReplies(): void {
    if (this.offChatMessage || this.disposed) return;
    this.offChatMessage = this.bus.on("chat-message", (evt) => {
      if (evt.message?.kind !== "user") return;
      const id = this.pendingAttention.get(evt.chatId);
      if (!id) return;
      this.pendingAttention.delete(evt.chatId);
      this.bus.publish({ type: "attention-resolve", id, chatId: evt.chatId });
      if (this.pendingAttention.size === 0) {
        this.offChatMessage?.();
        this.offChatMessage = undefined;
      }
    });
  }

  private remember(
    chat: Chat,
    record: ChatInterruption,
    outcome: Settled["outcome"],
  ): void {
    this.settled.push({
      chatId: chat.id,
      title: chat.title,
      projectId: chat.projectId,
      was: record.status,
      outcome,
    });
  }

  /**
   * Stamp the record settled. Durable and BEFORE the send where it matters:
   * an unsettled record is replayed by the next boot, so a resume that starts a
   * turn and then loses the process would otherwise send its continuation twice.
   */
  private async mark(
    chatId: string,
    record: ChatInterruption,
    settledAs: NonNullable<ChatInterruption["settledAs"]>,
  ): Promise<void> {
    try {
      // `patchChat` merges under the chat's lock. A get-then-save pair here
      // races the resume we just started: `sendMessage` returns WITHOUT awaiting
      // its own writes — it queues `patchChat({ lastUserMessageAt })` and
      // `setStatus(running)` onto the session's `writeChain` — so a whole-record
      // rewrite from out here can land on top and persist `status: "done"` for
      // a chat whose turn is actually running.
      const saved = await this.store.patchChat(chatId, {
        interruption: { ...record, settledAt: this.now(), settledAs },
      });
      if (saved) this.bus.publish({ type: "chat-update", chat: saved });
    } catch {
      /* the resume itself already happened; a lost stamp costs a re-run at most */
    }
  }

  /** Drop a transcript marker so a self-started turn has a visible cause. */
  private async notice(
    chatId: string,
    text: string,
    level: "info" | "error" = "info",
  ): Promise<void> {
    try {
      const row = await this.store.appendMessage({
        kind: "notice",
        id: this.genId(),
        chatId,
        ts: this.now(),
        level,
        text,
      });
      this.bus.publish({ type: "chat-message", chatId, message: row });
    } catch {
      /* a missing transcript must not break the resume itself */
    }
  }

  private publish(): void {
    this.bus.publish({ type: "restart-resume", status: this.status() });
  }
}

/* ------------------------------------------------------------------ helpers */

function toEntry(s: Settled): RestartResumeStatus["resumed"][number] {
  return { chatId: s.chatId, title: s.title, projectId: s.projectId, was: s.was };
}

/** Narrow a broker status string to the four an interruption can record. */
function asInterruptedStatus(s: string): ChatInterruption["status"] | null {
  return s === "running" || s === "waiting" || s === "awaiting-input" || s === "queued"
    ? s
    : null;
}

/** `readSha` reads the filesystem; a missing manifest must not fail a shutdown. */
function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
