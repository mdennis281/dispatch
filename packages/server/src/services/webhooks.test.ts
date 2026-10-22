import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, ChatStatus, WsServerEvent } from "@dispatch/shared";
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_PAUSE_AFTER_DEAD,
  WEBHOOK_RETRY_DELAYS_MS,
} from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { NOTICE_SETTLE_MS } from "./chat-completion-notice.js";
import { WebhookService, WEBHOOK_TEST_EVENT, signWebhookBody, verifyWebhookSignature } from "./webhooks.js";
import type { WebhookCaller } from "./webhook-policy.js";

const USER: WebhookCaller = { kind: "user" };
const T0 = Date.parse("2026-10-21T12:00:00.000Z");

interface Received {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * The service with a real store and bus and everything else faked: the clock,
 * both timers, the receiver, and the broker's live status. Every assertion here
 * turns on a timer elapsing or a receiver answering, so nothing real may be
 * involved in either.
 */
function harness(store: Store, opts: { bus?: EventBus; startAt?: number } = {}) {
  const bus = opts.bus ?? new EventBus();
  let now = opts.startAt ?? T0;
  const timers = new Map<number, { fn: () => void; ms: number; at: number }>();
  let nextTimer = 1;
  const received: Received[] = [];
  /** Per-call response plan; the default answers 200. */
  let respond: (req: Received) => { ok: boolean; status: number } | Error = () => ({ ok: true, status: 200 });
  const live = new Map<string, ChatStatus>();
  const pendingWork = new Set<string>();
  const notices: string[] = [];
  bus.on("notice", (e) => notices.push(e.text));

  const svc = new WebhookService({
    bus,
    store,
    now: () => now,
    fetch: async (url, init) => {
      const req: Received = {
        url,
        headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
        body: String(init.body),
      };
      received.push(req);
      const plan = respond(req);
      if (plan instanceof Error) throw plan;
      return plan;
    },
    getStatus: (chatId) => live.get(chatId),
    hasPendingWork: (chatId) => pendingWork.has(chatId),
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms, at: now + ms });
      return id;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
    log: () => {},
  });

  /**
   * Advance the clock to `now + ms`, firing every timer that falls due on the
   * way IN TIME ORDER, with the clock set to each timer's moment as it fires.
   * A retry scheduled by a firing timer lands at that moment plus its delay, so
   * one long advance walks the whole schedule the way wall-clock would.
   */
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, t] = next;
      timers.delete(id);
      now = Math.max(now, t.at);
      t.fn();
      await svc.whenIdle();
    }
    now = target;
  };
  const status = (chatId: string, s: ChatStatus) => {
    live.set(chatId, s);
    bus.publish({ type: "chat-status", chatId, status: s });
  };

  return {
    svc,
    bus,
    received,
    notices,
    timers,
    live,
    pendingWork,
    status,
    advance,
    now: () => now,
    setRespond: (fn: typeof respond) => {
      respond = fn;
    },
    publish: async (evt: WsServerEvent) => {
      bus.publish(evt);
      await svc.whenIdle();
    },
  };
}

let dir: string;
let store: Store;

async function chat(id: string, projectId = "p1"): Promise<Chat> {
  return store.saveChat({
    id,
    projectId,
    title: id,
    harness: "claude",
    modeId: "default",
    status: "idle",
    effort: "medium",
    worktrees: [],
    prs: [],
    createdAt: T0,
    updatedAt: T0,
  } as Chat);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-webhooks-"));
  store = new Store(dir);
  await store.init();
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const userRow = (chatId: string) =>
  ({
    type: "chat-message",
    chatId,
    message: { id: "m1", chatId, turn: 1, kind: "user", text: "hi", ts: T0 },
  }) as WsServerEvent;

describe("signature", () => {
  it("is the Stripe scheme over <t>.<body> and verifies with the receiver half", () => {
    const sig = signWebhookBody("s3cret", '{"a":1}', 1_700_000_000);
    expect(sig).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature("s3cret", '{"a":1}', sig, { nowSeconds: 1_700_000_010 })).toBe(true);
    expect(verifyWebhookSignature("other", '{"a":1}', sig, { nowSeconds: 1_700_000_010 })).toBe(false);
    expect(verifyWebhookSignature("s3cret", '{"a":2}', sig, { nowSeconds: 1_700_000_010 })).toBe(false);
    // A captured delivery replayed an hour later fails on `t` alone.
    expect(verifyWebhookSignature("s3cret", '{"a":1}', sig, { nowSeconds: 1_700_003_601 })).toBe(false);
  });
});

describe("WebhookService", () => {
  it("delivers a matching event, signed, with the delivery id in header and body", async () => {
    const h = harness(store);
    await h.svc.start();
    await chat("c1");
    const sub = await h.svc.create(USER, {
      name: "all",
      url: "https://hooks.example/x",
      filters: { events: ["chat-message"] },
    });
    await h.publish(userRow("c1"));

    expect(h.received).toHaveLength(1);
    const req = h.received[0]!;
    expect(req.url).toBe("https://hooks.example/x");
    expect(req.headers["x-dispatch-event"]).toBe("chat-message");
    const body = JSON.parse(req.body) as { id: string; type: string; at: number; projectId?: string; chatId?: string; data: unknown };
    expect(body.type).toBe("chat-message");
    expect(body.chatId).toBe("c1");
    expect(body.projectId).toBe("p1"); // looked up through the chat
    expect(body.at).toBe(T0);
    expect(req.headers["x-dispatch-delivery"]).toBe(body.id);
    expect(req.headers["x-dispatch-timestamp"]).toBeUndefined();
    expect(
      verifyWebhookSignature(sub.secret, req.body, req.headers["x-dispatch-signature"]!, {
        nowSeconds: Math.floor(T0 / 1000),
      }),
    ).toBe(true);

    const log = await h.svc.deliveries(USER, sub.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: "delivered", attempts: 1, lastStatus: 200 });
    expect(h.svc.list(USER)[0]).toMatchObject({ lastDeliveryAt: T0, consecutiveFailures: 0 });
    expect("secret" in h.svc.list(USER)[0]!).toBe(false);
  });

  it("honours the filters and never offers the streams", async () => {
    const h = harness(store);
    await h.svc.start();
    await chat("c1", "p1");
    await chat("c2", "p2");
    await h.svc.create(USER, {
      name: "p1 user rows",
      url: "https://hooks.example/x",
      filters: { events: ["chat-message"], rowKinds: ["user"], projectIds: ["p1"] },
    });
    await h.publish(userRow("c2")); // wrong project
    await h.publish({ type: "chat-status", chatId: "c1", status: "running" }); // wrong event
    await h.publish({
      type: "chat-message",
      chatId: "c1",
      message: { id: "m2", chatId: "c1", turn: 1, kind: "assistant", text: "yo", ts: T0 },
    } as WsServerEvent); // wrong row kind
    await h.publish({ type: "message-chunk", chatId: "c1", messageId: "m", delta: "x", channel: "text" });
    expect(h.received).toHaveLength(0);
    await h.publish(userRow("c1"));
    expect(h.received).toHaveLength(1);
  });

  it("does not deliver to a paused subscription", async () => {
    const h = harness(store);
    await h.svc.start();
    await chat("c1");
    const sub = await h.svc.create(USER, { name: "off", url: "https://hooks.example/x", active: false });
    await h.publish(userRow("c1"));
    expect(h.received).toHaveLength(0);
    await h.svc.update(USER, sub.id, { active: true });
    await h.publish(userRow("c1"));
    expect(h.received).toHaveLength(1);
  });

  it("retries on the schedule, re-signing each attempt with a fresh t, same delivery id", async () => {
    const h = harness(store);
    await h.svc.start();
    await chat("c1");
    const sub = await h.svc.create(USER, { name: "flaky", url: "https://hooks.example/x" });
    h.setRespond(() => ({ ok: false, status: 503 }));
    await h.publish(userRow("c1"));
    expect(h.received).toHaveLength(1);

    const gaps: number[] = [];
    let last = h.now();
    for (let i = 0; i < WEBHOOK_RETRY_DELAYS_MS.length; i++) {
      // Nothing fires before the step is due.
      await h.advance(WEBHOOK_RETRY_DELAYS_MS[i]! - 1);
      expect(h.received).toHaveLength(i + 1);
      await h.advance(1);
      expect(h.received).toHaveLength(i + 2);
      gaps.push(h.now() - last);
      last = h.now();
    }
    expect(gaps).toEqual([...WEBHOOK_RETRY_DELAYS_MS]);
    expect(h.received).toHaveLength(WEBHOOK_MAX_ATTEMPTS);

    const ids = new Set(h.received.map((r) => r.headers["x-dispatch-delivery"]));
    expect(ids.size).toBe(1);
    const ts = h.received.map((r) => /t=(\d+)/.exec(r.headers["x-dispatch-signature"]!)![1]);
    expect(new Set(ts).size).toBe(WEBHOOK_MAX_ATTEMPTS);
    for (const r of h.received) {
      const t = Number(/t=(\d+)/.exec(r.headers["x-dispatch-signature"]!)![1]);
      expect(verifyWebhookSignature(sub.secret, r.body, r.headers["x-dispatch-signature"]!, { nowSeconds: t })).toBe(true);
    }

    const [d] = await h.svc.deliveries(USER, sub.id);
    expect(d).toMatchObject({ status: "dead", attempts: WEBHOOK_MAX_ATTEMPTS, lastStatus: 503, lastError: "HTTP 503" });
    expect(h.timers.size).toBe(0);
    expect(h.svc.list(USER)[0]!.consecutiveFailures).toBe(1);
  });

  it("a success mid-retry stops the schedule and resets the failure count", async () => {
    const h = harness(store);
    await h.svc.start();
    await chat("c1");
    const sub = await h.svc.create(USER, { name: "recovers", url: "https://hooks.example/x" });
    h.setRespond(() => new Error("ECONNREFUSED"));
    await h.publish(userRow("c1"));
    await h.advance(5_000);
    expect(h.received).toHaveLength(2);
    h.setRespond(() => ({ ok: true, status: 204 }));
    await h.advance(30_000);
    expect(h.received).toHaveLength(3);
    const [d] = await h.svc.deliveries(USER, sub.id);
    expect(d).toMatchObject({ status: "delivered", attempts: 3, lastStatus: 204 });
    expect(d!.lastError).toBeUndefined();
    await h.advance(60 * 60_000);
    expect(h.received).toHaveLength(3);
  });

  it("pauses the subscription after twenty consecutive dead deliveries and says so", async () => {
    const h = harness(store);
    await h.svc.start();
    await chat("c1");
    const sub = await h.svc.create(USER, { name: "dead endpoint", url: "https://hooks.example/x" });
    h.setRespond(() => new Error("ECONNREFUSED"));
    const total = WEBHOOK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    for (let i = 0; i < WEBHOOK_PAUSE_AFTER_DEAD - 1; i++) {
      await h.publish(userRow("c1"));
      await h.advance(total);
      expect(h.svc.list(USER)[0]).toMatchObject({ active: true, consecutiveFailures: i + 1 });
    }
    await h.publish(userRow("c1"));
    await h.advance(total);
    const after = h.svc.list(USER)[0]!;
    expect(after.active).toBe(false);
    expect(after.consecutiveFailures).toBe(WEBHOOK_PAUSE_AFTER_DEAD);
    expect(after.pausedReason).toMatch(/20 consecutive/);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatch(/"dead endpoint" paused/);
    // Paused means paused: the next event produces no row and no request.
    const before = h.received.length;
    await h.publish(userRow("c1"));
    expect(h.received).toHaveLength(before);
    // Re-enabling is the human saying "it's back": the count and reason clear.
    const again = await h.svc.update(USER, sub.id, { active: true });
    expect(again).toMatchObject({ active: true, consecutiveFailures: 0 });
    expect(again.pausedReason).toBeUndefined();
  });

  it("persists pending deliveries across a restart and resumes them on boot", async () => {
    const h1 = harness(store);
    await h1.svc.start();
    await chat("c1");
    const sub = await h1.svc.create(USER, { name: "survives", url: "https://hooks.example/x" });
    h1.setRespond(() => ({ ok: false, status: 500 }));
    await h1.publish(userRow("c1"));
    await h1.advance(5_000); // second attempt failed; third due in 30s
    expect(h1.received).toHaveLength(2);
    h1.svc.dispose();
    expect(h1.timers.size).toBe(0);

    // A new process over the same store, booting 10s later.
    const h2 = harness(store, { bus: new EventBus() });
    await h2.svc.start();
    expect(h2.svc.list(USER)).toHaveLength(1);
    expect(h2.timers.size).toBe(1);
    // h2's clock starts at T0; the row says the retry is due at T0+5s+30s.
    await h2.advance(34_999);
    expect(h2.received).toHaveLength(0);
    await h2.advance(1);
    expect(h2.received).toHaveLength(1);
    expect(h2.received[0]!.headers["x-dispatch-delivery"]).toBe(h1.received[0]!.headers["x-dispatch-delivery"]);
    const [d] = await h2.svc.deliveries(USER, sub.id);
    expect(d).toMatchObject({ status: "delivered", attempts: 3 });
  });

  it("resumes an OVERDUE pending delivery immediately on boot", async () => {
    const h1 = harness(store);
    await h1.svc.start();
    await chat("c1");
    await h1.svc.create(USER, { name: "overdue", url: "https://hooks.example/x" });
    h1.setRespond(() => ({ ok: false, status: 500 }));
    await h1.publish(userRow("c1"));
    h1.svc.dispose();
    // Booting a minute later: the retry that was due at +5s is overdue.
    const h2 = harness(store, { startAt: T0 + 60_000 });
    await h2.svc.start();
    expect(h2.timers.size).toBe(1);
    expect([...h2.timers.values()][0]!.ms).toBe(0);
    await h2.advance(0);
    expect(h2.received).toHaveLength(1);
  });

  it("test fires through the pipeline, even on a paused subscription, and returns the first attempt", async () => {
    const h = harness(store);
    await h.svc.start();
    const sub = await h.svc.create(USER, { name: "t", url: "https://hooks.example/x", active: false });
    h.setRespond(() => ({ ok: true, status: 202 }));
    const d = await h.svc.test(USER, sub.id);
    expect(d).toMatchObject({ status: "delivered", attempts: 1, lastStatus: 202, eventType: WEBHOOK_TEST_EVENT });
    expect(h.received[0]!.headers["x-dispatch-event"]).toBe(WEBHOOK_TEST_EVENT);
    expect(JSON.parse(h.received[0]!.body)).toMatchObject({ id: d.id, type: WEBHOOK_TEST_EVENT, data: { name: "t" } });
  });

  it("redelivers a dead delivery with the same id and body", async () => {
    const h = harness(store);
    await h.svc.start();
    await chat("c1");
    const sub = await h.svc.create(USER, { name: "r", url: "https://hooks.example/x" });
    h.setRespond(() => new Error("boom"));
    await h.publish(userRow("c1"));
    await h.advance(WEBHOOK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    const [dead] = await h.svc.deliveries(USER, sub.id);
    expect(dead!.status).toBe("dead");
    h.setRespond(() => ({ ok: true, status: 200 }));
    const again = await h.svc.redeliver(USER, sub.id, dead!.id);
    expect(again).toMatchObject({ id: dead!.id, status: "delivered", attempts: 1 });
    expect(h.received.at(-1)!.body).toBe(h.received[0]!.body);
    await expect(h.svc.redeliver(USER, sub.id, "nope")).rejects.toMatchObject({ status: 404 });
  });

  it("scopes a token to its own subscriptions and bounds its filters and URL", async () => {
    const h = harness(store);
    await h.svc.start();
    await chat("c1", "p1");
    await chat("c2", "p2");
    const tok: WebhookCaller = {
      kind: "integration",
      tokenId: "tok_1",
      scopes: ["webhooks:manage", "chats:read"],
      projectIds: ["p1"],
    };
    const owners = await h.svc.create(USER, { name: "owner's", url: "http://192.168.1.2/ntfy" });
    // A token may not use http, nor reach this machine or the LAN.
    await expect(h.svc.create(tok, { name: "t", url: "http://203.0.113.9/x" })).rejects.toMatchObject({ status: 400 });
    await expect(h.svc.create(tok, { name: "t", url: "https://127.0.0.1/x" })).rejects.toMatchObject({ status: 400 });
    await expect(h.svc.create(tok, { name: "t", url: "https://192.168.1.2/x" })).rejects.toMatchObject({ status: 400 });
    // Without webhooks:manage, nothing.
    await expect(
      h.svc.create({ ...tok, scopes: ["chats:read"] }, { name: "t", url: "https://203.0.113.9/x" }),
    ).rejects.toMatchObject({ status: 403 });

    const mine = await h.svc.create(tok, { name: "mine", url: "https://203.0.113.9/x" });
    expect(mine.createdBy).toBe("tok_1");
    // Unset filters became the token's bounds, not "all".
    expect(mine.filters.projectIds).toEqual(["p1"]);
    expect(mine.filters.events).toEqual(["chat-message", "chat-status", "chat-update", "chat-deleted", "chat-settled"]);

    // It sees only its own; the owner's is invisible, not forbidden.
    expect(h.svc.list(tok).map((s) => s.id)).toEqual([mine.id]);
    await expect(h.svc.update(tok, owners.id, { name: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(h.svc.test(tok, owners.id)).rejects.toMatchObject({ status: 404 });
    await expect(h.svc.remove(tok, owners.id)).rejects.toMatchObject({ status: 404 });
    expect(h.svc.list(USER)).toHaveLength(2);

    // The bound holds at delivery time: p2's event never reaches the token's URL.
    await h.publish(userRow("c2"));
    expect(h.received.filter((r) => r.url === "https://203.0.113.9/x")).toHaveLength(0);
    await h.publish(userRow("c1"));
    expect(h.received.filter((r) => r.url === "https://203.0.113.9/x")).toHaveLength(1);
  });
});

describe("chat-settled", () => {
  it("fires once per settled turn, after the window, with the last assistant text", async () => {
    const h = harness(store);
    await h.svc.start();
    await chat("c1");
    await store.appendMessage({ id: "a1", chatId: "c1", turn: 1, kind: "assistant", text: "All done.", ts: T0 } as never);
    await h.svc.create(USER, { name: "settled", url: "https://hooks.example/x", filters: { events: ["chat-settled"] } });

    // A fresh session's idle is not a settled turn.
    h.status("c1", "idle");
    await h.advance(NOTICE_SETTLE_MS);
    expect(h.received).toHaveLength(0);

    h.status("c1", "running");
    h.status("c1", "idle");
    expect(h.received).toHaveLength(0); // not on the raw edge
    await h.advance(NOTICE_SETTLE_MS);
    expect(h.received).toHaveLength(1);
    const body = JSON.parse(h.received[0]!.body) as { type: string; chatId: string; projectId: string; data: unknown };
    expect(body.type).toBe("chat-settled");
    expect(body.chatId).toBe("c1");
    expect(body.projectId).toBe("p1");
    expect(body.data).toEqual({ chatId: "c1", projectId: "p1", status: "idle", lastAssistantText: "All done." });

    // A second idle without work in between is the same rest, not a new turn.
    h.status("c1", "idle");
    await h.advance(NOTICE_SETTLE_MS);
    expect(h.received).toHaveLength(1);
    // The next turn fires again.
    h.status("c1", "running");
    h.status("c1", "done");
    await h.advance(NOTICE_SETTLE_MS);
    expect(h.received).toHaveLength(2);
  });

  it("cancels when the chat picks work back up inside the window", async () => {
    const h = harness(store);
    await h.svc.start();
    await chat("c1");
    await h.svc.create(USER, { name: "settled", url: "https://hooks.example/x", filters: { events: ["chat-settled"] } });
    h.status("c1", "running");
    h.status("c1", "idle");
    await h.advance(NOTICE_SETTLE_MS / 2);
    h.status("c1", "running"); // the queued message flushed
    await h.advance(NOTICE_SETTLE_MS);
    expect(h.received).toHaveLength(0);
    h.status("c1", "idle");
    await h.advance(NOTICE_SETTLE_MS);
    expect(h.received).toHaveLength(1);
  });

  it("waits out a live working status or pending work seen only at the re-check", async () => {
    const h = harness(store);
    await h.svc.start();
    await chat("c1");
    await h.svc.create(USER, { name: "settled", url: "https://hooks.example/x", filters: { events: ["chat-settled"] } });
    h.status("c1", "running");
    h.status("c1", "idle");
    h.pendingWork.add("c1"); // a send mid-flush, with no status event
    await h.advance(NOTICE_SETTLE_MS);
    expect(h.received).toHaveLength(0);
    h.pendingWork.delete("c1");
    await h.advance(NOTICE_SETTLE_MS);
    expect(h.received).toHaveLength(1);
  });

  it("is not derived at all while nothing is subscribed", async () => {
    const h = harness(store);
    await h.svc.start();
    h.status("c1", "running");
    h.status("c1", "idle");
    expect(h.timers.size).toBe(0);
  });
});
