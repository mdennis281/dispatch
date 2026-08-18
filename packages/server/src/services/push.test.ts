import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttentionItem, NotificationPrefs } from "@dispatch/shared";
import { DEFAULT_NOTIFICATION_PREFS } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { PushService, type WebPushLike, type PushSubscriptionJson } from "./push.js";

function sub(n = 1): PushSubscriptionJson {
  return {
    endpoint: `https://push.example/${n}`,
    keys: { p256dh: `p${n}`, auth: `a${n}` },
  };
}

function attn(kind: AttentionItem["kind"], over: Partial<AttentionItem> = {}): AttentionItem {
  return { id: "a1", chatId: "c1", kind, summary: "needs you", createdAt: 1, ...over };
}

/** A `web-push` stand-in that records sends and can be told to fail. */
function webPushMock(fail?: (endpoint: string) => number | undefined) {
  const sent: Array<{ endpoint: string; payload: string }> = [];
  const mock: WebPushLike = {
    generateVAPIDKeys: () => ({ publicKey: "PUB", privateKey: "PRIV" }),
    sendNotification: vi.fn(async (subscription, payload) => {
      const status = fail?.(subscription.endpoint);
      if (status) throw Object.assign(new Error(`push failed ${status}`), { statusCode: status });
      sent.push({ endpoint: subscription.endpoint, payload });
      return {};
    }),
  };
  return { mock, sent };
}

describe("PushService", () => {
  let dir: string;
  let bus: EventBus;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dispatch-push-"));
    bus = new EventBus();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function make() {
    const { mock, sent } = webPushMock();
    const svc = new PushService({
      bus,
      configDir: dir,
      dataDir: dir,
      webPush: mock,
      now: () => 1_000_000,
    });
    return { svc, sent, mock };
  }

  it("generates a VAPID keypair once and reuses it across instances", async () => {
    const { mock } = webPushMock();
    const a = new PushService({ bus, configDir: dir, dataDir: dir, webPush: mock });
    expect(await a.publicKey()).toBe("PUB");
    // A key that changed between restarts would leave every registered device
    // holding a subscription this server can no longer sign for.
    const b = new PushService({ bus, configDir: dir, dataDir: dir, webPush: mock });
    expect(await b.publicKey()).toBe("PUB");
    const raw = JSON.parse(await readFile(join(dir, "vapid.json"), "utf8"));
    expect(raw.privateKey).toBe("PRIV");
    expect(raw.subject).toBeTruthy();
  });

  it("dedups a re-registration by endpoint rather than stacking copies", async () => {
    const { svc } = make();
    await svc.subscribe(sub(1), undefined, "iPhone");
    await svc.subscribe(sub(1), undefined, "iPhone");
    expect(await svc.list()).toHaveLength(1);
  });

  it("survives a restart — the registry is on disk", async () => {
    const { mock } = webPushMock();
    const a = new PushService({ bus, configDir: dir, dataDir: dir, webPush: mock });
    await a.subscribe(sub(1));
    const b = new PushService({ bus, configDir: dir, dataDir: dir, webPush: mock });
    expect(await b.list()).toHaveLength(1);
  });

  it("pushes an attention item to every registered device", async () => {
    const { svc, sent } = make();
    await svc.subscribe(sub(1));
    await svc.subscribe(sub(2));
    await svc.fanOut(attn("permission"));
    expect(sent.map((s) => s.endpoint).sort()).toEqual([
      "https://push.example/1",
      "https://push.example/2",
    ]);
    expect(JSON.parse(sent[0]!.payload)).toMatchObject({
      kind: "permission",
      title: "Permission needed",
      body: "needs you",
      chatId: "c1",
      sticky: true,
    });
  });

  it("applies each device's OWN filters — the whole point of filtering server-side", async () => {
    const { svc, sent } = make();
    const muted: NotificationPrefs = { ...DEFAULT_NOTIFICATION_PREFS, kinds: { done: false } };
    await svc.subscribe(sub(1), muted);
    await svc.subscribe(sub(2));
    await svc.fanOut(attn("done"));
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push.example/2"]);
  });

  it("filters review activity by sub-kind", async () => {
    const { svc, sent } = make();
    await svc.subscribe(sub(1), {
      ...DEFAULT_NOTIFICATION_PREFS,
      reviewKinds: { comment: false },
    });
    await svc.fanOut(attn("review", { reviewKinds: ["comment"] }));
    expect(sent).toHaveLength(0);
    await svc.fanOut(attn("review", { reviewKinds: ["comment", "check"] }));
    expect(sent).toHaveLength(1);
  });

  it("setPrefs retunes a registered device and reports an unknown one", async () => {
    const { svc, sent } = make();
    await svc.subscribe(sub(1));
    expect(await svc.setPrefs("https://push.example/9", DEFAULT_NOTIFICATION_PREFS)).toBe(false);
    expect(
      await svc.setPrefs(sub(1).endpoint, {
        ...DEFAULT_NOTIFICATION_PREFS,
        kinds: { permission: false },
      }),
    ).toBe(true);
    await svc.fanOut(attn("permission"));
    expect(sent).toHaveLength(0);
  });

  it("skips a device that just reported the app in front of the human", async () => {
    let now = 1_000_000;
    const { mock, sent } = webPushMock();
    const svc = new PushService({ bus, configDir: dir, dataDir: dir, webPush: mock, now: () => now });
    await svc.subscribe(sub(1));
    await svc.setPresence(sub(1).endpoint, true);
    await svc.fanOut(attn("permission"));
    expect(sent).toHaveLength(0);

    // …but the suppression expires, so a device that went away silently (a
    // locked phone, a closed laptop) starts hearing from us again.
    now += 120_000;
    await svc.fanOut(attn("permission"));
    expect(sent).toHaveLength(1);
  });

  it("does not rewrite the registry for a presence report", async () => {
    // Presence is reported on every visibility change AND a 60s heartbeat; the
    // registry is a whole-file rewrite. Persisting it would mean a disk write a
    // minute per open tab to record something stale within 90 seconds.
    const { svc } = make();
    await svc.subscribe(sub(1));
    const before = await readFile(join(dir, "push-subscriptions.json"), "utf8");
    await svc.setPresence(sub(1).endpoint, true);
    expect(await readFile(join(dir, "push-subscriptions.json"), "utf8")).toBe(before);
  });

  it("reports whether the endpoint reporting presence is one we know", async () => {
    const { svc } = make();
    await svc.subscribe(sub(1));
    expect(await svc.setPresence(sub(1).endpoint, true)).toBe(true);
    expect(await svc.setPresence("https://push.example/9", true)).toBe(false);
  });

  it("stops skipping as soon as the device says it went away", async () => {
    const { svc, sent } = make();
    await svc.subscribe(sub(1));
    await svc.setPresence(sub(1).endpoint, true);
    await svc.setPresence(sub(1).endpoint, false);
    await svc.fanOut(attn("permission"));
    expect(sent).toHaveLength(1);
  });

  it("prunes a subscription the push service says is gone (410)", async () => {
    const { mock } = webPushMock((e) => (e.endsWith("/1") ? 410 : undefined));
    const svc = new PushService({ bus, configDir: dir, dataDir: dir, webPush: mock });
    await svc.subscribe(sub(1));
    await svc.subscribe(sub(2));
    await svc.fanOut(attn("permission"));
    const left = await svc.list();
    expect(left.map((s) => s.subscription.endpoint)).toEqual(["https://push.example/2"]);
  });

  it("KEEPS a subscription through a transient failure", async () => {
    // A 500 from the push service must not cost a device its registration —
    // that would quietly un-enroll a phone over one bad afternoon.
    const errors: unknown[] = [];
    const { mock } = webPushMock(() => 500);
    const svc = new PushService({
      bus,
      configDir: dir,
      dataDir: dir,
      webPush: mock,
      onError: (e) => errors.push(e),
    });
    await svc.subscribe(sub(1));
    await svc.fanOut(attn("permission"));
    expect(await svc.list()).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("does nothing at all when no device is registered", async () => {
    const { svc, mock } = make();
    await svc.fanOut(attn("permission"));
    expect(mock.sendNotification).not.toHaveBeenCalled();
  });

  it("start() fans out bus attention events", async () => {
    const { svc, sent } = make();
    await svc.subscribe(sub(1));
    svc.start();
    bus.publish({ type: "attention-add", item: attn("question") });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    svc.stop();
    bus.publish({ type: "attention-add", item: attn("question", { id: "a2" }) });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
  });

  it("sendTest reaches one device and reports an unknown endpoint", async () => {
    const { svc, sent } = make();
    await svc.subscribe(sub(1));
    expect(await svc.sendTest("https://push.example/9")).toBe(false);
    expect(await svc.sendTest(sub(1).endpoint)).toBe(true);
    // The test push carries no chat — the SW must not try to focus chat "".
    expect(JSON.parse(sent[0]!.payload).chatId).toBe("");
  });

  it("unsubscribe removes exactly one device", async () => {
    const { svc } = make();
    await svc.subscribe(sub(1));
    await svc.subscribe(sub(2));
    expect(await svc.unsubscribe(sub(1).endpoint)).toBe(true);
    expect(await svc.unsubscribe(sub(1).endpoint)).toBe(false);
    expect(await svc.list()).toHaveLength(1);
  });

  it("serializes concurrent registrations rather than losing writes", async () => {
    // The registry is a whole-file read-modify-write; unserialized, the last
    // writer would clobber the others and devices would silently vanish.
    const { svc } = make();
    await Promise.all([1, 2, 3, 4, 5].map((n) => svc.subscribe(sub(n))));
    expect(await svc.list()).toHaveLength(5);
    const onDisk = JSON.parse(await readFile(join(dir, "push-subscriptions.json"), "utf8"));
    expect(onDisk.subscriptions).toHaveLength(5);
  });
});
