import { describe, it, expect } from "vitest";
import type { ChatStatus } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { ChatCompletionNotices, NOTICE_TTL_MS } from "./chat-completion-notice.js";

interface Sent {
  from: string;
  to: string;
  message: string;
}

/**
 * The service with the bus real and everything else faked, including the TTL
 * timer — the expiry assertion turns on a whole day passing.
 */
function harness(opts: { titles?: Record<string, string>; sendFails?: boolean } = {}) {
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
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;

  const notices = new ChatCompletionNotices({
    bus,
    send: async (input) => {
      if (opts.sendFails) throw new Error("rate limited");
      sent.push(input);
    },
    getTitle: async (chatId) => opts.titles?.[chatId],
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

  const status = (chatId: string, s: ChatStatus): void => {
    bus.publish({ type: "chat-status", chatId, status: s });
  };
  /** Run every pending timer, as if its delay had elapsed. */
  const fireTimers = (): void => {
    for (const [, t] of [...timers]) t.fn();
  };

  return { notices, sent, status, fireTimers, timers, bus, subs: () => subs };
}

/** Drain the microtask queue so a `void this.fire(...)` has landed. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("ChatCompletionNotices", () => {
  it("messages the parent once the child has run and come to rest", async () => {
    const h = harness({ titles: { child: "Fix the flaky test" } });
    h.notices.arm({ chatId: "child", parentChatId: "parent", title: "New chat" });

    h.status("child", "running");
    h.status("child", "idle");
    await settle();

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
    await settle();
    expect(h.sent).toEqual([]);
    expect(h.notices.pending("child")).toBe(true);

    h.status("child", "running");
    h.status("child", "idle");
    await settle();
    expect(h.sent).toHaveLength(1);
  });

  it("does not fire while the child is mid-turn or waiting on the human", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });

    for (const s of ["running", "queued", "waiting", "awaiting-input"] as ChatStatus[]) {
      h.status("child", s);
    }
    await settle();
    expect(h.sent).toEqual([]);
    expect(h.notices.pending("child")).toBe(true);
  });

  it("fires on a failed or errored turn too, and says the work may be unfinished", async () => {
    for (const s of ["failed", "error"] as ChatStatus[]) {
      const h = harness();
      h.notices.arm({ chatId: "child", parentChatId: "parent", title: "Risky job" });
      h.status("child", "running");
      h.status("child", s);
      await settle();
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].message).toContain("stopped on an error");
    }
  });

  it("notifies only once, however many at-rest events follow", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.status("child", "running");
    h.status("child", "idle");
    h.status("child", "running");
    h.status("child", "idle");
    await settle();
    expect(h.sent).toHaveLength(1);
  });

  it("re-arming replaces the pending notice instead of stacking a second", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.status("child", "running");
    h.status("child", "idle");
    await settle();
    expect(h.sent).toHaveLength(1);
    expect(h.timers.size).toBe(0);
  });

  it("ignores chats it was never armed for", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    h.status("someone-else", "running");
    h.status("someone-else", "idle");
    await settle();
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
    await settle();
    expect(h.sent).toEqual([]);
  });

  it("expires a notice for a child that never comes to rest", async () => {
    const h = harness();
    h.notices.arm({ chatId: "child", parentChatId: "parent" });
    expect([...h.timers.values()][0].ms).toBe(NOTICE_TTL_MS);

    h.fireTimers();
    expect(h.notices.pending("child")).toBe(false);

    h.status("child", "running");
    h.status("child", "idle");
    await settle();
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
    await settle();
    expect(h.notices.pending("child")).toBe(false);
  });
});
