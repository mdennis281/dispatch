/**
 * One Codex thread, presented as a {@link HarnessSession}.
 *
 * LIFECYCLE. Nothing is spawned until the first `send`, matching the Claude
 * adapter — a queued chat must cost nothing. On that first send we open (or
 * resume, or fork) a thread, then start a turn. Later sends either start a new
 * turn (thread idle) or STEER the running one (`turn/steer`), which is Codex's
 * direct equivalent of pushing another message into the SDK's streaming input
 * channel mid-turn.
 *
 * ASKS. Codex asks the host things as JSON-RPC requests it will block on
 * forever if unanswered, which is a sharper failure mode than the SDK's
 * `canUseTool` promise: a dropped answer wedges the thread with no timeout. So
 * every inbound request is registered in {@link pendingAsks} the moment it
 * arrives and is answered exactly once — including on dispose, where anything
 * still open is declined rather than abandoned.
 *
 * THE GUARD. Dispatch's workflow guard wants to VETO a command before it runs.
 * Claude has a PreToolUse hook for that; Codex has no host-side pre-tool
 * callback, so the guard is enforced at two weaker points instead:
 *   1. at the approval prompt, where we auto-decline a violating command; and
 *   2. on `item/started`, where a command that was never submitted for approval
 *      (because the posture is `never`) is caught and the turn interrupted.
 * (2) races the command by definition — it may already be running. That is a
 * real, documented reduction versus Claude. The neutral broker recovery layer
 * immediately starts a continuation turn after that safety interrupt; this
 * adapter only reports which recovery shape the runtime required. The weaker
 * enforcement guarantee is still surfaced as `capabilities.preToolGuard ===
 * false` so the UI can say so rather than imply a guarantee that isn't there.
 *
 * The guard is async (it can touch the disk), so (2) holds back every root
 * notification behind a pending verdict — see {@link guardBarrier}.
 */
import type { Effort, PermissionMode, ImageRef } from "@dispatch/shared";
import type {
  HarnessEvent,
  HarnessGuardBlockedEvent,
  HarnessInput,
  HarnessLimits,
  HarnessPermissionResolution,
  HarnessQuestionAnswer,
  HarnessSession,
  HarnessSessionSpec,
} from "@dispatch/shared";
import { CodexStreamDecoder, codexToolCall, legacySubagentToolUseId, questionsOf } from "./stream.js";
import { toCodexPosture, toDeveloperInstructions, clampEffort } from "./options.js";
import { catchToolGuard } from "@dispatch/shared";
import { codexCompactNote, normalizeCompactFocus } from "@dispatch/shared";
import type { CodexConnection, RpcFrame, ServerRequest } from "./rpc.js";

/** A server→client request we owe an answer to. */
interface PendingAsk {
  id: number | string;
  /** How to answer it, given a host decision. */
  answer: (allow: boolean, resolution?: HarnessPermissionResolution) => void;
  /** How to answer a question-shaped ask. */
  answerQuestions?: (answers: HarnessQuestionAnswer[]) => void;
}

/**
 * Codex refused input because the active turn is one it will not steer — a
 * compaction or a review (`NonSteerableTurnKind`). Read from the structured
 * error info when the app-server sends it, else from the message, which on
 * 0.164 is Rust debug text: `failed to submit turn input:
 * ActiveTurnNotSteerable { turn_kind: Compact }`.
 */
export function isNotSteerable(err: unknown): boolean {
  const data = (err as { data?: unknown } | null)?.data;
  if (data && JSON.stringify(data).includes("activeTurnNotSteerable")) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /ActiveTurnNotSteerable|activeTurnNotSteerable/.test(message);
}

/** A dead app-server must not make session disposal wait forever. */
const DISPOSE_RPC_TIMEOUT_MS = 250;

/**
 * Codex's per-call deadline for Dispatch's own MCP servers, in seconds.
 *
 * Left unset, Codex cuts every `tools/call` off at 300s. `watch_pr` and
 * `wait_for_chat` then error at five minutes, when they should return their
 * documented "timed out, call again" result. A review card answered after that
 * cutoff lost its verdict on 2026-09-12.
 *
 * One minute past the longest any bounded Dispatch tool waits on its own (the
 * hour `WAIT_CAP_SECONDS` / `ASK_USER_TIMEOUT_CAP_SECONDS` allow). Every one
 * of them returns normally, and nothing blocks longer than about an hour. It
 * was a day in #212, and Michael rejected that as far too long. A review or
 * question card still open past the deadline doesn't lose its answer: the
 * broker delivers it as a message.
 */
export const MANAGER_TOOL_TIMEOUT_SEC = 61 * 60;

async function settleForDisposal(work: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work(controller.signal).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          // Reaches CodexConnection.pending so the losing request is removed;
          // the outer race remains as a backstop for injected/older transports.
          controller.abort(new Error("codex disposal rpc timed out"));
          resolve();
        }, DISPOSE_RPC_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sandboxPolicy(sandbox: "read-only" | "workspace-write" | "danger-full-access") {
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" as const };
  if (sandbox === "read-only") return { type: "readOnly" as const };
  return { type: "workspaceWrite" as const };
}

export interface CodexSessionOpts {
  spec: HarnessSessionSpec;
  conn: CodexConnection;
  /** Released when the session disposes, so the shared process can shut down. */
  release: () => void;
  genId: () => string;
  /** Per-model supported efforts, for clamping. */
  supportedEfforts?: (model: string | undefined) => string[];
  /** Latest account limits, merged into a usage-limit turn end. */
  limitsSnapshot?: () => HarnessLimits | null;
  /** Extra `config` overrides merged into thread/start (e.g. MCP servers). */
  threadConfig?: Record<string, unknown>;
}

export class CodexSession implements HarnessSession {
  private readonly spec: HarnessSessionSpec;
  private readonly conn: CodexConnection;
  private readonly release: () => void;
  private readonly genId: () => string;
  private readonly decoder: CodexStreamDecoder;
  /** One decoder per native child thread; their streams interleave with root. */
  private readonly childDecoders = new Map<string, CodexStreamDecoder>();
  /** Child thread → the neutral Agent tool that spawned it. */
  private readonly childContexts = new Map<
    string,
    { parentToolUseId: string; subagentType: string }
  >();
  /** Latest spawn item per sender, used when the activity marker names the child first. */
  private readonly pendingSpawns = new Map<string, string>();
  private readonly opts: CodexSessionOpts;

  private threadId?: string;
  private turnId?: string;
  private started = false;
  private disposed = false;
  /**
   * Messages not yet handed to Codex: queued before the thread exists, or held
   * back while the active turn can't take them (see {@link nonSteerable}).
   */
  private outbox: HarnessInput[] = [];
  /** Messages in a `turn/steer` / `turn/start` call that hasn't answered yet. */
  private inflight = 0;
  /**
   * The active (or just-requested) turn is a compaction, which Codex will
   * neither steer nor start a turn beside. Both RPCs refuse it with
   * `ActiveTurnNotSteerable { turn_kind: Compact }`, and before this flag every
   * message sent mid-compaction (a peer's `chat_send`, a plain "hello") became
   * a red failed row and was lost. While it is set, input waits in the outbox
   * and goes out once that turn completes.
   */
  private nonSteerable = false;
  /** `turn/completed` frames seen, to tell whether a turn ended mid-call. */
  private turnsCompleted = 0;
  /** The event last handed to the host was a turn end it is still handling. */
  private handedTurnEnd = false;
  private unsubscribes: (() => void)[] = [];
  private readonly pendingAsks = new Map<string, PendingAsk>();
  /**
   * Root notifications queued behind a guard verdict still being reached.
   *
   * The guard is async now, and Codex can put `item/started`, `item/completed`
   * and `turn/completed` in one stdout chunk that is dispatched synchronously.
   * Unqueued, a refusal decided a few microtasks later would land AFTER the
   * turn it belongs to had ended: no interrupt to recover from, the recovery
   * marker left over to misfire on a later turn, and the turn simply over —
   * the exact failure a guard hit must never cause here. Null when nothing is
   * pending, so the common path stays synchronous.
   */
  private guardBarrier: Promise<void> | null = null;
  /**
   * ONE guard verdict per root item, shared by its approval prompt and its
   * sighting — whichever of the two reaches the guard first asks, the other
   * reuses the answer.
   *
   * The guard is stateful: a pass can spend a one-shot exemption. Asked twice
   * for one item, the second ask refuses the very call the grant was for — and
   * Codex can deliver the two in EITHER order (`item/started` before its
   * `requestApproval`, or the request first), so a dedupe keyed one way only
   * still refused a granted call on the other. Cleared at turn end.
   */
  private readonly itemVerdicts = new Map<string, Promise<HarnessGuardBlockedEvent | null>>();

  /** Effort currently pinned for the thread. */
  private effort: Effort;
  private model?: string;

  /* ------------------------------------------------- the event stream */

  private readonly queue: HarnessEvent[] = [];
  private waiter?: () => void;
  private ended = false;

  constructor(opts: CodexSessionOpts) {
    this.opts = opts;
    this.spec = opts.spec;
    this.conn = opts.conn;
    this.release = opts.release;
    this.genId = opts.genId;
    this.effort = opts.spec.effort;
    this.model = opts.spec.model;
    this.decoder = new CodexStreamDecoder({ genId: opts.genId });

    opts.spec.abortSignal?.addEventListener("abort", () => void this.dispose(), { once: true });
  }

  get events(): AsyncIterable<HarnessEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<HarnessEvent> => ({
        next: async (): Promise<IteratorResult<HarnessEvent>> => {
          // Asking again means the host is done with the event it took last.
          if (this.handedTurnEnd) {
            this.handedTurnEnd = false;
            this.releaseHeld();
          }
          for (;;) {
            const next = this.queue.shift();
            if (next) {
              if (next.type === "turn-end") this.handedTurnEnd = true;
              return { value: next, done: false };
            }
            if (this.ended) return { value: undefined as never, done: true };
            await new Promise<void>((resolve) => (this.waiter = resolve));
          }
        },
      }),
    };
  }

  private emit(...events: HarnessEvent[]): void {
    if (this.ended) return;
    this.queue.push(...events);
    this.waiter?.();
    this.waiter = undefined;
  }

  private end(): void {
    this.ended = true;
    this.waiter?.();
    this.waiter = undefined;
  }

  /* --------------------------------------------------------- sending */

  send(input: HarnessInput): void {
    if (this.disposed) return;
    if (input.effort) this.effort = input.effort;
    this.outbox.push(input);
    if (!this.started) {
      this.started = true;
      void this.open().catch((err) => this.fail(err));
    } else {
      void this.flush().catch((err) => this.fail(err));
    }
  }

  pending(): number {
    // In-flight counts: a call racing a turn end may come back refused and be
    // held, and the broker reads this at that turn end to decide whether the
    // chat is still running.
    return this.outbox.length + this.inflight;
  }

  /** Open (or resume/fork) the thread, then drain whatever is queued. */
  private async open(): Promise<void> {
    const posture = toCodexPosture(this.spec.permissionMode);
    const config = this.threadConfig();
    const base = {
      cwd: this.spec.cwd,
      approvalPolicy: posture.approvalPolicy,
      sandbox: posture.sandbox,
      model: this.model,
      developerInstructions: toDeveloperInstructions(this.spec.systemPromptAppends),
      ...(Object.keys(config).length ? { config } : {}),
    };

    let result: { thread?: { id?: string }; model?: string };
    if (this.spec.resumeSessionId && this.spec.fork) {
      result = await this.conn.call("thread/fork", {
        threadId: this.spec.resumeSessionId,
        ...(this.spec.forkAtId ? { lastTurnId: this.spec.forkAtId } : {}),
        ...base,
      });
    } else if (this.spec.resumeSessionId) {
      result = await this.conn.call("thread/resume", {
        threadId: this.spec.resumeSessionId,
        ...base,
      });
    } else {
      result = await this.conn.call("thread/start", base);
    }

    const id = result.thread?.id;
    if (!id) throw new Error("codex returned a thread with no id");
    this.threadId = id;
    this.model = result.model ?? this.model;

    this.unsubscribes.push(
      this.conn.onThread(id, (f) => this.onNotification(f)),
      this.conn.onRequest(id, (r) => this.onServerRequest(r)),
    );

    this.emit({
      type: "init",
      sessionId: id,
      model: this.model,
      permissionMode: this.spec.permissionMode,
    });

    await this.flush();
  }

  /** Send everything queued: start a turn, or steer the running one. */
  private async flush(): Promise<void> {
    // One call at a time. Two calls racing into a compaction are both refused,
    // and re-queued in the order they came back they could swap. Whatever is
    // sent meanwhile waits here and goes next.
    if (!this.threadId || this.disposed || this.nonSteerable || this.inflight) return;
    const batch = this.outbox;
    if (!batch.length) return;
    this.outbox = [];

    const input = batch.flatMap((m) => this.toUserInput(m));
    if (!input.length) return;

    const endsBefore = this.turnsCompleted;
    this.inflight = batch.length;
    let sent: boolean;
    try {
      sent = await this.submit(input);
    } catch (err) {
      this.inflight = 0;
      this.releaseHeld();
      throw err;
    }
    this.inflight = 0;
    if (sent) this.releaseHeld();
    else this.hold(batch, endsBefore);
  }

  /**
   * Steer the running turn, or start one. False when Codex refused because
   * the active turn isn't steerable.
   */
  private async submit(input: Record<string, unknown>[]): Promise<boolean> {
    if (this.turnId) {
      try {
        await this.conn.call("turn/steer", {
          threadId: this.threadId,
          input,
          expectedTurnId: this.turnId,
        });
        return true;
      } catch (err) {
        // Keep `turnId`: that turn is still running, and interrupt needs it.
        if (isNotSteerable(err)) return false;
        // The turn ended between our check and the call — fall through and
        // open a new one rather than dropping the user's message.
        this.turnId = undefined;
      }
    }

    const supported = this.opts.supportedEfforts?.(this.model) ?? [];
    const posture = toCodexPosture(this.spec.permissionMode);
    let res: { turn?: { id?: string } };
    try {
      res = await this.conn.call<{ turn?: { id?: string } }>("turn/start", {
        threadId: this.threadId,
        input,
        effort: clampEffort(this.effort, supported),
        model: this.model,
        approvalPolicy: posture.approvalPolicy,
        sandboxPolicy: sandboxPolicy(posture.sandbox),
      });
    } catch (err) {
      // A compaction whose start we haven't seen yet. Codex refuses `turn/start`
      // against it the same way it refuses a steer.
      if (isNotSteerable(err)) return false;
      throw err;
    }
    this.turnId = res.turn?.id;
    return true;
  }

  /**
   * Codex refused `batch` because the active turn is a compaction. Put it back
   * at the FRONT of the outbox, in order — anything sent meanwhile is newer —
   * and send it once that turn is over.
   */
  private hold(batch: HarnessInput[], endsBefore: number): void {
    this.outbox.unshift(...batch);
    if (this.turnsCompleted === endsBefore) {
      // Still running. Its turn end releases the batch (see `releaseHeld`).
      this.nonSteerable = true;
      return;
    }
    // It completed while we were asking. Its turn end hasn't reached the host
    // yet, or is being handled: the host's next pull releases the batch. Else
    // nothing else will, so go now.
    if (this.handedTurnEnd || this.guardBarrier || this.queue.some((e) => e.type === "turn-end")) {
      return;
    }
    this.releaseHeld();
  }

  /**
   * Send whatever is waiting in the outbox.
   *
   * Input a compaction held back is released once the host has FINISHED
   * handling that turn's end, not on `turn/completed`. The broker reads
   * `pending()` in its turn-end handler to decide whether the chat is still
   * running. Flushed any earlier, the outbox would already be empty there, so
   * the chat would settle idle and the new turn would run in a chat that shows
   * nothing running.
   */
  private releaseHeld(): void {
    if (!this.outbox.length) return;
    void this.flush().catch((err) => this.fail(err));
  }

  /** A Dispatch message → Codex `UserInput` blocks. */
  private toUserInput(msg: HarnessInput): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const img of msg.images ?? []) out.push(...this.imageInput(img));
    if (msg.text) out.push({ type: "text", text: msg.text, text_elements: [] });
    return out;
  }

  /** An attached image → a Codex input block. */
  private imageInput(img: ImageRef): Record<string, unknown>[] {
    if (!img.path) return [];
    // Remote/data URLs go as `image`; anything else is a path on this machine.
    return /^(https?:|data:)/.test(img.path)
      ? [{ type: "image", url: img.path }]
      : [{ type: "localImage", path: img.path }];
  }

  /* --------------------------------------------------- inbound stream */

  private onNotification(frame: RpcFrame): void {
    this.observeCollaboration(frame);
    const events = this.decoder.decode(frame);

    // Track the active turn so steering and interrupt can name it.
    if (frame.method === "turn/started") {
      const turn = (frame.params as { turn?: { id?: string } } | undefined)?.turn;
      if (turn?.id) this.turnId = turn.id;
    }
    if (frame.method === "turn/completed") {
      this.turnId = undefined;
      this.nonSteerable = false;
      this.turnsCompleted++;
      this.itemVerdicts.clear();
    }
    this.observeCompaction(frame);

    // The guard's second, weaker enforcement point — see the module header.
    if (frame.method !== "item/started") {
      this.afterGuard(() => this.deliver(events));
      return;
    }
    // Chained, not just awaited: verdicts are reached one at a time (approval
    // prompts queue here too), so two calls cannot both spend the same
    // one-shot exemption.
    this.queueBehindGuard(async () => {
      const blocked = await this.guardStartedItem(frame);
      if (blocked) {
        this.emit(blocked);
        void this.interrupt();
      }
      this.deliver(events);
    });
  }

  /**
   * Hold input from the moment a compaction item starts, rather than learning
   * it from a refused steer. Both kinds show this item: our `compact()` and
   * native auto-compaction. `turn/started` carries no turn kind to read
   * instead. A compaction inside a regular turn ends with its item, so steer
   * again then; if the whole turn is a compaction, that steer is refused and
   * held until `turn/completed`.
   */
  private observeCompaction(frame: RpcFrame): void {
    const item = (frame.params as { item?: { type?: unknown } } | undefined)?.item;
    if (item?.type !== "contextCompaction") return;
    if (frame.method === "item/started") this.nonSteerable = true;
    if (frame.method === "item/completed" && this.nonSteerable) {
      this.nonSteerable = false;
      this.releaseHeld();
    }
  }

  /** Run `step` now, or after the guard verdicts already pending. */
  private afterGuard(step: () => void): void {
    if (this.guardBarrier) this.queueBehindGuard(async () => step());
    else step();
  }

  private queueBehindGuard(step: () => Promise<void>): void {
    void this.serializeGuard(step);
  }

  /** Run `step` after every guard step already queued, and hand back its result. */
  private serializeGuard<T>(step: () => Promise<T>): Promise<T> {
    const run = (this.guardBarrier ?? Promise.resolve()).then(step);
    // A step that throws must not wedge every notification queued after it.
    const barrier = run.then(
      () => {},
      () => {},
    );
    this.guardBarrier = barrier;
    void barrier.finally(() => {
      if (this.guardBarrier === barrier) this.guardBarrier = null;
    });
    return run;
  }

  /**
   * The guard's verdict on one call, asked at most once per root item — see
   * {@link itemVerdicts}. Resolves null for a refusal some earlier path has
   * already reported, so the same refusal is never shown (or recovered) twice.
   * Only ever called from inside a {@link serializeGuard} step, which is what
   * makes "first to ask" well defined.
   */
  private async itemVerdict(
    itemId: string | undefined,
    ask: () => Promise<HarnessGuardBlockedEvent | null>,
  ): Promise<{ blocked: HarnessGuardBlockedEvent | null; fresh: boolean }> {
    if (!itemId) return { blocked: await ask().catch(() => null), fresh: true };
    let verdict = this.itemVerdicts.get(itemId);
    const fresh = !verdict;
    if (!verdict) {
      verdict = ask().catch(() => null);
      this.itemVerdicts.set(itemId, verdict);
    }
    return { blocked: await verdict, fresh };
  }

  /** Hand one root frame's decoded events to the host. */
  private deliver(events: HarnessEvent[]): void {
    for (const e of events) {
      // A usage-limit turn end carries no reset time of its own; the account
      // snapshot has it, so merge before the scheduler sees it.
      if (e.type === "turn-end" && e.limit) {
        const snap = this.opts.limitsSnapshot?.();
        const resetsAt = snap?.primary?.resetsAt ?? snap?.secondary?.resetsAt;
        if (resetsAt) e.limit = { ...e.limit, resetsAt };
      }
      this.emit(e);
      if (e.type === "turn-end") this.turnId = undefined;
    }
  }

  /**
   * Discover native child threads from collaboration items/activity markers.
   *
   * App-server sends every thread over the shared connection, but RPC routing
   * is deliberately per-thread. Registering here—synchronously while handling
   * the spawn frame—means the child's next notification is no longer dropped.
   */
  private observeCollaboration(frame: RpcFrame): void {
    if (frame.method !== "item/started" && frame.method !== "item/completed") return;
    const params = (frame.params ?? {}) as Record<string, unknown>;
    const senderThreadId = typeof params.threadId === "string" ? params.threadId : this.threadId;
    const item = params.item as Record<string, unknown> | undefined;
    if (!item || !senderThreadId) return;

    if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
      const toolUseId = String(item.id ?? this.genId());
      this.pendingSpawns.set(senderThreadId, toolUseId);
      for (const childId of this.receiverThreadIds(item)) {
        this.subscribeChild(childId, toolUseId);
      }
      return;
    }

    if (item.type === "subAgentActivity") {
      const childId = typeof item.agentThreadId === "string" ? item.agentThreadId : undefined;
      if (!childId) return;
      // App-server also reports the root path as sub-agent activity. Subscribing
      // the sender to itself installs a second decoder on the same thread, so
      // every later message/tool is persisted twice (the copy masquerades as a
      // child of `codex-agent:<root-id>`). Activity describes a child only when
      // it identifies a DIFFERENT thread.
      if (childId === senderThreadId || childId === this.threadId) return;
      const toolUseId =
        this.childContexts.get(childId)?.parentToolUseId ??
        this.pendingSpawns.get(senderThreadId) ??
        legacySubagentToolUseId(childId);
      const path = typeof item.agentPath === "string" ? item.agentPath : "";
      const label = path.split(/[\\/]/).filter(Boolean).at(-1) || "codex";
      this.subscribeChild(childId, toolUseId, label);
    }
  }

  private receiverThreadIds(item: Record<string, unknown>): string[] {
    return Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((id): id is string => typeof id === "string")
      : [];
  }

  /** Attach one native child thread to its spawning neutral Agent row. */
  private subscribeChild(threadId: string, parentToolUseId: string, subagentType = "codex"): void {
    const existing = this.childContexts.get(threadId);
    if (existing) {
      existing.parentToolUseId = parentToolUseId;
      existing.subagentType = subagentType === "codex" ? existing.subagentType : subagentType;
      return;
    }
    this.childContexts.set(threadId, { parentToolUseId, subagentType });
    this.childDecoders.set(threadId, new CodexStreamDecoder({ genId: this.genId }));
    this.unsubscribes.push(
      this.conn.onThread(threadId, (frame) => this.onChildNotification(threadId, frame)),
      this.conn.onRequest(threadId, (req) =>
        this.onServerRequest(req, this.childContexts.get(threadId)?.parentToolUseId),
      ),
    );
  }

  /** Child-thread events become tagged transcript rows, never root turn state. */
  private onChildNotification(threadId: string, frame: RpcFrame): void {
    this.observeCollaboration(frame);
    const decoder = this.childDecoders.get(threadId);
    const context = this.childContexts.get(threadId);
    if (!decoder || !context) return;

    // Decoded now (the decoder is stateful and frames arrive in order), but
    // delivered behind any pending guard verdict: the child's rows hang off
    // the root's `Agent` row, and that row may itself be waiting on the guard.
    const events = decoder.decode(frame);
    this.afterGuard(() => this.deliverChild(threadId, context, events));
  }

  private deliverChild(
    threadId: string,
    context: { parentToolUseId: string; subagentType: string },
    events: HarnessEvent[],
  ): void {
    for (const event of events) {
      switch (event.type) {
        // Claude also suppresses subagent partials: one root stream buffer cannot
        // safely host concurrent child deltas. Finalized rows retain the text.
        case "delta":
        case "usage":
        case "compacted":
        case "init":
          break;
        case "assistant":
        case "tool-use":
        case "tool-result":
          this.emit({
            ...event,
            parentToolUseId: context.parentToolUseId,
            subagentType: context.subagentType,
          });
          break;
        case "turn-end":
          // A child turn ending settles only that run. Passing it through would
          // falsely end the root chat turn in SessionBroker.
          this.emit({
            type: "task-notification",
            taskId: threadId,
            toolUseId: context.parentToolUseId,
            status: event.ok
              ? "completed"
              : event.subtype === "interrupted"
                ? "stopped"
                : "failed",
            summary: event.result,
            durationMs: event.durationMs,
          });
          break;
        case "notice":
          this.emit({ ...event, text: `${context.subagentType}: ${event.text}` });
          break;
        case "permission-request":
        case "question-request":
        case "task-notification":
          this.emit(event);
          break;
      }
    }
  }

  /**
   * Interrupt an item that started despite violating the host's rules.
   *
   * Codex has no PreToolUse equivalent (`capabilities.preToolGuard: false`),
   * so for anything that does not route through an approval request this is
   * the only enforcement point there is — and it fires on SIGHTING, i.e.
   * after the call has begun. That is a real and documented degradation.
   *
   * MCP calls are covered here as well as shell commands. They were not, and
   * the gap was load-bearing: Codex never asks for approval on an
   * `mcpToolCall`, so a mode denylist naming `mcp__dispatch-workspace__worktree`
   * had NOTHING enforcing it on this runtime. See `requiresPreToolGuard` in
   * the broker for the other half of that fix — a posture whose whole point is
   * the denylist refuses to run on a runtime that can only catch it late.
   */
  private async guardStartedItem(frame: RpcFrame): Promise<HarnessGuardBlockedEvent | null> {
    const item = (frame.params as { item?: Record<string, unknown> } | undefined)?.item;
    if (!item) return null;
    const itemId = typeof item.id === "string" ? item.id : undefined;
    // EVERY mapped item type, through the same mapper the stream decoder uses
    // to label the row. Hand-rolling the name here is what left `fileChange`,
    // `dynamicToolCall`, `collabAgentToolCall` and `webSearch` unguarded while
    // `commandExecution` was covered — and now that any mode can carry a tool
    // policy, an unguarded item type is an unenforced policy, not just a
    // missing workflow warning.
    const call = codexToolCall(item);
    if (!call) return null;
    const { blocked, fresh } = await this.itemVerdict(itemId, () =>
      catchToolGuard(this.spec.toolGuard, call.name, call.input, "restart-turn", {
        cwd: typeof call.input.cwd === "string" ? call.input.cwd : undefined,
        toolUseId: itemId,
      }),
    );
    // Its approval prompt already refused (and reported) this item. A refused
    // item should never start; if Codex starts it anyway, still stop the turn
    // — but do not report the same refusal a second time.
    if (blocked && !fresh) void this.interrupt();
    return fresh ? blocked : null;
  }

  /* -------------------------------------------------- inbound requests */

  private onServerRequest(req: ServerRequest, parentToolUseId?: string): void {
    switch (req.method) {
      case "item/commandExecution/requestApproval":
        void this.askPermission(req, "Bash", {
          command: String(req.params.command ?? ""),
          ...(typeof req.params.cwd === "string" ? { cwd: req.params.cwd } : {}),
        }, parentToolUseId);
        return;

      case "item/fileChange/requestApproval":
        void this.askPermission(req, "Edit", {
          ...(typeof req.params.grantRoot === "string" ? { file_path: req.params.grantRoot } : {}),
        }, parentToolUseId);
        return;

      case "item/permissions/requestApproval":
        return this.askPermissionEscalation(req, parentToolUseId);

      case "item/tool/requestUserInput":
        return this.askQuestions(req, parentToolUseId);

      case "mcpServer/elicitation/request":
        // An MCP server asking the user to fill a form. Dispatch has no surface
        // for arbitrary elicitation schemas yet, and leaving it unanswered would
        // wedge the thread, so decline explicitly.
        this.conn.respond(req.id, { action: "decline" });
        return;

      default:
        // Anything we don't model still needs an answer or the agent blocks.
        this.conn.respond(req.id, {});
    }
  }

  /** Surface an approval as a permission card. */
  private async askPermission(
    req: ServerRequest,
    toolName: string,
    input: Record<string, unknown>,
    parentToolUseId?: string,
  ): Promise<void> {
    const itemId = typeof req.params.itemId === "string" ? req.params.itemId : undefined;
    // The guard's first (and reliable) enforcement point. Only a ROOT item
    // shares its verdict with a sighting; a child's sighting is never guarded.
    // A guard that throws counts as no verdict — the request must still be
    // answered, or Codex blocks on it forever.
    const { blocked, fresh } = await this.serializeGuard(() =>
      this.itemVerdict(parentToolUseId ? undefined : itemId, () =>
        catchToolGuard(this.spec.toolGuard, toolName, input, "in-place", {
          cwd: typeof input.cwd === "string" ? input.cwd : undefined,
          parentToolUseId,
          toolUseId: itemId,
        }),
      ),
    );
    // Disposed while the guard deliberated: `dispose` has already declined
    // everything it knew about, and this request was not yet among them.
    if (this.disposed || blocked) {
      try {
        this.conn.respond(req.id, { decision: "decline" });
      } catch {
        /* connection already gone */
      }
      // A refusal the sighting already reported (and is recovering from) is
      // declined quietly.
      if (blocked && fresh && !this.disposed) this.emit(blocked);
      return;
    }

    const requestId = this.genId();
    this.pendingAsks.set(requestId, {
      id: req.id,
      answer: (allow) => this.conn.respond(req.id, { decision: allow ? "accept" : "decline" }),
    });
    this.emit({
      type: "permission-request",
      requestId,
      toolName,
      input,
      reason: typeof req.params.reason === "string" ? req.params.reason : undefined,
      target: typeof input.command === "string" ? input.command : (input.file_path as string | undefined),
      parentToolUseId,
    });
  }

  /**
   * A request to widen the sandbox (extra write roots, network access).
   *
   * Codex's response has no "decline" variant — it expects a granted profile —
   * so a denial is expressed as an RPC error, which Codex treats as refusal.
   */
  private askPermissionEscalation(req: ServerRequest, parentToolUseId?: string): void {
    const requestId = this.genId();
    const requested = req.params.permissions;
    this.pendingAsks.set(requestId, {
      id: req.id,
      answer: (allow) => {
        if (allow) this.conn.respond(req.id, { permissions: requested, scope: "session" });
        else this.conn.respondError(req.id, "denied by Dispatch");
      },
    });
    this.emit({
      type: "permission-request",
      requestId,
      toolName: "Permissions",
      input: (requested ?? {}) as Record<string, unknown>,
      reason: typeof req.params.reason === "string" ? req.params.reason : "Codex is requesting wider access.",
      parentToolUseId,
    });
  }

  /** Surface `requestUserInput` as a question card. */
  private askQuestions(req: ServerRequest, parentToolUseId?: string): void {
    const questions = questionsOf(req.params);
    const requestId = this.genId();
    this.pendingAsks.set(requestId, {
      id: req.id,
      answer: (_allow) => this.conn.respond(req.id, { answers: {} }),
      answerQuestions: (answers) => {
        const payload: Record<string, { answers: string[] }> = {};
        for (const a of answers) payload[a.questionId] = { answers: a.selected };
        // Anything the human skipped still needs a key, or Codex waits on it.
        for (const q of questions) payload[q.id] ??= { answers: [] };
        this.conn.respond(req.id, { answers: payload });
      },
    });
    this.emit({ type: "question-request", requestId, questions, parentToolUseId });
  }

  resolvePermission(requestId: string, resolution: HarnessPermissionResolution): void {
    const ask = this.pendingAsks.get(requestId);
    if (!ask) return;
    this.pendingAsks.delete(requestId);
    ask.answer(resolution.decision === "allow", resolution);
  }

  resolveQuestion(requestId: string, answers: HarnessQuestionAnswer[]): void {
    const ask = this.pendingAsks.get(requestId);
    if (!ask) return;
    this.pendingAsks.delete(requestId);
    if (ask.answerQuestions) ask.answerQuestions(answers);
    else ask.answer(true);
  }

  /* --------------------------------------------------------- control */

  async interrupt(signal?: AbortSignal): Promise<void> {
    if (!this.threadId || !this.turnId) return;
    try {
      await this.conn.call(
        "turn/interrupt",
        { threadId: this.threadId, turnId: this.turnId },
        signal,
      );
    } catch {
      // Already finished — nothing to interrupt.
    }
  }

  /**
   * Codex applies posture per-turn rather than exposing a live setter, so this
   * records the new mode and lets the next `turn/start` carry it. A change made
   * mid-turn therefore takes effect on the following turn, which is the same
   * observable behaviour the SDK gives for a mode change during a tool call.
   */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    (this.spec as { permissionMode: PermissionMode }).permissionMode = mode;
    if (!this.threadId) return;
    const posture = toCodexPosture(mode);
    try {
      await this.conn.call("thread/settings/update", {
        threadId: this.threadId,
        approvalPolicy: posture.approvalPolicy,
        sandboxPolicy: sandboxPolicy(posture.sandbox),
      });
    } catch {
      // Older app servers don't accept posture here; the next turn carries it.
    }
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
    if (this.threadId) {
      await this.conn.call("thread/settings/update", { threadId: this.threadId, model });
    }
  }

  async setEffort(effort: Effort): Promise<void> {
    this.effort = effort;
    if (this.threadId) {
      const supported = this.opts.supportedEfforts?.(this.model) ?? [];
      await this.conn.call("thread/settings/update", {
        threadId: this.threadId,
        effort: clampEffort(effort, supported),
      });
    }
  }

  async compact(focus?: string): Promise<void> {
    if (!this.threadId) return;
    const f = normalizeCompactFocus(focus);
    if (f) {
      // `thread/compact/start` has no instructions field (protocol 0.147), so
      // the focus is appended to model-visible history as a Responses-API user
      // item first. Best-effort: an app-server that lacks `thread/inject_items`
      // still compacts, just without the steer.
      try {
        await this.conn.call("thread/inject_items", {
          threadId: this.threadId,
          items: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: codexCompactNote(f) }],
            },
          ],
        });
      } catch {
        /* compact anyway */
      }
    }
    await this.conn.call("thread/compact/start", { threadId: this.threadId });
  }

  async contextWindow(): Promise<number | undefined> {
    return this.decoder.contextWindow;
  }

  /** Translate Dispatch MCP/config vocabulary to Codex's config.toml keys. */
  private threadConfig(): Record<string, unknown> {
    const configured = { ...(this.opts.threadConfig ?? {}) };
    const servers: Record<string, Record<string, unknown>> = {};
    for (const [name, raw] of Object.entries(this.spec.mcpServers)) {
      if (raw.url) {
        servers[name] = {
          url: raw.url,
          ...(raw.headers ? { http_headers: raw.headers } : {}),
        };
      } else if (raw.command) {
        servers[name] = {
          command: raw.command,
          ...(raw.args ? { args: raw.args } : {}),
          ...(raw.cwd ? { cwd: raw.cwd } : {}),
          ...(raw.env ? { env: raw.env } : {}),
        };
      }
    }
    if (this.spec.managerMcp?.transport === "http") {
      // One entry per category server. Codex has no notion of an in-process MCP,
      // so each gets its own streamable-HTTP endpoint on the bridge — same token,
      // different path.
      const { token } = this.spec.managerMcp;
      for (const [name, url] of Object.entries(this.spec.managerMcp.urls)) {
        servers[name] = {
          url,
          http_headers: { Authorization: `Bearer ${token}` },
          tool_timeout_sec: MANAGER_TOOL_TIMEOUT_SEC,
        };
      }
    }
    if (Object.keys(servers).length) {
      configured.mcp_servers = {
        ...((configured.mcp_servers as Record<string, unknown> | undefined) ?? {}),
        ...servers,
      };
    }
    if (this.spec.autoCompact !== false && this.spec.contextTokenLimit) {
      configured.model_auto_compact_token_limit = this.spec.contextTokenLimit;
    }
    return configured;
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.emit({ type: "turn-end", ok: false, subtype: "error", result: message });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Never abandon an ask — a thread blocked on an unanswered request would
    // survive this session and hold a slot in the shared process.
    for (const [, ask] of this.pendingAsks) {
      try {
        ask.answer(false);
      } catch {
        /* connection already gone */
      }
    }
    this.pendingAsks.clear();
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    try {
      // Unsubscribing only stops notifications; it does not stop an active turn
      // or the MCP serving it. Neither RPC may hold teardown hostage if the
      // shared app-server is alive but no longer answering JSON-RPC.
      await settleForDisposal((signal) => this.interrupt(signal));
      if (this.threadId) {
        await settleForDisposal(
          (signal) => this.conn.call("thread/unsubscribe", { threadId: this.threadId }, signal),
        );
      }
    } finally {
      // These are local ownership operations and must run even when both RPCs
      // time out; otherwise the shared-process ref and event stream leak.
      this.end();
      this.release();
    }
  }
}
