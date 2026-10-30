/**
 * CHAT → CHAT MESSAGING.
 *
 * One chat sending a message to another, and blocking for a correlated answer.
 * The MCP tools (`chat_send` / `chat_ask` / `chat_reply` / `chat_state`) are one
 * consumer; the Mission layer is meant to be another, and the nested PR-review
 * chats should eventually re-key onto it. So this service knows NOTHING about
 * MCP: it takes chat ids and strings, and everything it needs from the broker
 * and the store arrives through injected functions.
 *
 * WHY THIS RAISES NO CONSENT PROMPT OF ITS OWN. `spawn_chat` puts a card in
 * front of the human from inside the tool, because a spawn is expensive and not
 * reversible. A message is neither, and a bespoke card per message would make
 * this unusable as a substrate for an agent project-manager.
 *
 * That is a statement about THIS layer, not a claim that a message is never
 * gated: the ordinary MCP tool-permission layer still applies, so on a project
 * whose mode prompts for tool calls these prompt like any other tool. What is
 * deliberate here is that the service adds no SECOND gate of its own, and asks
 * for nothing where the mode already allows the call. Safety is instead bought
 * two ways that hold regardless of the mode:
 *
 *   - ATTRIBUTION. Every message lands as a `user` row stamped `origin: "peer"`
 *     with the sending chat on it. A peer message has to arrive as a user turn —
 *     that is the only input channel a session has — so without the stamp it
 *     would render as something the human typed.
 *   - RATE LIMITS. Two chats that can message each other can ping-pong forever,
 *     burning tokens with nobody watching. Subagents structurally cannot do
 *     this, so it is a genuinely new failure mode and it gets a real guard.
 */
import { chatPrStatuses, prRecordKey } from "@dispatch/shared";
import type { Chat, ChannelSender, ChatPrStatus, ChatStatus, ContextUsage, PeerSender, PrRecord } from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { ChatFamily } from "./chat-tree.js";

/* ------------------------------------------------------------ rate limits */

/**
 * The loop guard, as two sliding windows.
 *
 * Rate limits rather than hop counting. Hop counting is the more elegant answer
 * — it distinguishes a long legitimate conversation from a runaway one, which a
 * rate limit cannot — but it needs a hop depth threaded through the broker's
 * turn lifecycle so that a message SENT while handling a peer message inherits
 * its depth. That is invasive, and it is subtly wrong the moment a chat sends
 * from a later turn. A window over recent sends needs no lifecycle state at all.
 *
 * TUNABLE, and these particular numbers are a judgement about what real work
 * looks like: a lead handing a developer a task, getting an answer, and
 * following up is a handful of messages in a burst, so the per-pair budget is
 * set well above that and well below the hundreds-per-minute a runaway loop
 * produces. The per-target limit is the backstop for the case the pair limit
 * cannot see — five chats each politely under their own budget, all aimed at one
 * victim.
 */
export const PEER_PAIR_LIMIT = 10;
/** Window for {@link PEER_PAIR_LIMIT}, per ordered (sender → target) pair. */
export const PEER_PAIR_WINDOW_MS = 5 * 60_000;
/** Inbound cap for ONE target across every sender — the many-to-one backstop. */
export const PEER_TARGET_LIMIT = 30;
/** Window for {@link PEER_TARGET_LIMIT}. */
export const PEER_TARGET_WINDOW_MS = 5 * 60_000;

/**
 * Ceiling on ONE peer message, in characters — the other half of the budget,
 * because the windows above count messages and the cost is length.
 *
 * Measured over 1,068 chats and 636 peer messages before this existed: the
 * median was 3,072 characters and the 25th percentile 2,281, with only 5% under
 * 500. That is not a tail of a few runaway chats, it is the default shape of
 * every message — and it sails through the windows above, which are tuned
 * against the hundreds-per-minute a loop produces. Ten messages at the observed
 * median is 30 KB of prose inside one pair's five-minute budget.
 *
 * What that length was actually made of, read back: the load-bearing sentence
 * first ("your test on main is red and it is yours"), then a page of context the
 * recipient could have read itself and acknowledgement it did not need. So the
 * cap is set where a lead sentence and its qualification fit and a briefing
 * document does not. Detail that genuinely has to travel has somewhere better to
 * go — a file, the PR, project memory — and a pointer costs the recipient one
 * read it can skip rather than a page it cannot.
 *
 * ENFORCED AT THE TOOL BOUNDARY, not in `deliver` below, and deliberately: this
 * is a rule about what agents WRITE, and the transport also carries messages
 * nobody composed — review notifications and the like — which have no business
 * being truncated to a prose budget.
 */
export const PEER_MESSAGE_LIMIT = 800;

/* ----------------------------------------------------------------- types */

/** How a message reaches a target that is mid-turn. */
export type PeerDelivery = "queue" | "interrupt";

/**
 * Who is sending. A CHAT (the `chat_send` tools, the completion notices) or an
 * INTEGRATION — a bot behind a token, a plugin — which has no chat of its own.
 * Both ride the same delivery path: same hold-while-busy rule, same rate
 * limits, same wake-the-target behaviour. Only the attribution on the row
 * differs, and that is the point: a message from outside must never arrive
 * dressed as one the human typed OR as one another agent sent.
 */
export type MessageSender = { chatId: string } | { channel: ChannelSender };

/**
 * The rate-limit key for a sender. A channel's budget is per NAME: the "pair"
 * limit then means one bot cannot flood one chat, and the per-target limit
 * still backstops many bots aimed at one chat.
 */
function senderKey(sender: MessageSender): string {
  return "chatId" in sender ? sender.chatId : `channel:${sender.channel.name}`;
}

/** Why a send was refused. Each maps to one guard, so callers can branch. */
export type PeerRefusal =
  | "self"
  | "unknown-chat"
  | "rate-limited-pair"
  | "rate-limited-target";

export interface PeerSendResult {
  ok: boolean;
  /** Set when `ok` is false. */
  refusal?: PeerRefusal;
  /** Human-readable explanation, always set on a refusal. */
  message?: string;
  /** When a rate limit refused it, epoch ms at which the oldest send ages out. */
  retryAt?: number;
  /** True when the target was mid-turn and the message is being held. */
  held?: boolean;
  /**
   * True when the message went out into a turn ALREADY IN FLIGHT — i.e. an
   * `interrupt` that actually interrupted something. Distinct from a delivery to
   * an idle chat, and reported separately because a caller told "it was idle" a
   * second after `chat_state` said `running` has been handed a plain falsehood.
   */
  interrupted?: boolean;
  /**
   * True when the target had no live session and one was started for it. Says
   * nothing about WHY there was none — a chat that finished and a chat that has
   * never run look identical from here.
   */
  woke?: boolean;
}

export interface PeerAskResult extends PeerSendResult {
  /** Correlation id the target passes to `reply`. Absent when the send failed. */
  askId?: string;
  /**
   * True when the question was still PARKED when the asker gave up, so it was
   * pulled back and the target never saw it. Worth telling the caller: "nobody
   * answered" and "it never arrived" call for different next moves.
   */
  withdrawn?: boolean;
  /** True only when a real answer came back. */
  answered: boolean;
  /** Why no answer, when `answered` is false and the send itself succeeded. */
  reason?: "timeout" | "cancelled";
  answer?: string;
}

export type PeerReplyResult =
  | { ok: true; askerChatId: string }
  | { ok: false; reason: "unknown-ask" | "wrong-chat"; message: string };

/** A one-shot projection of what another chat is doing. */
export interface PeerChatState {
  chatId: string;
  title?: string;
  projectId: string;
  /** Live broker status, or the last persisted one when nothing is running. */
  status: ChatStatus;
  /** True when there is no live session at all (the chat is dormant). */
  dormant: boolean;
  /**
   * True when the chat is stuck on a HUMAN — a permission card or a question is
   * open and nothing will progress until somebody answers it. The single most
   * useful bit for a project manager deciding where to spend attention.
   */
  blockedOnHuman: boolean;
  /** Last message from the human/a peer, epoch ms. */
  lastUserMessageAt?: number;
  /**
   * Last write of any kind to the chat record, epoch ms. Falls back to creation
   * time — `updatedAt` is unset on a chat that has never been written since, and
   * reporting `0` there would date it to 1970 in every "how stale is this" read.
   */
  updatedAt: number;
  /**
   * PRs this chat opened, each joined to the PR registry: open/merged/closed,
   * the CI rollup and the review state. A superset of the `PRRef` this used to
   * be, so a reader of `number`/`url`/`branch` sees no change.
   */
  prs: ChatPrStatus[];
  /** The PR this chat exists to review, if it is a reviewer. */
  reviewOf?: string;
  /** The chat it hangs under in the sidebar — its spawner, or the PR author it reviews for. */
  parent?: ChatFamily["parent"];
  /** Its direct children: chats it spawned, and reviewers of its PRs. `chat_tree` for deeper. */
  children?: ChatFamily["children"];
  /** Percent of the context window used; absent unless a subprocess is live. */
  contextPercent?: number;
  /** Peer messages held for this chat, waiting for its turn to settle. */
  heldMessages: number;
}

/* ------------------------------------------------------------------ deps */

export interface ChatMessengerDeps {
  now?: () => number;
  genId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ChatMessengerOpts {
  bus: EventBus;
  /** The chat record, or null when no such chat exists. */
  getChat: (chatId: string) => Promise<Chat | null>;
  /**
   * Give the target a live session, starting one if it is dormant. A chat that
   * has finished has no subprocess, and a project manager that could not resume
   * a developer it had already used would be useless.
   */
  ensureSession: (chatId: string) => Promise<void>;
  /** The target's live status; undefined when it has no session. */
  getStatus: (chatId: string) => ChatStatus | undefined;
  /**
   * Deliver. Must emit the `user` row (carrying `peer` or `channel`) AND queue
   * it for the subprocess — i.e. the broker's own `sendMessage`, not a bespoke
   * path, so a peer or channel message is an ordinary turn in every respect but
   * its attribution.
   */
  send: (
    chatId: string,
    text: string,
    opts: { peer?: PeerSender; channel?: ChannelSender },
  ) => Promise<void>;
  /** Live context-window usage, when a subprocess is up. Optional. */
  getContextUsage?: (chatId: string) => Promise<ContextUsage | null>;
  /** Is this chat blocked on a human right now (open permission/question)? */
  isBlockedOnHuman?: (chatId: string) => boolean;
  /**
   * One PR registry row by `repo#number` — what `state` reports CI and review
   * from. By key, not a table scan: `chat_state` is the cheap poll, and the
   * registry keeps rows long after their PRs close, so a scan grows with all
   * PR history rather than with this chat's own PRs.
   */
  getPrRecord?: (key: string) => Promise<PrRecord | null>;
  /** The chat's direct parent and children (chat-tree.ts). Omitted → `state` reports neither. */
  family?: (chat: Chat) => Promise<ChatFamily>;
  deps?: ChatMessengerDeps;
}

/** A message parked until the target's current turn ends. */
interface HeldMessage {
  from: string;
  text: string;
  peer?: PeerSender;
  channel?: ChannelSender;
}

/** The ask id a held message carries, whichever kind of sender it has. */
function heldAskId(msg: { peer?: PeerSender; channel?: ChannelSender }): string | undefined {
  return msg.peer?.askId ?? msg.channel?.askId;
}

/** An in-flight `ask` waiting for its `reply`. */
interface PendingAsk {
  askId: string;
  /** The sender key of whoever asked (see {@link senderKey}) — the answer goes to them. */
  from: string;
  /** The chat that was asked — the only one allowed to answer. */
  to: string;
  resolve: (answer: string) => void;
  cancel: (reason: "timeout" | "cancelled") => void;
  timer: unknown;
}

/**
 * Statuses that mean the target is MID-TURN and a `queue` delivery must wait.
 *
 * `awaiting-input` is in here even though it is not strictly a turn in flight,
 * and that is the whole reason this set is spelled out rather than reusing the
 * broker's `isActive`. A chat in `awaiting-input` has a card open in front of
 * the human, and `sendMessage` treats any incoming message as an implicit
 * decline of a pending question — so delivering a peer message there would have
 * one agent silently dismissing a question somebody else was about to answer.
 * Holding until the human deals with their card costs nothing and cannot.
 */
const MID_TURN: ReadonlySet<ChatStatus> = new Set<ChatStatus>([
  "running",
  "waiting",
  "queued",
  "awaiting-input",
]);

/**
 * Statuses where a turn is GENUINELY IN FLIGHT — narrower than {@link MID_TURN},
 * and deliberately so.
 *
 * `MID_TURN` answers "should a queued delivery wait?", where `queued` belongs:
 * a chat parked behind the concurrency cap will run shortly and piling messages
 * on it helps nobody. This set answers a different question — "did this send
 * interrupt anything?" — and `queued` does NOT belong, because no turn has
 * started. The broker agrees: `isActive` excludes `queued`, so `sendMessage`
 * doesn't even treat the delivery as steering. Reporting `interrupted` there
 * would have `chat_send` tell the model it injected into "the turn it is running
 * now" about a turn that has not begun.
 */
const IN_FLIGHT: ReadonlySet<ChatStatus> = new Set<ChatStatus>(["running", "waiting"]);

export class ChatMessenger {
  private readonly bus: EventBus;
  private readonly getChat: ChatMessengerOpts["getChat"];
  private readonly ensureSession: ChatMessengerOpts["ensureSession"];
  private readonly getStatus: ChatMessengerOpts["getStatus"];
  private readonly sendFn: ChatMessengerOpts["send"];
  private readonly getContextUsage: ChatMessengerOpts["getContextUsage"];
  private readonly isBlockedOnHuman: (chatId: string) => boolean;
  private readonly getPrRecord?: (key: string) => Promise<PrRecord | null>;
  private readonly family?: (chat: Chat) => Promise<ChatFamily>;
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  /**
   * Send timestamps per ordered pair, keyed `from\0to`.
   *
   * NUL because it cannot occur in a chat id, so the key is unambiguous — `a` +
   * `bc` and `ab` + `c` must not collide or one pair's budget silently limits
   * another. Written as the ESCAPE, never as a literal byte: a raw NUL in the
   * source makes git treat this whole file as binary (no `git grep`, no diff
   * lines, nothing for a reviewer to read) and renders as nothing in an editor,
   * so the separator looks like a plain concatenation and gets "tidied" away.
   */
  private readonly pairSends = new Map<string, number[]>();
  /** Send timestamps per target, keyed by target chatId. */
  private readonly targetSends = new Map<string, number[]>();

  /**
   * Messages parked per target while it is mid-turn, in arrival order.
   *
   * DURABILITY LIMIT, stated rather than discovered: a held message lives only
   * in this map and is LOST if the server restarts before it flushes. That is
   * acceptable and consistent — a restart kills the target's live session too,
   * so the turn the message was waiting on does not survive either — but a
   * caller that needs an at-least-once guarantee must not build on this.
   */
  private readonly held = new Map<string, HeldMessage[]>();
  /**
   * Flushes in flight per target, as a COUNT.
   *
   * `flush` detaches the queue before its first await, so `held` is already
   * empty while the message it took is still on its way into a turn. Anyone
   * asking "is this chat about to start working?" needs that window to answer
   * yes — see {@link ChatMessenger.hasPending}.
   *
   * Counted rather than a membership set because flushes for ONE target
   * overlap: a message delivered here opens a turn, a fresh message is held
   * during it, and that turn's at-rest edge starts a second flush while the
   * first is still awaiting a later message. A set would have the first one to
   * finish clear the entry for both.
   */
  private readonly flushing = new Map<string, number>();
  private readonly pendingAsks = new Map<string, PendingAsk>();
  private offStatus?: () => void;
  private disposed = false;

  constructor(opts: ChatMessengerOpts) {
    this.bus = opts.bus;
    this.getChat = opts.getChat;
    this.ensureSession = opts.ensureSession;
    this.getStatus = opts.getStatus;
    this.sendFn = opts.send;
    this.getContextUsage = opts.getContextUsage;
    this.isBlockedOnHuman = opts.isBlockedOnHuman ?? (() => false);
    this.getPrRecord = opts.getPrRecord;
    this.family = opts.family;
    this.now = opts.deps?.now ?? (() => Date.now());
    this.genId =
      opts.deps?.genId ?? (() => `ask_${Math.random().toString(36).slice(2, 11)}`);
    this.setTimer =
      opts.deps?.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        // A pending ask must never be the reason the process stays up.
        (t as unknown as { unref?: () => void }).unref?.();
        return t;
      });
    this.clearTimer =
      opts.deps?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /* ------------------------------------------------------------- sending */

  /**
   * Deliver `message` to `to`, attributed to `from`.
   *
   * `queue` (the default) waits for a turn in flight to end; `interrupt` injects
   * mid-thought. Interrupting is the behaviour a HUMAN steering their own agent
   * wants — for agent→agent it can derail a turn halfway through a thought,
   * which is exactly why it is not the default.
   */
  async send(input: {
    /** The sending chat. Omit when `channel` is set. */
    from?: string;
    /** The sending integration, for a message from outside any chat. */
    channel?: ChannelSender;
    to: string;
    message: string;
    delivery?: PeerDelivery;
  }): Promise<PeerSendResult> {
    const sender = senderOf(input);
    const guard = await this.admit(sender, input.to);
    if (!guard.ok) return guard;

    return this.deliver({
      from: senderKey(sender),
      to: input.to,
      text: input.message,
      ...guard.attribution,
      delivery: input.delivery ?? "queue",
    });
  }

  /**
   * Send a question and block until the target answers, or `timeoutMs` elapses.
   *
   * A timeout is a NORMAL outcome, not an error: the caller is told plainly that
   * nobody answered so it can carry on, rather than being handed a failure it
   * will try to fix by asking again.
   */
  async ask(input: {
    /** The asking chat. Omit when `channel` is set. */
    from?: string;
    /** The asking integration — its `chat_ask` over the external MCP mount. */
    channel?: ChannelSender;
    to: string;
    question: string;
    timeoutMs: number;
    /**
     * Every signal that should cancel the wait — the MCP call's and the
     * session's are DIFFERENT aborts and both have to be honoured. Taking one
     * and letting the caller pick meant a session teardown went unnoticed
     * whenever a per-call signal happened to exist.
     */
    signals?: (AbortSignal | undefined)[];
    /**
     * Fired once the question is actually on its way and the wait has begun —
     * i.e. after admission succeeded. For the UI's "waiting on chat X" label,
     * which must not appear for a call that was refused outright: a header that
     * flashes a wait which never existed is worse than no header at all.
     */
    onWaiting?: () => void;
  }): Promise<PeerAskResult> {
    const sender = senderOf(input);
    const from = senderKey(sender);
    const guard = await this.admit(sender, input.to);
    if (!guard.ok) return { ...guard, answered: false };

    const askId = this.genId();
    // The ask id rides on whichever attribution this sender has, so the target's
    // `chat_reply` can find it either way.
    const attribution: Attribution = guard.attribution.peer
      ? { peer: { ...guard.attribution.peer, askId } }
      : { channel: { ...guard.attribution.channel!, askId } };

    // Registered BEFORE the send, not after: `queue` may deliver synchronously,
    // and a target that answers instantly would otherwise find no pending ask.
    const answer = new Promise<{ answered: true; answer: string } | { answered: false; reason: "timeout" | "cancelled" }>(
      (resolve) => {
        const finish = (r: { answered: true; answer: string } | { answered: false; reason: "timeout" | "cancelled" }): void => {
          const pending = this.pendingAsks.get(askId);
          if (!pending) return;
          this.pendingAsks.delete(askId);
          this.clearTimer(pending.timer);
          for (const sig of input.signals ?? []) {
            sig?.removeEventListener("abort", onAbort);
          }
          resolve(r);
        };
        const onAbort = (): void => finish({ answered: false, reason: "cancelled" });
        for (const sig of input.signals ?? []) {
          sig?.addEventListener("abort", onAbort);
        }
        this.pendingAsks.set(askId, {
          askId,
          from,
          to: input.to,
          resolve: (a) => finish({ answered: true, answer: a }),
          cancel: (reason) => finish({ answered: false, reason }),
          timer: this.setTimer(() => finish({ answered: false, reason: "timeout" }), input.timeoutMs),
        });
        // `addEventListener("abort")` on an ALREADY-aborted signal never fires,
        // so without this the ask would park for the whole timeout — an hour, at
        // `chat_ask`'s default. Checked after registration so `finish` has a
        // pending record to tear down. Matches `waitForChatState`.
        if ((input.signals ?? []).some((sig) => sig?.aborted)) onAbort();
      },
    );

    const sent = await this.deliver({
      from,
      to: input.to,
      text: input.question,
      ...attribution,
      delivery: "queue",
    });
    if (!sent.ok) {
      this.pendingAsks.get(askId)?.cancel("cancelled");
      return { ...sent, answered: false };
    }
    input.onWaiting?.();

    const outcome = await answer;
    if (outcome.answered) {
      return { ...sent, askId, answered: true, answer: outcome.answer };
    }
    // Nobody is waiting on this any more, so a still-parked question must not go
    // on to be delivered — see `dropHeld`.
    const withdrawn = this.dropHeld(input.to, askId);
    return { ...sent, askId, answered: false, reason: outcome.reason, withdrawn };
  }

  /**
   * Answer a question raised by {@link ask}. `from` is the chat replying, and it
   * MUST be the one that was asked — otherwise a third chat that guessed (or
   * read) an askId could answer on its behalf.
   */
  /**
   * The chat a pending ask is waiting on, so a host-privileged caller (a
   * plugin's `ctx.chats.reply`, answering on that chat's behalf) can satisfy
   * `reply`'s identity check honestly instead of bypassing it. Undefined once
   * the ask settles.
   */
  targetOf(askId: string): string | undefined {
    return this.pendingAsks.get(askId)?.to;
  }

  reply(input: { from: string; askId: string; answer: string }): PeerReplyResult {
    const pending = this.pendingAsks.get(input.askId);
    if (!pending) {
      return {
        ok: false,
        reason: "unknown-ask",
        message:
          `No question is waiting on askId "${input.askId}". Either it was already ` +
          "answered, or the asking chat gave up waiting. The answer has nowhere to " +
          "go — send it with chat_send if it still matters.",
      };
    }
    if (pending.to !== input.from) {
      return {
        ok: false,
        reason: "wrong-chat",
        message:
          `askId "${input.askId}" was addressed to chat ${pending.to}, not to you. ` +
          "Only the chat that was asked can answer.",
      };
    }
    pending.resolve(input.answer);
    return { ok: true, askerChatId: pending.from };
  }

  /* ---------------------------------------------------------- projection */

  /** A cheap one-shot read of what another chat is doing. Never wakes it. */
  async state(chatId: string): Promise<PeerChatState | null> {
    const chat = await this.getChat(chatId);
    if (!chat) return null;
    const live = this.getStatus(chatId);
    // Context usage needs a live subprocess to answer, so it is best-effort and
    // simply absent on a dormant chat rather than a reason the whole read fails.
    let contextPercent: number | undefined;
    if (live) {
      const usage = await this.getContextUsage?.(chatId).catch(() => null);
      // Not every harness reports `percentage` — the neutral branch of
      // `getContextUsage` returns totals only. Derive it when we can and leave
      // it ABSENT when we cannot: `Math.round(undefined)` is NaN, which reaches
      // the agent as `"contextPercent":null` under a line reading "NaN% full",
      // and a wrong number is worse than a missing one.
      const pct =
        usage &&
        (Number.isFinite(usage.percentage)
          ? usage.percentage
          : usage.maxTokens > 0
            ? (usage.totalTokens / usage.maxTokens) * 100
            : undefined);
      if (typeof pct === "number" && Number.isFinite(pct)) contextPercent = Math.round(pct);
    }
    return {
      chatId,
      title: chat.title,
      projectId: chat.projectId,
      status: live ?? chat.status ?? "idle",
      dormant: live === undefined,
      blockedOnHuman: live === "awaiting-input" || this.isBlockedOnHuman(chatId),
      lastUserMessageAt: chat.lastUserMessageAt,
      updatedAt: chat.updatedAt ?? chat.createdAt,
      prs: await this.prStatuses(chat),
      reviewOf: chat.reviewOf,
      ...(await this.familyOf(chat)),
      contextPercent,
      heldMessages: this.held.get(chatId)?.length ?? 0,
    };
  }

  /* ------------------------------------------------------------ internals */

  /** Parent and children, or nothing when no lookup is wired or it fails. */
  private async familyOf(chat: Chat): Promise<Partial<ChatFamily>> {
    const f = await this.family?.(chat).catch(() => null);
    if (!f) return {};
    return { ...(f.parent ? { parent: f.parent } : {}), children: f.children };
  }

  /** The chat's refs joined to the registry; refs alone when it can't be read. */
  private async prStatuses(chat: Chat): Promise<ChatPrStatus[]> {
    if (!chat.prs?.length) return [];
    const rows = new Map<string, PrRecord | null>();
    await Promise.all(
      chat.prs.map(async (ref) => {
        if (!ref.repo) return;
        const key = prRecordKey(ref.repo, ref.number);
        rows.set(key, (await this.getPrRecord?.(key).catch(() => null)) ?? null);
      }),
    );
    return chatPrStatuses(chat.prs, (key) => rows.get(key));
  }

  /**
   * Everything that can refuse a send, in the order that gives the most useful
   * answer: identity, then existence, then budget. Also resolves the sender's
   * denormalised attribution, since it needs the sender's record anyway.
   */
  private async admit(
    sender: MessageSender,
    to: string,
  ): Promise<({ ok: true; attribution: Attribution }) | (PeerSendResult & { ok: false })> {
    const from = senderKey(sender);
    if ("chatId" in sender && sender.chatId === to) {
      return {
        ok: false,
        refusal: "self",
        message:
          "A chat cannot message itself — you are already here. Say it in your own " +
          "turn instead.",
      };
    }
    const target = await this.getChat(to);
    if (!target) {
      return {
        ok: false,
        refusal: "unknown-chat",
        message: `No chat "${to}" exists. Find the right id with chat_find.`,
      };
    }
    const now = this.now();
    const pairKey = `${from}\0${to}`;
    const pair = prune(this.pairSends, pairKey, now, PEER_PAIR_WINDOW_MS);
    // The window is a SLIDING one, so the budget frees up when its oldest entry
    // ages out — not `now + window`, which would over-state the wait by the age
    // of that entry and park a caller far longer than the limit actually asks.
    const pairOldest = pair[0];
    if (pairOldest !== undefined && pair.length >= PEER_PAIR_LIMIT) {
      const retryAt = pairOldest + PEER_PAIR_WINDOW_MS;
      return {
        ok: false,
        refusal: "rate-limited-pair",
        retryAt,
        message:
          `Rate limit: ${PEER_PAIR_LIMIT} messages per ${
            PEER_PAIR_WINDOW_MS / 60_000
          } minutes from one chat to another, and you have used them all on ${to}. ` +
          `The budget frees up at ${new Date(retryAt).toISOString()}. ` +
          "This limit exists to stop two chats ping-ponging forever — if you are in a " +
          "loop with that chat, stop and do the work instead.",
      };
    }
    const inbound = prune(this.targetSends, to, now, PEER_TARGET_WINDOW_MS);
    const inboundOldest = inbound[0];
    if (inboundOldest !== undefined && inbound.length >= PEER_TARGET_LIMIT) {
      const retryAt = inboundOldest + PEER_TARGET_WINDOW_MS;
      return {
        ok: false,
        refusal: "rate-limited-target",
        retryAt,
        message:
          `Rate limit: chat ${to} has received ${PEER_TARGET_LIMIT} peer messages in ` +
          `the last ${PEER_TARGET_WINDOW_MS / 60_000} minutes, from all senders ` +
          `combined. It frees up at ${new Date(retryAt).toISOString()}.`,
      };
    }

    if ("channel" in sender) {
      // Attribution is the name (and the trust its token was resolved to): an
      // integration has no title to look up and no project of its own.
      // `askId`, when there is one, is added by `ask`.
      const { name, trust } = sender.channel;
      return { ok: true, attribution: { channel: { name, ...(trust === "owner" ? { trust } : {}) } } };
    }
    const record = await this.getChat(sender.chatId);
    return {
      ok: true,
      attribution: {
        peer: {
          chatId: sender.chatId,
          title: record?.title,
          projectId: record?.projectId,
        },
      },
    };
  }

  /** Wake the target if needed, then deliver now or park it. */
  private async deliver(input: {
    from: string;
    to: string;
    text: string;
    peer?: PeerSender;
    channel?: ChannelSender;
    delivery: PeerDelivery;
  }): Promise<PeerSendResult> {
    const { from, to, text, peer, channel, delivery } = input;
    const woke = this.getStatus(to) === undefined;
    // Established idiom (ResumeScheduler, PrReviewWatcher): a chat that finished
    // has no subprocess, and refusing to resume one would make a project manager
    // unable to reach any developer that had already reported done.
    await this.ensureSession(to);

    // Budget is spent on ACCEPTANCE, not on delivery: a held message has already
    // committed the target to a turn, so not counting it would let a burst park
    // twenty messages under one message's worth of budget.
    const now = this.now();
    push(this.pairSends, `${from}\0${to}`, now);
    push(this.targetSends, to, now);

    const status = this.getStatus(to);
    // `awaiting-input` holds regardless of DELIVERY, which is why it is tested
    // apart from the mid-turn check below. `interrupt` buys the right to derail
    // a turn; it does not buy the right to dismiss a card the human is looking
    // at, and `sendMessage` reads any incoming message as an implicit decline of
    // a pending question — so an interrupt there resolves somebody's
    // `ask_user` as denied, attributes the denial to the human, and feeds the
    // peer's text back as the reply they never gave.
    const blocking = status === "awaiting-input";
    if (status !== undefined && (blocking || (delivery === "queue" && MID_TURN.has(status)))) {
      const queue = this.held.get(to);
      const held: HeldMessage = { from, text, ...(peer ? { peer } : {}), ...(channel ? { channel } : {}) };
      if (queue) queue.push(held);
      else this.held.set(to, [held]);
      this.watchStatus();
      return { ok: true, held: true, woke };
    }

    // `interrupt` needs nothing extra here: injecting mid-turn is simply what
    // the broker already does when a turn is live, so the ONLY difference
    // between the two deliveries is whether we parked the message first.
    await this.sendFn(to, text, { ...(peer ? { peer } : {}), ...(channel ? { channel } : {}) });
    return {
      ok: true,
      held: false,
      // Read BEFORE the send: afterwards the target is running either way, so
      // asking then could never distinguish the two. `IN_FLIGHT`, not
      // `MID_TURN` — a `queued` chat has no turn to interrupt.
      interrupted: status !== undefined && IN_FLIGHT.has(status),
      woke,
    };
  }

  /**
   * Subscribe to `chat-status` once, lazily, and only while something is held.
   *
   * Lazy because the overwhelming majority of sessions never hold a message, and
   * a permanent subscriber on a bus every chat publishes to is a cost paid by
   * everyone for a feature almost nobody used that turn.
   */
  private watchStatus(): void {
    if (this.offStatus || this.disposed) return;
    this.offStatus = this.bus.on("chat-status", (e) => {
      if (MID_TURN.has(e.status)) return;
      void this.flush(e.chatId);
    });
  }

  /** Deliver everything parked for `chatId`, oldest first. */
  private async flush(chatId: string): Promise<void> {
    const queue = this.held.get(chatId);
    if (!queue?.length) return;
    // Detached before the first await: a message delivered here starts a turn,
    // which republishes `chat-status`, which re-enters this method. Without the
    // handoff the re-entrant call sees the same queue and double-sends it.
    this.held.delete(chatId);
    if (this.held.size === 0) this.unwatch();
    this.flushing.set(chatId, (this.flushing.get(chatId) ?? 0) + 1);
    try {
      await this.deliverQueue(chatId, queue);
    } finally {
      const left = (this.flushing.get(chatId) ?? 1) - 1;
      if (left > 0) this.flushing.set(chatId, left);
      else this.flushing.delete(chatId);
    }
  }

  /**
   * Whether a peer message for `chatId` is parked or on its way into a turn.
   *
   * For callers that treat an at-rest status as "this chat has stopped": a
   * flush turns a message into a turn, so during one the chat is between turns,
   * not done. The completion notice is the first caller.
   */
  hasPending(chatId: string): boolean {
    return (this.flushing.get(chatId) ?? 0) > 0 || (this.held.get(chatId)?.length ?? 0) > 0;
  }

  private async deliverQueue(chatId: string, queue: HeldMessage[]): Promise<void> {
    for (const msg of queue) {
      // Re-checked per message, not just once in `dropHeld`: the queue is
      // detached above, so an ask that expires WHILE this loop is awaiting an
      // earlier message is out of `dropHeld`'s reach. Delivering it anyway costs
      // the target a whole turn answering a question nobody is holding.
      const askId = heldAskId(msg);
      if (askId && !this.pendingAsks.has(askId)) continue;
      try {
        await this.sendFn(chatId, msg.text, {
          ...(msg.peer ? { peer: msg.peer } : {}),
          ...(msg.channel ? { channel: msg.channel } : {}),
        });
      } catch {
        // The target died between parking and flushing. Dropping is the honest
        // outcome — re-parking it would spin against a session that is gone.
      }
    }
  }

  /**
   * Pull a still-parked question back once its asker has stopped waiting.
   *
   * Without this a timed-out ask is delivered anyway the moment the target's
   * turn ends: the target wakes, spends a WHOLE TURN composing an answer, calls
   * `chat_reply`, and is told the askId is unknown. Observed end-to-end — the
   * asker had moved on 40 seconds earlier. Nobody is served by delivering a
   * question nobody is waiting on.
   *
   * Only ever removes a HELD message. One already handed to the broker is gone;
   * there is no recalling it, and the stale-`chat_reply` path is the backstop.
   */
  private dropHeld(chatId: string, askId: string): boolean {
    const queue = this.held.get(chatId);
    if (!queue) return false;
    const i = queue.findIndex((m) => heldAskId(m) === askId);
    if (i < 0) return false;
    queue.splice(i, 1);
    if (queue.length === 0) {
      this.held.delete(chatId);
      if (this.held.size === 0) this.unwatch();
    }
    return true;
  }

  private unwatch(): void {
    this.offStatus?.();
    this.offStatus = undefined;
  }

  /** Release every pending ask and parked message (teardown). */
  dispose(): void {
    this.disposed = true;
    this.unwatch();
    for (const pending of [...this.pendingAsks.values()]) pending.cancel("cancelled");
    this.pendingAsks.clear();
    this.held.clear();
  }
}

/* ------------------------------------------------------------- helpers */

/** What a delivered row is stamped with — exactly one of the two. */
type Attribution = { peer: PeerSender; channel?: undefined } | { channel: ChannelSender; peer?: undefined };

/**
 * Resolve the public `send`/`ask` input to a sender. `channel` wins when both
 * are given: a caller that names an integration is speaking FOR it, and a chat
 * id alongside would be a forged peer attribution.
 */
function senderOf(input: { from?: string; channel?: ChannelSender }): MessageSender {
  if (input.channel) return { channel: input.channel };
  if (input.from) return { chatId: input.from };
  throw new Error("a message needs a sender: `from` (a chat) or `channel` (an integration)");
}

/** Drop timestamps older than `windowMs` and return what is left (in place). */
function prune(
  map: Map<string, number[]>,
  key: string,
  now: number,
  windowMs: number,
): number[] {
  const all = map.get(key);
  if (!all) return [];
  const cutoff = now - windowMs;
  const kept = all.filter((t) => t > cutoff);
  if (kept.length) map.set(key, kept);
  else map.delete(key);
  return kept;
}

function push(map: Map<string, number[]>, key: string, at: number): void {
  const all = map.get(key);
  if (all) all.push(at);
  else map.set(key, [at]);
}
