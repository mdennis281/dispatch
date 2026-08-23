import { describe, it, expect, beforeEach } from "vitest";
import type { Chat, ChatStatus, ContextUsage, PeerSender } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import {
  ChatMessenger,
  PEER_PAIR_LIMIT,
  PEER_PAIR_WINDOW_MS,
  PEER_TARGET_LIMIT,
  PEER_TARGET_WINDOW_MS,
} from "./chat-messenger.js";

/** One delivered message, as the fake broker saw it. */
interface Delivered {
  chatId: string;
  text: string;
  peer: PeerSender;
}

/**
 * A messenger wired to fakes, with the clock and the ask timer under test
 * control — every rate-limit assertion here turns on time passing, and a real
 * `Date.now()` would make those tests either slow or flaky.
 */
function harness(
  opts: { chats?: Partial<Chat>[]; contextUsage?: ContextUsage | null } = {},
) {
  const bus = new EventBus();
  const delivered: Delivered[] = [];
  const woken: string[] = [];
  /** chatId → live status. Absent from the map = no live session (dormant). */
  const status = new Map<string, ChatStatus>();
  let now = 1_000_000;
  /** Pending fake timers, so a test can fire an ask timeout deterministically. */
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let nextAsk = 1;

  const chats = new Map<string, Chat>();
  for (const partial of opts.chats ?? []) {
    const chat = {
      id: "c?",
      projectId: "p1",
      title: "a chat",
      modeId: "default",
      effort: "medium",
      worktrees: [],
      prs: [],
      createdAt: 1,
      updatedAt: 2,
      ...partial,
    } as Chat;
    chats.set(chat.id, chat);
  }

  const messenger = new ChatMessenger({
    bus,
    getChat: async (id) => chats.get(id) ?? null,
    ensureSession: async (id) => {
      if (!status.has(id)) {
        woken.push(id);
        status.set(id, "idle");
      }
    },
    getStatus: (id) => status.get(id),
    send: async (chatId, text, { peer }) => {
      delivered.push({ chatId, text, peer });
    },
    getContextUsage: async () => opts.contextUsage ?? null,
    deps: {
      now: () => now,
      genId: () => `ask_${nextAsk++}`,
      setTimer: (fn) => {
        const id = nextTimer++;
        timers.set(id, fn);
        return id;
      },
      clearTimer: (h) => {
        timers.delete(h as number);
      },
    },
  });

  return {
    bus,
    messenger,
    delivered,
    woken,
    chats,
    /** Put a chat into a live status without going through the messenger. */
    setStatus: (id: string, s: ChatStatus) => status.set(id, s),
    /** Drop a chat's session entirely — i.e. make it dormant. */
    kill: (id: string) => status.delete(id),
    advance: (ms: number) => {
      now += ms;
    },
    /** Fire every armed timer (there is at most one per in-flight ask). */
    fireTimers: () => {
      const fns = [...timers.values()];
      timers.clear();
      for (const fn of fns) fn();
    },
    /** Publish the status change the broker would publish when a turn ends. */
    settle: (chatId: string, s: ChatStatus = "idle") => {
      status.set(chatId, s);
      bus.publish({ type: "chat-status", chatId, status: s });
    },
  };
}

/** Two chats, both live and idle — the ordinary starting point. */
function twoChats() {
  const h = harness({
    chats: [
      { id: "lead", title: "Team lead", projectId: "p1" },
      { id: "dev", title: "Developer", projectId: "p1" },
    ],
  });
  h.setStatus("lead", "idle");
  h.setStatus("dev", "idle");
  return h;
}

describe("ChatMessenger.send", () => {
  it("delivers to an idle chat and attributes it to the sender", async () => {
    const h = twoChats();
    const result = await h.messenger.send({ from: "lead", to: "dev", message: "ship it" });

    expect(result.ok).toBe(true);
    expect(result.held).toBe(false);
    expect(h.delivered).toEqual([
      {
        chatId: "dev",
        text: "ship it",
        // Denormalised on purpose: the sender may be gone by the time anyone
        // reads the row, so the title has to travel with it.
        peer: { chatId: "lead", title: "Team lead", projectId: "p1" },
      },
    ]);
  });

  it("refuses a chat messaging itself", async () => {
    const h = twoChats();
    const result = await h.messenger.send({ from: "lead", to: "lead", message: "hi" });

    expect(result.ok).toBe(false);
    expect(result.refusal).toBe("self");
    expect(h.delivered).toHaveLength(0);
  });

  it("refuses a target that does not exist", async () => {
    const h = twoChats();
    const result = await h.messenger.send({ from: "lead", to: "ghost", message: "hi" });

    expect(result.ok).toBe(false);
    expect(result.refusal).toBe("unknown-chat");
    expect(result.message).toContain("chat_find");
    expect(h.delivered).toHaveLength(0);
  });

  it("wakes a dormant target rather than refusing to reach it", async () => {
    const h = twoChats();
    h.kill("dev"); // the developer finished and its subprocess is gone

    const result = await h.messenger.send({ from: "lead", to: "dev", message: "one more thing" });

    expect(result.ok).toBe(true);
    expect(result.woke).toBe(true);
    expect(h.woken).toEqual(["dev"]);
    expect(h.delivered).toHaveLength(1);
  });
});

describe("ChatMessenger delivery mode", () => {
  // Every status that means a turn is in flight, plus `awaiting-input` — a chat
  // with a card open in front of the human, where delivering would count as an
  // implicit decline of a question somebody else was about to answer.
  for (const status of ["running", "waiting", "queued", "awaiting-input"] as const) {
    it(`queue holds a message while the target is ${status}`, async () => {
      const h = twoChats();
      h.setStatus("dev", status);

      const result = await h.messenger.send({ from: "lead", to: "dev", message: "later" });

      expect(result.ok).toBe(true);
      expect(result.held).toBe(true);
      expect(h.delivered).toHaveLength(0);
    });
  }

  it("flushes held messages in order once the turn settles", async () => {
    const h = twoChats();
    h.setStatus("dev", "running");
    await h.messenger.send({ from: "lead", to: "dev", message: "first" });
    await h.messenger.send({ from: "lead", to: "dev", message: "second" });
    expect(h.delivered).toHaveLength(0);

    h.settle("dev", "idle");
    await new Promise((r) => setImmediate(r));

    expect(h.delivered.map((d) => d.text)).toEqual(["first", "second"]);
  });

  it("does not flush on a status change that is still mid-turn", async () => {
    const h = twoChats();
    h.setStatus("dev", "running");
    await h.messenger.send({ from: "lead", to: "dev", message: "later" });

    h.settle("dev", "waiting");
    await new Promise((r) => setImmediate(r));

    expect(h.delivered).toHaveLength(0);
  });

  it("holds an INTERRUPT too when the target is blocked on a human", async () => {
    const h = twoChats();
    h.setStatus("dev", "awaiting-input");

    const result = await h.messenger.send({
      from: "lead",
      to: "dev",
      message: "stop, wrong branch",
      delivery: "interrupt",
    });

    // `interrupt` buys derailing a TURN, not dismissing a card the human is
    // looking at: the broker reads any incoming message as an implicit decline
    // of a pending question, so delivering here would resolve somebody's
    // `ask_user` as denied and attribute the denial to the human.
    expect(result.held).toBe(true);
    expect(h.delivered).toHaveLength(0);

    h.settle("dev", "idle");
    await new Promise((r) => setImmediate(r));
    expect(h.delivered.map((d) => d.text)).toEqual(["stop, wrong branch"]);
  });

  it("reports an interrupt as an interrupt, not as a delivery to an idle chat", async () => {
    const h = twoChats();
    h.setStatus("dev", "running");

    const result = await h.messenger.send({
      from: "lead",
      to: "dev",
      message: "now",
      delivery: "interrupt",
    });

    // Falling through to "it was idle" contradicted the `chat_state` a caller
    // may have run a second earlier.
    expect(result.interrupted).toBe(true);
    expect(result.held).toBe(false);
  });

  it("does not call a plain idle delivery an interrupt", async () => {
    const h = twoChats();
    const result = await h.messenger.send({
      from: "lead",
      to: "dev",
      message: "now",
      delivery: "interrupt",
    });
    expect(result.interrupted).toBe(false);
  });

  it("interrupt delivers immediately even mid-turn", async () => {
    const h = twoChats();
    h.setStatus("dev", "running");

    const result = await h.messenger.send({
      from: "lead",
      to: "dev",
      message: "stop, wrong branch",
      delivery: "interrupt",
    });

    expect(result.held).toBe(false);
    expect(h.delivered.map((d) => d.text)).toEqual(["stop, wrong branch"]);
  });

  it("only flushes the chat that settled", async () => {
    const h = harness({
      chats: [
        { id: "lead", title: "Lead", projectId: "p1" },
        { id: "a", title: "A", projectId: "p1" },
        { id: "b", title: "B", projectId: "p1" },
      ],
    });
    h.setStatus("lead", "idle");
    h.setStatus("a", "running");
    h.setStatus("b", "running");
    await h.messenger.send({ from: "lead", to: "a", message: "for a" });
    await h.messenger.send({ from: "lead", to: "b", message: "for b" });

    h.settle("a", "idle");
    await new Promise((r) => setImmediate(r));

    expect(h.delivered.map((d) => d.chatId)).toEqual(["a"]);
  });
});

describe("ChatMessenger rate limits", () => {
  it(`refuses the ${PEER_PAIR_LIMIT + 1}th message from one chat to another`, async () => {
    const h = twoChats();
    for (let i = 0; i < PEER_PAIR_LIMIT; i++) {
      const ok = await h.messenger.send({ from: "lead", to: "dev", message: `m${i}` });
      expect(ok.ok).toBe(true);
    }

    const refused = await h.messenger.send({ from: "lead", to: "dev", message: "one too many" });

    expect(refused.ok).toBe(false);
    expect(refused.refusal).toBe("rate-limited-pair");
    expect(refused.message).toContain("ping-pong");
    expect(h.delivered).toHaveLength(PEER_PAIR_LIMIT);
  });

  it("frees the pair budget once the window slides past the oldest send", async () => {
    const h = twoChats();
    for (let i = 0; i < PEER_PAIR_LIMIT; i++) {
      await h.messenger.send({ from: "lead", to: "dev", message: `m${i}` });
    }
    const refused = await h.messenger.send({ from: "lead", to: "dev", message: "blocked" });
    expect(refused.refusal).toBe("rate-limited-pair");
    // The reset is the oldest send ageing out, NOT `now + window`.
    expect(refused.retryAt).toBe(1_000_000 + PEER_PAIR_WINDOW_MS);

    h.advance(PEER_PAIR_WINDOW_MS + 1);
    const after = await h.messenger.send({ from: "lead", to: "dev", message: "allowed" });

    expect(after.ok).toBe(true);
    expect(h.delivered.at(-1)?.text).toBe("allowed");
  });

  it("counts the pair budget per DIRECTION, not per conversation", async () => {
    const h = twoChats();
    for (let i = 0; i < PEER_PAIR_LIMIT; i++) {
      await h.messenger.send({ from: "lead", to: "dev", message: `m${i}` });
    }
    expect((await h.messenger.send({ from: "lead", to: "dev", message: "x" })).ok).toBe(false);

    // dev → lead is a different ordered pair and has its own untouched budget.
    const back = await h.messenger.send({ from: "dev", to: "lead", message: "reply" });
    expect(back.ok).toBe(true);
  });

  it("caps total inbound to one target across many senders", async () => {
    // Enough senders that no single PAIR budget can be what refuses the last
    // one — this asserts the many-to-one backstop specifically.
    const senders = Array.from({ length: 5 }, (_, i) => `s${i}`);
    const h = harness({
      chats: [
        { id: "victim", title: "Victim", projectId: "p1" },
        ...senders.map((id) => ({ id, title: id, projectId: "p1" })),
      ],
    });
    h.setStatus("victim", "idle");
    for (const s of senders) h.setStatus(s, "idle");

    let sent = 0;
    for (const from of senders) {
      for (let i = 0; i < PEER_PAIR_LIMIT && sent < PEER_TARGET_LIMIT; i++) {
        const r = await h.messenger.send({ from, to: "victim", message: `m${sent}` });
        expect(r.ok).toBe(true);
        sent++;
      }
    }
    expect(sent).toBe(PEER_TARGET_LIMIT);

    // A sender with plenty of its own pair budget left is still refused.
    const refused = await h.messenger.send({
      from: senders[senders.length - 1]!,
      to: "victim",
      message: "over",
    });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toBe("rate-limited-target");
    expect(refused.retryAt).toBe(1_000_000 + PEER_TARGET_WINDOW_MS);

    h.advance(PEER_TARGET_WINDOW_MS + 1);
    expect(
      (await h.messenger.send({ from: senders[0]!, to: "victim", message: "after" })).ok,
    ).toBe(true);
  });

  it("charges a HELD message to the budget, so a burst cannot park for free", async () => {
    const h = twoChats();
    h.setStatus("dev", "running");
    for (let i = 0; i < PEER_PAIR_LIMIT; i++) {
      const r = await h.messenger.send({ from: "lead", to: "dev", message: `m${i}` });
      expect(r.held).toBe(true);
    }

    const refused = await h.messenger.send({ from: "lead", to: "dev", message: "over" });
    expect(refused.refusal).toBe("rate-limited-pair");
  });

  it("does not charge a refused send against the budget", async () => {
    const h = twoChats();
    for (let i = 0; i < 3; i++) {
      await h.messenger.send({ from: "lead", to: "ghost", message: "nowhere" });
    }
    // Those three went nowhere, so the real target's budget is untouched.
    for (let i = 0; i < PEER_PAIR_LIMIT; i++) {
      expect((await h.messenger.send({ from: "lead", to: "dev", message: `m${i}` })).ok).toBe(
        true,
      );
    }
  });
});

describe("ChatMessenger.ask / reply", () => {
  it("correlates a reply back to the waiting asker", async () => {
    const h = twoChats();
    const pending = h.messenger.ask({
      from: "lead",
      to: "dev",
      question: "is it merged?",
      timeoutMs: 30_000,
    });
    await new Promise((r) => setImmediate(r));

    // The question rides on the row with an askId — that is how the asked chat
    // knows what to pass back to `chat_reply`.
    const askId = h.delivered[0]?.peer.askId;
    expect(askId).toBeTruthy();

    const replied = h.messenger.reply({ from: "dev", askId: askId!, answer: "yes, #42" });
    expect(replied).toEqual({ ok: true, askerChatId: "lead" });

    const result = await pending;
    expect(result.answered).toBe(true);
    expect(result.answer).toBe("yes, #42");
  });

  it("returns a NORMAL timeout result rather than an error", async () => {
    const h = twoChats();
    const pending = h.messenger.ask({
      from: "lead",
      to: "dev",
      question: "still there?",
      timeoutMs: 30_000,
    });
    await new Promise((r) => setImmediate(r));

    h.fireTimers();
    const result = await pending;

    // `ok` describes the CALL and stays true; `answered` describes the world.
    expect(result.ok).toBe(true);
    expect(result.answered).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  it("refuses a reply to an askId nobody is waiting on", () => {
    const h = twoChats();
    const result = h.messenger.reply({ from: "dev", askId: "ask_nope", answer: "hello?" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("unknown-ask");
    // Names the tool that CAN still get the words there, since re-replying cannot.
    expect(result.ok === false && result.message).toContain("chat_send");
  });

  it("refuses a reply to an ask that already timed out", async () => {
    const h = twoChats();
    const pending = h.messenger.ask({
      from: "lead",
      to: "dev",
      question: "?",
      timeoutMs: 30_000,
    });
    await new Promise((r) => setImmediate(r));
    const askId = h.delivered[0]!.peer.askId!;
    h.fireTimers();
    await pending;

    const late = h.messenger.reply({ from: "dev", askId, answer: "sorry, was busy" });
    expect(late.ok).toBe(false);
    expect(late.ok === false && late.reason).toBe("unknown-ask");
  });

  it("refuses a reply from a chat that was not the one asked", async () => {
    const h = harness({
      chats: [
        { id: "lead", title: "Lead", projectId: "p1" },
        { id: "dev", title: "Dev", projectId: "p1" },
        { id: "nosy", title: "Nosy", projectId: "p1" },
      ],
    });
    h.setStatus("lead", "idle");
    h.setStatus("dev", "idle");
    h.setStatus("nosy", "idle");

    const pending = h.messenger.ask({
      from: "lead",
      to: "dev",
      question: "?",
      timeoutMs: 30_000,
    });
    await new Promise((r) => setImmediate(r));
    const askId = h.delivered[0]!.peer.askId!;

    const stolen = h.messenger.reply({ from: "nosy", askId, answer: "I'll take this" });
    expect(stolen.ok).toBe(false);
    expect(stolen.ok === false && stolen.reason).toBe("wrong-chat");

    // …and the real one still works.
    expect(h.messenger.reply({ from: "dev", askId, answer: "mine" }).ok).toBe(true);
    await expect(pending).resolves.toMatchObject({ answered: true, answer: "mine" });
  });

  it("an ask to a busy chat is held, then answerable once it settles", async () => {
    const h = twoChats();
    h.setStatus("dev", "running");
    const pending = h.messenger.ask({
      from: "lead",
      to: "dev",
      question: "status?",
      timeoutMs: 30_000,
    });
    await new Promise((r) => setImmediate(r));
    expect(h.delivered).toHaveLength(0);

    h.settle("dev", "idle");
    await new Promise((r) => setImmediate(r));
    expect(h.delivered).toHaveLength(1);

    h.messenger.reply({ from: "dev", askId: h.delivered[0]!.peer.askId!, answer: "done" });
    await expect(pending).resolves.toMatchObject({ answered: true, answer: "done" });
  });

  it("reports a refused ask without ever arming a pending answer", async () => {
    const h = twoChats();
    const result = await h.messenger.ask({
      from: "lead",
      to: "lead",
      question: "?",
      timeoutMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.refusal).toBe("self");
    expect(result.answered).toBe(false);
  });

  it("returns immediately when a signal is ALREADY aborted", async () => {
    const h = twoChats();
    const dead = AbortSignal.abort();

    const result = await h.messenger.ask({
      from: "lead",
      to: "dev",
      question: "?",
      timeoutMs: 3_600_000,
      signals: [dead],
    });

    // addEventListener("abort") never fires on an already-aborted signal, so
    // without the explicit check this parked for the full hour.
    expect(result.answered).toBe(false);
    expect(result.reason).toBe("cancelled");
  });

  it("honours EVERY signal it is given, not just the first", async () => {
    const h = twoChats();
    const perCall = new AbortController();
    const session = new AbortController();
    const pending = h.messenger.ask({
      from: "lead",
      to: "dev",
      question: "?",
      timeoutMs: 3_600_000,
      signals: [perCall.signal, session.signal],
    });
    await new Promise((r) => setImmediate(r));

    // The SESSION abort — the one a first-wins `??` used to drop on the floor.
    session.abort();

    await expect(pending).resolves.toMatchObject({ answered: false, reason: "cancelled" });
  });

  it("WITHDRAWS a still-parked question when the asker gives up", async () => {
    const h = twoChats();
    h.setStatus("dev", "running");
    const pending = h.messenger.ask({
      from: "lead",
      to: "dev",
      question: "status?",
      timeoutMs: 30_000,
    });
    await new Promise((r) => setImmediate(r));
    expect(h.delivered).toHaveLength(0); // parked behind dev's turn

    h.fireTimers();
    const result = await pending;
    expect(result.answered).toBe(false);
    expect(result.withdrawn).toBe(true);

    // The whole point: dev's turn ends and the dead question does NOT land.
    // Before this, dev woke, spent a turn composing an answer, called
    // chat_reply, and was told the askId was unknown.
    h.settle("dev", "idle");
    await new Promise((r) => setImmediate(r));
    expect(h.delivered).toHaveLength(0);
  });

  it("withdraws only the expired question, leaving the rest of the queue", async () => {
    const h = twoChats();
    h.setStatus("dev", "running");
    await h.messenger.send({ from: "lead", to: "dev", message: "before" });
    const pending = h.messenger.ask({
      from: "lead",
      to: "dev",
      question: "doomed",
      timeoutMs: 30_000,
    });
    await new Promise((r) => setImmediate(r));
    await h.messenger.send({ from: "lead", to: "dev", message: "after" });

    h.fireTimers();
    await pending;

    h.settle("dev", "idle");
    await new Promise((r) => setImmediate(r));
    expect(h.delivered.map((d) => d.text)).toEqual(["before", "after"]);
  });

  it("reports withdrawn:false when the question had already been delivered", async () => {
    const h = twoChats(); // dev is idle, so the ask goes straight out
    const pending = h.messenger.ask({
      from: "lead",
      to: "dev",
      question: "?",
      timeoutMs: 30_000,
    });
    await new Promise((r) => setImmediate(r));
    expect(h.delivered).toHaveLength(1);

    h.fireTimers();
    // Already handed to the broker — there is no recalling it, and saying it was
    // withdrawn would be a lie the caller might act on.
    await expect(pending).resolves.toMatchObject({ answered: false, withdrawn: false });
  });

  it("signals the caller when the wait actually begins, and not when refused", async () => {
    const h = twoChats();
    let waits = 0;
    await h.messenger.ask({
      from: "lead",
      to: "lead",
      question: "?",
      timeoutMs: 30_000,
      onWaiting: () => (waits += 1),
    });
    // Refused outright — the UI must not flash a wait that never happened.
    expect(waits).toBe(0);

    const pending = h.messenger.ask({
      from: "lead",
      to: "dev",
      question: "?",
      timeoutMs: 30_000,
      onWaiting: () => (waits += 1),
    });
    await new Promise((r) => setImmediate(r));
    expect(waits).toBe(1);
    h.messenger.reply({ from: "dev", askId: h.delivered[0]!.peer.askId!, answer: "x" });
    await pending;
  });

  it("releases every waiting asker on dispose", async () => {
    const h = twoChats();
    const pending = h.messenger.ask({
      from: "lead",
      to: "dev",
      question: "?",
      timeoutMs: 30_000,
    });
    await new Promise((r) => setImmediate(r));

    h.messenger.dispose();

    // A blocked chat is told the answer is not coming, rather than hanging on a
    // promise there is no longer anything left to resolve.
    await expect(pending).resolves.toMatchObject({ answered: false, reason: "cancelled" });
  });
});

describe("ChatMessenger.state", () => {
  let h: ReturnType<typeof twoChats>;
  beforeEach(() => {
    h = twoChats();
  });

  it("projects a live chat without waking or disturbing it", async () => {
    h.setStatus("dev", "running");
    const state = await h.messenger.state("dev");

    expect(state).toMatchObject({
      chatId: "dev",
      title: "Developer",
      status: "running",
      dormant: false,
      blockedOnHuman: false,
    });
    expect(h.woken).toEqual([]);
    expect(h.delivered).toEqual([]);
  });

  it("reports a dormant chat from its persisted record", async () => {
    h.kill("dev");
    h.chats.set("dev", { ...h.chats.get("dev")!, status: "done" });

    const state = await h.messenger.state("dev");

    expect(state).toMatchObject({ status: "done", dormant: true });
    expect(h.woken).toEqual([]);
  });

  it("flags a chat that is blocked on a human", async () => {
    h.setStatus("dev", "awaiting-input");
    await expect(h.messenger.state("dev")).resolves.toMatchObject({ blockedOnHuman: true });
  });

  it("counts peer messages queued for a busy chat", async () => {
    h.setStatus("dev", "running");
    await h.messenger.send({ from: "lead", to: "dev", message: "a" });
    await h.messenger.send({ from: "lead", to: "dev", message: "b" });

    await expect(h.messenger.state("dev")).resolves.toMatchObject({ heldMessages: 2 });
  });

  it("returns null for a chat that does not exist", async () => {
    await expect(h.messenger.state("ghost")).resolves.toBeNull();
  });

  it("falls back to createdAt when the chat has never been updated", async () => {
    h.chats.set("dev", { ...h.chats.get("dev")!, createdAt: 555, updatedAt: undefined });
    await expect(h.messenger.state("dev")).resolves.toMatchObject({ updatedAt: 555 });
  });

  it("derives a context percentage when the harness reports only totals", async () => {
    // The neutral harness branch of `getContextUsage` returns no `percentage`.
    // `Math.round(undefined)` is NaN, which reached the agent as "NaN% full".
    const h2 = harness({
      chats: [{ id: "dev", title: "Dev", projectId: "p1" }],
      contextUsage: { totalTokens: 40, maxTokens: 200 } as ContextUsage,
    });
    h2.setStatus("dev", "idle");
    await expect(h2.messenger.state("dev")).resolves.toMatchObject({ contextPercent: 20 });
  });

  it("omits the context percentage rather than reporting NaN", async () => {
    const h2 = harness({
      chats: [{ id: "dev", title: "Dev", projectId: "p1" }],
      contextUsage: { totalTokens: 40, maxTokens: 0 } as ContextUsage,
    });
    h2.setStatus("dev", "idle");
    const state = await h2.messenger.state("dev");
    expect(state?.contextPercent).toBeUndefined();
  });

  it("includes context usage only when a subprocess is live to report it", async () => {
    const live = harness({
      chats: [{ id: "dev", title: "Dev", projectId: "p1" }],
      contextUsage: { totalTokens: 50, maxTokens: 200, percentage: 25.4 } as ContextUsage,
    });
    live.setStatus("dev", "idle");
    await expect(live.messenger.state("dev")).resolves.toMatchObject({ contextPercent: 25 });

    live.kill("dev");
    const dormant = await live.messenger.state("dev");
    expect(dormant?.contextPercent).toBeUndefined();
  });
});
