import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttentionItem, NotificationPrefs } from "@dispatch/shared";
import { DEFAULT_NOTIFICATION_PREFS } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import {
  PushService,
  isValidVapidSubject,
  isAppleEndpoint,
  topicForChat,
  type WebPushLike,
  type PushSubscriptionJson,
} from "./push.js";

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
  const sent: Array<{ endpoint: string; payload: string; topic?: string }> = [];
  const mock: WebPushLike = {
    generateVAPIDKeys: () => ({ publicKey: "PUB", privateKey: "PRIV" }),
    sendNotification: vi.fn(async (subscription, payload, options) => {
      const status = fail?.(subscription.endpoint);
      if (status) throw Object.assign(new Error(`push failed ${status}`), { statusCode: status });
      sent.push({ endpoint: subscription.endpoint, payload, topic: options.topic });
      return {};
    }),
  };
  return { mock, sent };
}

/** An endpoint on Apple's push service — the one the withdraw path must skip. */
function appleSub(n = 1): PushSubscriptionJson {
  return {
    endpoint: `https://web.push.apple.com/${n}`,
    keys: { p256dh: `p${n}`, auth: `a${n}` },
  };
}

/** Decoded payloads, in send order. */
function payloads(sent: Array<{ payload: string }>): Array<Record<string, unknown>> {
  return sent.map((s) => JSON.parse(s.payload) as Record<string, unknown>);
}

describe("isValidVapidSubject", () => {
  // Apple validates the `sub` claim and answers 403 BadJwtToken when it points
  // nowhere; FCM ignores it entirely. Everything here is about that asymmetry.
  it.each([
    ["https://dispatch.example.com", true],
    ["https://github.com/mdennis281/dispatch", true],
    ["mailto:someone@example.com", true],
    ["mailto:dispatch@localhost", false],
    ["https://localhost:4318", false],
    ["https://127.0.0.1", false],
    ["https://dispatch.local", false],
    ["mailto:me@nas.lan", false],
    ["http://dispatch.example.com", false],
    ["dispatch@example.com", false],
    ["", false],
  ])("%s → %s", (subject, expected) => {
    expect(isValidVapidSubject(subject)).toBe(expected);
  });
});

describe("topicForChat", () => {
  it("passes a nanoid chat id through untouched", () => {
    // Chat ids are 21 chars of exactly the alphabet RFC 8030 allows, so the
    // common case needs no encoding at all.
    expect(topicForChat("-5JN2xTRaRJ473uzloWVG")).toBe("-5JN2xTRaRJ473uzloWVG");
  });

  it("digests anything the Topic header would reject", () => {
    // `web-push` throws on a bad topic, which would turn a cosmetic id into a
    // total push outage for that chat.
    for (const id of ["a chat with spaces", "sl/ash", "é", "x".repeat(40), ""]) {
      const topic = topicForChat(id);
      expect(topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    }
  });

  it("is stable and collision-free across ids", () => {
    expect(topicForChat("a/b")).toBe(topicForChat("a/b"));
    expect(topicForChat("a/b")).not.toBe(topicForChat("a/c"));
  });
});

describe("isAppleEndpoint", () => {
  it.each([
    ["https://web.push.apple.com/abc", true],
    ["https://fcm.googleapis.com/fcm/send/abc", false],
    ["https://updates.push.services.mozilla.com/wpush/v2/abc", false],
    // Not a suffix match: a lookalike host must not be mistaken for Apple's.
    ["https://web.push.apple.com.evil.test/abc", false],
    ["not a url", false],
  ])("%s → %s", (endpoint, expected) => {
    expect(isAppleEndpoint(endpoint)).toBe(expected);
  });
});

describe("PushService", () => {
  let dir: string;
  let bus: EventBus;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dispatch-push-"));
    bus = new EventBus();
    // A real DISPATCH_VAPID_SUBJECT in the environment would override what these
    // tests set up, so neutralise it rather than depend on the machine.
    vi.stubEnv("DISPATCH_VAPID_SUBJECT", "");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
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

  it("writes a VAPID subject a push service will actually accept", async () => {
    // `mailto:dispatch@localhost` is what this used to default to, and Apple
    // answers every push signed with it `403 {"reason":"BadJwtToken"}` — while
    // FCM ignores the field, so desktop worked and no iPhone ever made a sound.
    const { mock } = webPushMock();
    const svc = new PushService({ bus, configDir: dir, dataDir: dir, webPush: mock });
    const keys = await svc.vapidKeys();
    expect(isValidVapidSubject(keys.subject)).toBe(true);
  });

  it("heals an existing @localhost subject without regenerating the keypair", async () => {
    // Regenerating the keys would invalidate every registered device, so the
    // repair has to be to the subject alone — an install that predates the fix
    // starts working on restart with no phone re-registering anything.
    await writeFile(
      join(dir, "vapid.json"),
      JSON.stringify({ publicKey: "PUB", privateKey: "PRIV", subject: "mailto:dispatch@localhost" }),
    );
    const { mock } = webPushMock();
    const svc = new PushService({ bus, configDir: dir, dataDir: dir, webPush: mock });
    const keys = await svc.vapidKeys();
    expect(keys.publicKey).toBe("PUB");
    expect(keys.privateKey).toBe("PRIV");
    expect(isValidVapidSubject(keys.subject)).toBe(true);
    // Persisted, not just patched in memory.
    expect(JSON.parse(await readFile(join(dir, "vapid.json"), "utf8")).subject).toBe(keys.subject);
  });

  it("keeps a valid subject already on disk, and honours a valid override", async () => {
    await writeFile(
      join(dir, "vapid.json"),
      JSON.stringify({ publicKey: "PUB", privateKey: "PRIV", subject: "mailto:me@example.com" }),
    );
    const { mock } = webPushMock();
    const kept = new PushService({ bus, configDir: dir, dataDir: dir, webPush: mock });
    expect((await kept.vapidKeys()).subject).toBe("mailto:me@example.com");

    const overridden = new PushService({
      bus,
      configDir: dir,
      dataDir: dir,
      webPush: mock,
      subject: "https://dispatch.example.com",
    });
    expect((await overridden.vapidKeys()).subject).toBe("https://dispatch.example.com");
  });

  it("trims a stored subject rather than signing with its whitespace", async () => {
    // `isValidVapidSubject` validates the TRIMMED string, so a padded subject
    // passes the check; signing with the padding is a different question and
    // the push service is entitled to reject it.
    await writeFile(
      join(dir, "vapid.json"),
      JSON.stringify({ publicKey: "PUB", privateKey: "PRIV", subject: "  mailto:me@example.com\n" }),
    );
    const { mock } = webPushMock();
    const svc = new PushService({ bus, configDir: dir, dataDir: dir, webPush: mock });
    expect((await svc.vapidKeys()).subject).toBe("mailto:me@example.com");
    // Normalised on disk too, or it comes back on the next boot.
    expect(JSON.parse(await readFile(join(dir, "vapid.json"), "utf8")).subject).toBe(
      "mailto:me@example.com",
    );
  });

  it("refuses an invalid override rather than signing with it", async () => {
    const errors: unknown[] = [];
    const { mock } = webPushMock();
    const svc = new PushService({
      bus,
      configDir: dir,
      dataDir: dir,
      webPush: mock,
      subject: "mailto:dispatch@localhost",
      onError: (e) => errors.push(e),
    });
    expect(isValidVapidSubject((await svc.vapidKeys()).subject)).toBe(true);
    expect(errors).toHaveLength(1);
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
    expect(await svc.sendTest("https://push.example/9")).toBeNull();
    expect(await svc.sendTest(sub(1).endpoint)).toEqual({ ok: true });
    // The test push carries no chat — the SW must not try to focus chat "".
    expect(JSON.parse(sent[0]!.payload).chatId).toBe("");
  });

  it("sendTest reports the push service's refusal instead of claiming success", async () => {
    // The bug this covers: a 403 from Apple came back as `true`, so a device
    // that could never receive anything was indistinguishable from one that had
    // just been reached — the only visible symptom of a total iOS outage.
    const { mock } = webPushMock(() => 403);
    const svc = new PushService({ bus, configDir: dir, dataDir: dir, webPush: mock });
    await svc.subscribe(sub(1));
    const result = await svc.sendTest(sub(1).endpoint);
    expect(result?.ok).toBe(false);
    expect(result?.statusCode).toBe(403);
    expect(result?.error).toMatch(/VAPID subject/);
    // A 403 is about our credentials, not about this device — it keeps its slot.
    expect(await svc.list()).toHaveLength(1);
  });

  it("unsubscribe removes exactly one device", async () => {
    const { svc } = make();
    await svc.subscribe(sub(1));
    await svc.subscribe(sub(2));
    expect(await svc.unsubscribe(sub(1).endpoint)).toBe(true);
    expect(await svc.unsubscribe(sub(1).endpoint)).toBe(false);
    expect(await svc.list()).toHaveLength(1);
  });

  /* ------------------------------------ consolidation + withdrawal */

  it("stamps every chat push with that chat's Topic", async () => {
    // RFC 8030 §5.4: the push service drops an undelivered message when a newer
    // one shares its topic, so a phone that was off wakes to one item per chat
    // rather than the whole backlog.
    const { svc, sent } = make();
    await svc.subscribe(sub(1));
    await svc.fanOut(attn("permission", { chatId: "c1" }));
    await svc.fanOut(attn("question", { id: "a2", chatId: "c2" }));
    expect(sent.map((s) => s.topic)).toEqual(["c1", "c2"]);
  });

  it("counts a chat's outstanding items so the worker can collapse them", async () => {
    const { svc, sent } = make();
    await svc.subscribe(sub(1));
    svc.start();
    bus.publish({ type: "attention-add", item: attn("permission", { id: "a1" }) });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    bus.publish({ type: "attention-add", item: attn("question", { id: "a2" }) });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    // Second push for the same chat says "2 waiting" — the worker replaces the
    // first notification rather than stacking a second row.
    expect(payloads(sent).map((p) => p.outstanding)).toEqual([1, 2]);
    expect(payloads(sent).map((p) => p.badge)).toEqual([1, 2]);
    svc.stop();
  });

  it("withdraws a chat's notification once its last item resolves", async () => {
    const { svc, sent } = make();
    await svc.subscribe(sub(1));
    svc.start();
    bus.publish({ type: "attention-add", item: attn("permission", { id: "a1" }) });
    bus.publish({ type: "attention-add", item: attn("question", { id: "a2" }) });
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    // One of two resolved: something is still waiting, so nothing is withdrawn.
    bus.publish({ type: "attention-resolve", id: "a1", chatId: "c1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(2);

    // The last one: the reason is gone, so take the notification back.
    bus.publish({ type: "attention-resolve", id: "a2", chatId: "c1" });
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(payloads(sent)[2]).toMatchObject({ chatId: "c1", outstanding: 0, badge: 0 });
    expect(sent[2]!.topic).toBe("c1");
    svc.stop();
  });

  it("never sends a withdrawal to an iPhone", async () => {
    // A push that displays nothing is what makes WebKit revoke the subscription,
    // and the symptom is notifications silently stopping days later.
    const { svc, sent } = make();
    await svc.subscribe(appleSub(1));
    await svc.subscribe(sub(2));
    svc.start();
    bus.publish({ type: "attention-add", item: attn("permission", { id: "a1" }) });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    bus.publish({ type: "attention-resolve", id: "a1", chatId: "c1" });
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]!.endpoint).toBe(sub(2).endpoint);
    // And no second attempt on a later resolve for the same chat.
    bus.publish({ type: "attention-add", item: attn("done", { id: "a2" }) });
    await vi.waitFor(() => expect(sent).toHaveLength(5));
    svc.stop();
  });

  it("does not wake a device that never got a notification for that chat", async () => {
    // Waking every registered device to close something most of them never had
    // spends Chrome's push budget for nothing.
    const { svc, sent } = make();
    await svc.subscribe(sub(1));
    svc.start();
    bus.publish({ type: "attention-add", item: attn("permission", { id: "a1", chatId: "c1" }) });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // A chat this device was never pushed about.
    bus.publish({ type: "attention-resolve", id: "zz", chatId: "c9" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
    svc.stop();
  });

  it("withdraws once for a burst of resolves, not once per item", async () => {
    // Deleting a chat resolves every one of its items at once; only the last
    // empties the chat, so exactly one withdrawal goes out.
    const { svc, sent } = make();
    await svc.subscribe(sub(1));
    svc.start();
    for (const id of ["a1", "a2", "a3"]) {
      bus.publish({ type: "attention-add", item: attn("permission", { id }) });
    }
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    for (const id of ["a1", "a2", "a3"]) {
      bus.publish({ type: "attention-resolve", id, chatId: "c1" });
    }
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(4);
    expect(payloads(sent)[3]).toMatchObject({ outstanding: 0 });
    svc.stop();
  });

  it("finds the owning chat when the resolve event omits chatId", async () => {
    const { svc, sent } = make();
    await svc.subscribe(sub(1));
    svc.start();
    bus.publish({ type: "attention-add", item: attn("permission", { id: "a1", chatId: "c7" }) });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    bus.publish({ type: "attention-resolve", id: "a1" });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(payloads(sent)[1]).toMatchObject({ chatId: "c7", outstanding: 0 });
    svc.stop();
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
