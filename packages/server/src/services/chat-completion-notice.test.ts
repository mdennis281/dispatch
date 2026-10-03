import { describe, it, expect } from "vitest";
import type { ChatStatus } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import {
  ChatCompletionNotices,
  NOTICE_QUIESCE_TRIES,
  NOTICE_SETTLE_MS,
  NOTICE_TTL_MS,
} from "./chat-completion-notice.js";

interface Sent {
  from: string;
  to: string;
  message: string;
}

/**
 * The service with the bus real and everything else faked, including both
 * timers: every assertion here turns on one of the two windows elapsing, and a
 * real `setTimeout` would make them either slow or flaky.
 *
 * `status` doubles as the live-status source and as what the published events
 * claim, so a test cannot accidentally assert on a status the broker would
 * contradict a moment later.
 */
function harness(
  opts: { titles?: Record<string, string>; sendFails?: boolean } = {},
) {
  const bus = new EventBus();
  // `EventBus.listenerCount()` counts the ALL channel, not per-type
  // subscribers, so the lazy-subscribe assertion counts them here instead.
  let subs = 0;
  const realOn = bus.on.bind(bus);
  bus.on = ((type: Parameters<typeof realOn>[0], fn: Parameters<typeof realOn>[1]) => {
    subs += 1;
    const off = realOn(type, fn);
    return () => {
      subs -= 1;
      off();
    };
  }) as typeof bus.on;

  const sent: Sent[] = [];
  const live = new Map<string, ChatStatus>();
  /** Chats the broker/messenger say have a turn about to open. */
  const pending = new Set<string>();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;

  const notices = new ChatCompletionNotices({
    bus,
    send: async (input) => {
      if (opts.sendFails) throw new Error("rate limited");
      sent.push(input);
    },
    getTitle: async (chatId) => opts.titles?.[chatId],
    getStatus: (chatId) => live.get(chatId),
    hasPendingWork: (chatId) => pending.has(chatId),
    deps: {
      setTimer: (fn, ms) => {
        const id = nextTimer++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: (h) => {
        timers.delete(h as number);
      },
    },
  });

  /** Publish a status, and make it the live one the re-check will read. */
  const status = (chatId: string, s: ChatStatus): void => {
    live.set(chatId, s);
    bus.publish({ type: "chat-status", chatId, status: s });
  };
  /**
   * Change the live status WITHOUT publishing an event — the mid-flight flush,
   * and (with `undefined`) a session that went away entirely.
   */
  const quietly = (chatId: string, s: ChatStatus | undefined): void => {
    if (s === undefined) live.delete(chatId);
    else live.set(chatId, s);
  };
  const fire = (ms: number): void => {
    for (const [id, t] of [...timers]) {
      if (t.ms !== ms) continue;
      timers.delete(id);
      t.fn();
    }
  };
  /** Let the settle window elapse. */
  const settle = async (): Promise<void> => {
    fire(NOTICE_SETTLE_MS);
    // Drain the microtask queue so the `void this.fire(...)` has landed.
    await new Promise((r) => setImmediate(r));
  };

  return {
    notices,
    sent,
    status,
    quietly,
    settle,
    expire: () => fire(NOTICE_TTL_MS),
    pending,
    timers,
    subs: () => subs,
  };
}

describe("ChatCompletionNotices", () => {
  it("messages the parent once the child has run and come to rest", async () => {
    const h = harness({ titles: { child: "Fix the flaky test" } });
    h.notices.arm({ chatId: "child", parentChatId: "parent", title: "New chat" });

    h.status("child", "running");
    h.status("child", "idle");
    await h.settle();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ from: "child", to: "parent" });
    // The LIVE title, not the placeholder it was armed with.
    expect(h.sent[0].message).toContain("Fix the flaky test");
    expect(h.sent[0].message).toContain('chat_read({ chatId: "child" })');
    expect(h.notices.pending("child")).toBe(false);
  });

  /**
   * The bug the `working` gate exists for: `arm` is called moments after
   * `ensureSession`, and a session with no work yet publishes `idle`. Firing on
   * that announces the child as finished before its brief was delivered.
   */
  it("ignores the at-rest status a fresh session publishes before its brief", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });

    h.status("child", "idle");
    await h.settle();
    expect(h.sent).toEqual([]);
    expect(h.notices.pending("child")).toBe(true);

    h.status("child", "running");
    h.status("child", "idle");
    await h.settle();
    expect(h.sent).toHaveLength(1);
  });

  it("does not fire while the child is mid-turn or waiting on the human", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });

    for (const s of ["running", "queued", "waiting", "awaiting-input"] as ChatStatus[]) {
      h.status("child", s);
    }
    await h.settle();
    expect(h.sent).toEqual([]);
    expect(h.notices.pending("child")).toBe(true);
  });

  /**
   * `onTurnEnd` publishes `idle` and THEN flushes whatever was queued during the
   * turn, so the raw edge is not proof the child has stopped. Here the restart
   * is only visible in the live status — no event for it — which is exactly the
   * case the timer's re-check is the backstop for.
   */
  it("does not fire when a queued message restarted the child mid-flight", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.status("child", "running");
    h.status("child", "idle");
    h.quietly("child", "running");

    await h.settle();
    expect(h.sent).toEqual([]);
    expect(h.notices.pending("child")).toBe(true);

    // …and the notice is still good for whenever THAT turn ends.
    h.status("child", "idle");
    await h.settle();
    expect(h.sent).toHaveLength(1);
  });

  /**
   * The case the settle window alone cannot catch: preparing the queued turn
   * (posture refresh, rules lookup, the user row) outruns any elapsed-time
   * guess, so the re-read still sees `idle`. The queue itself is the fact that
   * settles it.
   */
  it("does not fire while the broker still has work queued for the child", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.status("child", "running");
    h.pending.add("child");
    h.status("child", "idle");

    await h.settle();
    expect(h.sent).toEqual([]);
    expect(h.notices.pending("child")).toBe(true);

    // The queued turn ran and ended; now there is nothing left behind it.
    h.status("child", "running");
    h.pending.delete("child");
    h.status("child", "idle");
    await h.settle();
    expect(h.sent).toHaveLength(1);
  });

  /**
   * The re-check is the only thing watching this transition: both flushers
   * swallow a delivery error and simply drop their pending flag, so a send that
   * was preparing at the first check and then FAILED publishes no status at all.
   * Without re-checking the notice would sit armed until its TTL.
   */
  it("re-checks until the queue clears, even with no status event to prompt it", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.status("child", "running");
    h.pending.add("child");
    h.status("child", "idle");

    await h.settle();
    expect(h.sent).toEqual([]);

    // The send died in preparation: the flag clears, nothing is published.
    h.pending.delete("child");
    await h.settle();
    expect(h.sent).toHaveLength(1);
  });

  it("stops re-checking after its budget and waits for the next edge", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.status("child", "running");
    h.pending.add("child");
    h.status("child", "idle");

    for (let i = 0; i <= NOTICE_QUIESCE_TRIES; i += 1) await h.settle();
    expect(h.sent).toEqual([]);
    // Budget spent: nothing left polling, but the notice is still good.
    expect([...h.timers.values()].some((t) => t.ms === NOTICE_SETTLE_MS)).toBe(false);
    expect(h.notices.pending("child")).toBe(true);

    // A fresh edge buys a fresh budget.
    h.pending.delete("child");
    h.status("child", "running");
    h.status("child", "idle");
    await h.settle();
    expect(h.sent).toHaveLength(1);
  });

  it("cancels a pending notice when a working status arrives inside the window", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.status("child", "running");
    h.status("child", "idle");
    h.status("child", "running");

    await h.settle();
    expect(h.sent).toEqual([]);
    expect(h.notices.pending("child")).toBe(true);
  });

  /** No live session at all is the most finished a chat gets. */
  it("fires when the chat has no live status to re-read", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.status("child", "running");
    h.status("child", "idle");
    h.quietly("child", undefined);

    await h.settle();
    expect(h.sent).toHaveLength(1);
  });

  it("fires on a failed or errored turn too, and says the work may be unfinished", async () => {
    for (const s of ["failed", "error"] as ChatStatus[]) {
      const h = harness();
      h.notices.arm({ chatId: "child", parentChatId: "parent", title: "Risky job" });
      h.status("child", "running");
      h.status("child", s);
      await h.settle();
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].message).toContain("stopped on an error");
    }
  });

  it("notifies only once, however many at-rest events follow", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.status("child", "running");
    h.status("child", "idle");
    h.status("child", "idle");
    await h.settle();
    expect(h.sent).toHaveLength(1);

    h.status("child", "running");
    h.status("child", "idle");
    await h.settle();
    expect(h.sent).toHaveLength(1);
  });

  it("re-arming replaces the pending notice instead of stacking a second", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.status("child", "running");
    h.status("child", "idle");
    await h.settle();
    expect(h.sent).toHaveLength(1);
    // Both the TTL and the settle timer are cleaned up.
    expect(h.timers.size).toBe(0);
  });

  it("ignores chats it was never armed for", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.status("someone-else", "running");
    h.status("someone-else", "idle");
    await h.settle();
    expect(h.sent).toEqual([]);
  });

  it("refuses to arm a chat against itself", () => {
    const h = harness();
    h.notices.arm({ chatId: "c1", parentChatId: "c1" });
    expect(h.notices.pending("c1")).toBe(false);
  });

  it("disarm drops the notice without sending it", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.notices.disarm("child");
    h.status("child", "running");
    h.status("child", "idle");
    await h.settle();
    expect(h.sent).toEqual([]);
  });

  it("expires a notice for a child that never comes to rest", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    expect([...h.timers.values()][0].ms).toBe(NOTICE_TTL_MS);

    h.expire();
    expect(h.notices.pending("child")).toBe(false);

    h.status("child", "running");
    h.status("child", "idle");
    await h.settle();
    expect(h.sent).toEqual([]);
  });

  it("unsubscribes from the bus once nothing is armed", () => {
    const h = harness();
    expect(h.subs()).toBe(0);
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    expect(h.subs()).toBe(1);
    h.notices.arm({ chatId: "child2", parentChatId: "parent" });
    expect(h.subs()).toBe(1);
    h.notices.disarm("child");
    expect(h.subs()).toBe(1);
    h.notices.disarm("child2");
    expect(h.subs()).toBe(0);
  });

  it("dispose drops everything and stops arming", () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.notices.dispose();
    expect(h.notices.pending("child")).toBe(false);
    expect(h.timers.size).toBe(0);
    h.notices.arm({ chatId: "child2", parentChatId: "parent" });
    expect(h.notices.pending("child2")).toBe(false);
  });

  /**
   * A refused delivery — the parent was deleted, the peer rate limit said no —
   * must not become an unhandled rejection. There is nobody left to report it to.
   */
  it("swallows a delivery failure", async () => {
    const h = harness({ sendFails: true });
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.status("child", "running");
    h.status("child", "idle");
    await h.settle();
    expect(h.notices.pending("child")).toBe(false);
  });
});
