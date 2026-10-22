/**
 * The webhook routes end to end: a real app, a real store, and an in-process
 * HTTP receiver that verifies the HMAC the way a third party would. Nothing is
 * faked between the bus and the socket.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { WebhookDelivery, WebhookSubscription } from "@dispatch/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { verifyWebhookSignature } from "../services/webhooks.js";

interface Hit {
  headers: Record<string, string | string[] | undefined>;
  body: string;
  url: string;
}

let dataDir: string;
let app: FastifyInstance;
let bus: EventBus;
let receiver: Server;
let receiverUrl: string;
let hits: Hit[];
/** What the receiver answers next; reset to 200 per test. */
let answer: number;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cm-webhook-routes-"));
  const store = new Store(dataDir);
  await store.init();
  bus = new EventBus();
  app = await buildApp({ config: { ...loadConfig(), dataDir }, store, bus });
  await app.ready();
  // Only the service under test; `services.start()` would also boot the broker,
  // the watchers and the pollers, none of which these routes need.
  await app.services.webhooks.start();

  hits = [];
  answer = 200;
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      if (req.url === "/redirect") {
        // A receiver trying to bounce the signed POST somewhere else — here
        // back to this same loopback server, exactly the kind of address the
        // token guard exists to refuse.
        res.statusCode = 307;
        res.setHeader("location", receiverUrl.replace(/\/hook$/, "/landed"));
        res.end();
        return;
      }
      hits.push({ headers: req.headers, body, url: req.url ?? "" });
      res.statusCode = answer;
      res.end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
});

afterEach(async () => {
  await new Promise<void>((r) => receiver.close(() => r()));
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function waitFor(pred: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function create(body: Record<string, unknown>): Promise<WebhookSubscription> {
  const res = await app.inject({ method: "POST", url: "/api/webhooks", payload: body });
  expect(res.statusCode).toBe(201);
  return res.json() as WebhookSubscription;
}

describe("/api/webhooks", () => {
  it("creates, lists without the secret, updates, and deletes", async () => {
    const created = await create({ name: "Grok", url: receiverUrl, filters: { events: ["chat-settled"] } });
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created).toMatchObject({ name: "Grok", active: true, createdBy: "user", consecutiveFailures: 0 });

    const list = await app.inject({ method: "GET", url: "/api/webhooks" });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(created.id);
    expect(rows[0]!).not.toHaveProperty("secret");

    const updated = await app.inject({
      method: "PUT",
      url: `/api/webhooks/${created.id}`,
      payload: { name: "Grok bot", active: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: "Grok bot", active: false });
    expect(updated.json()).not.toHaveProperty("secret");

    const rotated = await app.inject({
      method: "PUT",
      url: `/api/webhooks/${created.id}`,
      payload: { secret: "a-new-secret-value" },
    });
    expect(rotated.json()).toMatchObject({ secret: "a-new-secret-value" });

    const gone = await app.inject({ method: "DELETE", url: `/api/webhooks/${created.id}` });
    expect(gone.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/webhooks" })).json()).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `/api/webhooks/${created.id}` })).statusCode).toBe(404);
  });

  it("rejects a bad body with 400 naming the field", async () => {
    const res = await app.inject({ method: "POST", url: "/api/webhooks", payload: { name: "", url: "nope" } });
    expect(res.statusCode).toBe(400);
    expect(String((res.json() as { error: string }).error)).toMatch(/name|url/);
  });

  it("delivers a filtered chat-settled exactly once per settled turn, verifiably signed", async () => {
    // Two projects; the subscription wants only p1.
    const p1 = (await app.inject({ method: "POST", url: "/api/projects", payload: { name: "P1", repoPath: dataDir, worktreeRoot: "wt" } })).json() as { id: string };
    const p2 = (await app.inject({ method: "POST", url: "/api/projects", payload: { name: "P2", repoPath: dataDir, worktreeRoot: "wt2" } })).json() as { id: string };
    const store = app.services.store;
    const mk = (id: string, projectId: string) =>
      store.saveChat({
        id, projectId, title: id, harness: "claude", modeId: "default", status: "idle", effort: "medium",
        worktrees: [], prs: [], createdAt: Date.now(), updatedAt: Date.now(),
      } as never);
    await mk("c1", p1.id);
    await mk("c2", p2.id);
    await store.appendMessage({ id: "a1", chatId: "c1", turn: 1, kind: "assistant", text: "Shipped it.", ts: Date.now() } as never);

    const sub = await create({
      name: "settled",
      url: receiverUrl,
      filters: { events: ["chat-settled"], projectIds: [p1.id] },
    });

    // The settle window is real here (1.5s), so the test runs it once.
    for (const chatId of ["c1", "c2"]) {
      bus.publish({ type: "chat-status", chatId, status: "running" });
      bus.publish({ type: "chat-status", chatId, status: "idle" });
      // A second idle inside the window is the same edge, not a second turn.
      bus.publish({ type: "chat-status", chatId, status: "idle" });
    }
    await waitFor(() => hits.length >= 1);
    // Let anything else that was going to arrive, arrive.
    await new Promise((r) => setTimeout(r, 300));
    expect(hits).toHaveLength(1);

    const hit = hits[0]!;
    expect(hit.headers["x-dispatch-event"]).toBe("chat-settled");
    expect(hit.headers["content-type"]).toBe("application/json");
    const sig = String(hit.headers["x-dispatch-signature"]);
    expect(verifyWebhookSignature(sub.secret, hit.body, sig)).toBe(true);
    expect(verifyWebhookSignature("wrong", hit.body, sig)).toBe(false);
    const body = JSON.parse(hit.body) as { id: string; type: string; projectId: string; chatId: string; data: Record<string, unknown> };
    expect(body.type).toBe("chat-settled");
    expect(body.chatId).toBe("c1");
    expect(body.projectId).toBe(p1.id);
    expect(body.data).toEqual({ chatId: "c1", projectId: p1.id, status: "idle", lastAssistantText: "Shipped it." });
    expect(hit.headers["x-dispatch-delivery"]).toBe(body.id);

    const log = await app.inject({ method: "GET", url: `/api/webhooks/${sub.id}/deliveries` });
    const rows = log.json() as WebhookDelivery[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: body.id, status: "delivered", attempts: 1, lastStatus: 200, chatId: "c1" });
  });

  it("test fires a synthetic delivery and reports the receiver's answer", async () => {
    const sub = await create({ name: "t", url: receiverUrl, filters: { events: ["chat-settled"] } });
    answer = 503;
    const res = await app.inject({ method: "POST", url: `/api/webhooks/${sub.id}/test` });
    expect(res.statusCode).toBe(200);
    const d = res.json() as WebhookDelivery;
    expect(d).toMatchObject({ status: "pending", attempts: 1, lastStatus: 503, eventType: "webhook-test" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.headers["x-dispatch-event"]).toBe("webhook-test");

    // Redeliver refuses while the retry schedule still owns it...
    const busy = await app.inject({ method: "POST", url: `/api/webhooks/${sub.id}/deliveries/${d.id}/redeliver` });
    expect(busy.statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/webhooks/${sub.id}/deliveries/nope/redeliver` })).statusCode).toBe(404);
  });

  it("redelivers a settled delivery with the same id", async () => {
    const sub = await create({ name: "r", url: receiverUrl, filters: { events: ["chat-settled"] } });
    const first = (await app.inject({ method: "POST", url: `/api/webhooks/${sub.id}/test` })).json() as WebhookDelivery;
    expect(first.status).toBe("delivered");
    const again = await app.inject({ method: "POST", url: `/api/webhooks/${sub.id}/deliveries/${first.id}/redeliver` });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: first.id, status: "delivered", attempts: 1 });
    // Test fires bypass the filter; nothing else may have reached the receiver.
    expect(hits.map((h) => h.headers["x-dispatch-event"])).toEqual(["webhook-test", "webhook-test"]);
    expect(hits[1]!.body).toBe(hits[0]!.body);
    expect(hits[1]!.headers["x-dispatch-delivery"]).toBe(first.id);
  });

  it("never follows a redirect, so a receiver cannot bounce the POST elsewhere", async () => {
    const sub = await create({ name: "bouncer", url: receiverUrl.replace(/\/hook$/, "/redirect"), filters: { events: ["chat-settled"] } });
    const res = await app.inject({ method: "POST", url: `/api/webhooks/${sub.id}/test` });
    const d = res.json() as WebhookDelivery;
    expect(d).toMatchObject({ status: "pending", attempts: 1, lastStatus: 307 });
    expect(d.lastError).toMatch(/redirects are not followed/);
    await new Promise((r) => setTimeout(r, 200));
    expect(hits.filter((h) => h.url === "/landed")).toHaveLength(0);
  });

  it("404s an unknown subscription on every subresource", async () => {
    expect((await app.inject({ method: "POST", url: "/api/webhooks/zzz/test" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/webhooks/zzz/deliveries" })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/api/webhooks/zzz", payload: { name: "x" } })).statusCode).toBe(404);
  });
});
