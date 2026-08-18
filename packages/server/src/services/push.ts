/**
 * PushService — real Web Push, which is the ONLY way an iPhone ever hears from
 * Dispatch.
 *
 * ── The bug this exists to fix ─────────────────────────────────────────────
 * Before this, every OS notification Dispatch raised was fired by JavaScript
 * running in the open page (`lib/browserNotify.ts`), off a WebSocket event. On a
 * desktop that works, because the window stays alive in the background. On iOS
 * it cannot: the moment the PWA is backgrounded, WebKit suspends the whole web
 * app — the socket drops, the timers stop, and no code of ours runs again until
 * you tap the icon. So notifications appeared to be "set up" (the permission was
 * granted, the toggle said On) and then never arrived, which is exactly the
 * symptom that has no error message anywhere.
 *
 * A push from the server, delivered through APNs to a subscription the phone
 * registered, is the only thing that can wake a suspended web app. That is what
 * this service sends.
 *
 * ── Rules WebKit enforces, which shape the code below ──────────────────────
 *   - **Every push must show a notification.** A push handler that decides not
 *     to display anything is a "silent push"; a few of those and iOS REVOKES the
 *     subscription. This is why filtering happens HERE and not in the service
 *     worker: the device ships its preferences up with its subscription, and a
 *     muted event is simply never sent. See `shouldNotify` in shared/notify.ts.
 *   - **Subscriptions expire.** A 404 or 410 from the push service is permanent
 *     — the endpoint is gone, and retrying it forever is how a registry rots.
 *     Those are pruned on the spot; every other failure is left alone.
 *
 * ── What is stored where ───────────────────────────────────────────────────
 * The VAPID keypair is the app's identity to the push service and must survive
 * restarts (regenerating it invalidates every existing subscription), so it
 * lives in the shared CONFIG root. The subscription registry lives in the
 * per-instance DATA root instead: it is a whole-file read-modify-write map
 * guarded by an in-process lock, and two instances sharing one would drop each
 * other's writes — the same reason `runners.json` is per-instance. The practical
 * upshot is a subscription made against the stable app is not also pushed to by
 * a dev server, which is what you want anyway.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  DEFAULT_NOTIFICATION_PREFS,
  NotificationPrefsSchema,
  shouldNotify,
  type AttentionItem,
  type NotificationPrefs,
} from "@dispatch/shared";
import { z } from "zod";
import type { EventBus } from "../bus.js";
import { readJson, writeJsonAtomic } from "../store/fsq.js";

/** The browser's `PushSubscription.toJSON()` shape. */
export const PushSubscriptionSchema = z.object({
  endpoint: z.string().min(1),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
export type PushSubscriptionJson = z.infer<typeof PushSubscriptionSchema>;

const StoredSubscriptionSchema = z.object({
  subscription: PushSubscriptionSchema,
  prefs: NotificationPrefsSchema,
  /** Free-text device label so Settings can list "iPhone" rather than a base64 blob. */
  label: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type StoredSubscription = z.infer<typeof StoredSubscriptionSchema>;

const RegistrySchema = z.object({
  subscriptions: z.array(StoredSubscriptionSchema).default([]),
});

const VapidSchema = z.object({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
  /**
   * The `sub` claim in the VAPID JWT. Push services want a contact for whoever
   * is sending; nobody reads it for a self-hosted app, but Apple rejects a JWT
   * without one.
   */
  subject: z.string().min(1),
});
export type VapidKeys = z.infer<typeof VapidSchema>;

/**
 * How long a "the app is in front of me" report stays trusted.
 *
 * Held in memory and never persisted: it is reported on every visibility change
 * AND on a 60s heartbeat, and the registry is a whole-file rewrite — persisting
 * it would mean rewriting `push-subscriptions.json` once a minute per open tab
 * to record something that is stale within 90 seconds. A restart simply forgets
 * who was looking, and the next heartbeat says so again.
 *
 * Generous on purpose. The client re-reports on every visibility change and on a
 * 60s heartbeat while visible, so the only way to hit this ceiling is a device
 * that went away without saying so — a closed laptop, a phone that locked. Erring
 * long would mute a device that stopped talking; erring short would let a push
 * through to a window you are actively typing in. 90s splits it: one missed
 * heartbeat is forgiven, two is not.
 */
const PRESENCE_TTL_MS = 90_000;

/** The `web-push` surface we use. Injected in tests so nothing hits the network. */
export interface WebPushLike {
  sendNotification(
    subscription: PushSubscriptionJson,
    payload: string,
    options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL?: number },
  ): Promise<unknown>;
  generateVAPIDKeys(): { publicKey: string; privateKey: string };
}

export interface PushServiceDeps {
  bus: EventBus;
  /** CONFIG root — the VAPID keypair lives here (shared, must not be regenerated). */
  configDir: string;
  /** DATA root — the subscription registry lives here (per-instance, write-heavy). */
  dataDir: string;
  /** Overridable for tests. Defaults to the real `web-push` module, loaded lazily. */
  webPush?: WebPushLike;
  now?: () => number;
  onError?: (err: unknown) => void;
}

/** What the service worker receives. Kept flat and small — payloads are size-capped. */
export interface PushPayload {
  id: string;
  chatId: string;
  kind: AttentionItem["kind"];
  title: string;
  body: string;
  /** Keep the toast up until dismissed (ignored by iOS, honoured on desktop). */
  sticky: boolean;
  permissionRequestId?: string;
  url?: string;
}

/** Per-kind copy. Mirrors the notifier's and the client's so all three agree. */
const KIND_TITLE: Record<AttentionItem["kind"], string> = {
  permission: "Permission needed",
  question: "Question",
  idle: "Waiting for input",
  done: "Task done",
  review: "PR review activity",
};

const STICKY: ReadonlySet<AttentionItem["kind"]> = new Set(["permission", "question", "review"]);

export class PushService {
  private readonly bus: EventBus;
  private readonly vapidFile: string;
  private readonly registryFile: string;
  private readonly now: () => number;
  private readonly onError?: (err: unknown) => void;
  private injectedWebPush?: WebPushLike;

  private vapid: VapidKeys | null = null;
  private subs: StoredSubscription[] = [];
  /** endpoint → when it last reported the app in front. In memory only. */
  private readonly inFront = new Map<string, number>();
  private loaded = false;
  /** Serializes the read-modify-write of the registry file. */
  private writeChain: Promise<unknown> = Promise.resolve();
  private off: (() => void) | null = null;

  constructor(deps: PushServiceDeps) {
    this.bus = deps.bus;
    this.vapidFile = join(deps.configDir, "vapid.json");
    this.registryFile = join(deps.dataDir, "push-subscriptions.json");
    this.injectedWebPush = deps.webPush;
    this.now = deps.now ?? (() => Date.now());
    this.onError = deps.onError;
  }

  /** Subscribe to the bus. Idempotent. */
  start(): void {
    if (this.off) return;
    this.off = this.bus.on("attention-add", (e) => {
      void this.fanOut(e.item).catch((err) => this.onError?.(err));
    });
  }

  stop(): void {
    this.off?.();
    this.off = null;
  }

  /* ------------------------------------------------------------- web-push */

  private async webPush(): Promise<WebPushLike> {
    if (this.injectedWebPush) return this.injectedWebPush;
    // Lazily imported: `web-push` pulls in a chunk of crypto plumbing that a
    // Dispatch install with no subscriptions has no reason to pay for at boot.
    const mod = (await import("web-push")) as unknown as { default?: WebPushLike } & WebPushLike;
    this.injectedWebPush = mod.default ?? mod;
    return this.injectedWebPush;
  }

  /**
   * The keypair, generated on first use.
   *
   * Generation is deliberately lazy AND persisted: the public key is what the
   * browser subscribes against, so a key that changed between restarts would
   * leave every phone holding a subscription the server can no longer sign for,
   * with no error until a notification silently fails to arrive.
   */
  async vapidKeys(): Promise<VapidKeys> {
    if (this.vapid) return this.vapid;
    const raw = await readJson(this.vapidFile);
    const parsed = VapidSchema.safeParse(raw);
    if (parsed.success) {
      this.vapid = parsed.data;
      return this.vapid;
    }
    const wp = await this.webPush();
    const keys = wp.generateVAPIDKeys();
    this.vapid = { ...keys, subject: `mailto:dispatch@localhost` };
    // 0600: this file is the private half of the app's push identity. Windows
    // ignores the mode, POSIX does not, and it costs nothing to be right there.
    await writeJsonAtomic(this.vapidFile, this.vapid, { mode: 0o600 });
    return this.vapid;
  }

  /** The public key a client needs to call `pushManager.subscribe`. */
  async publicKey(): Promise<string> {
    return (await this.vapidKeys()).publicKey;
  }

  /* ------------------------------------------------------------- registry */

  private async load(): Promise<void> {
    if (this.loaded) return;
    const parsed = RegistrySchema.safeParse(await readJson(this.registryFile));
    this.subs = parsed.success ? parsed.data.subscriptions : [];
    this.loaded = true;
  }

  /** Run `fn` against the in-memory registry and persist the result, serialized. */
  private mutate<T>(fn: () => T): Promise<T> {
    const run = this.writeChain.then(async () => {
      await this.load();
      const result = fn();
      await writeJsonAtomic(this.registryFile, { subscriptions: this.subs });
      return result;
    });
    // Keep the chain alive even when this link rejects, or one failed write
    // would wedge every later one.
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  /** Register (or re-register) a device. Dedups by endpoint — the browser's own id. */
  async subscribe(
    subscription: PushSubscriptionJson,
    prefs?: NotificationPrefs,
    label?: string,
  ): Promise<StoredSubscription> {
    return this.mutate(() => {
      const now = this.now();
      const existing = this.subs.find((s) => s.subscription.endpoint === subscription.endpoint);
      if (existing) {
        existing.subscription = subscription;
        if (prefs) existing.prefs = prefs;
        if (label) existing.label = label;
        existing.updatedAt = now;
        return existing;
      }
      const entry: StoredSubscription = {
        subscription,
        prefs: prefs ?? DEFAULT_NOTIFICATION_PREFS,
        label,
        createdAt: now,
        updatedAt: now,
      };
      this.subs.push(entry);
      return entry;
    });
  }

  /** Update just the filters for one device. Returns false if it isn't registered. */
  async setPrefs(endpoint: string, prefs: NotificationPrefs): Promise<boolean> {
    return this.mutate(() => {
      const entry = this.subs.find((s) => s.subscription.endpoint === endpoint);
      if (!entry) return false;
      entry.prefs = prefs;
      entry.updatedAt = this.now();
      return true;
    });
  }

  /**
   * Note that this device currently has the app in front of the human.
   *
   * Deliberately does NOT touch the registry file — see PRESENCE_TTL_MS. Returns
   * whether the endpoint is one we know, so a client whose registration the
   * server lost still learns to re-subscribe.
   */
  async setPresence(endpoint: string, inFront: boolean): Promise<boolean> {
    if (inFront) this.inFront.set(endpoint, this.now());
    else this.inFront.delete(endpoint);
    await this.load();
    return this.subs.some((s) => s.subscription.endpoint === endpoint);
  }

  async unsubscribe(endpoint: string): Promise<boolean> {
    return this.mutate(() => {
      const before = this.subs.length;
      this.subs = this.subs.filter((s) => s.subscription.endpoint !== endpoint);
      this.inFront.delete(endpoint);
      return this.subs.length !== before;
    });
  }

  /** Registered devices, newest first. Endpoints are NOT trimmed — Settings shows a hash. */
  async list(): Promise<StoredSubscription[]> {
    await this.load();
    return [...this.subs].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /* -------------------------------------------------------------- sending */

  /** Turn an attention item into the payload the service worker renders. */
  static payloadFor(item: AttentionItem): PushPayload {
    return {
      id: item.id,
      chatId: item.chatId,
      kind: item.kind,
      title: KIND_TITLE[item.kind] ?? "Attention",
      body: item.summary,
      sticky: STICKY.has(item.kind),
      permissionRequestId: item.permissionRequestId,
      url: item.url,
    };
  }

  /**
   * Push one attention item to every device that wants it.
   *
   * Never throws: this runs off a bus event, and a push service having a bad
   * afternoon must not take the event loop's error handling with it.
   */
  async fanOut(item: AttentionItem): Promise<void> {
    await this.load();
    if (!this.subs.length) return;
    const now = this.now();
    const targets = this.subs.filter((s) => {
      if (!shouldNotify(s.prefs, item, now)) return false;
      const seen = this.inFront.get(s.subscription.endpoint);
      return seen === undefined || now - seen >= PRESENCE_TTL_MS;
    });
    if (!targets.length) return;
    const payload = JSON.stringify(PushService.payloadFor(item));
    await Promise.all(targets.map((t) => this.send(t, payload)));
  }

  /** Send a "this is what a Dispatch notification looks like" push to one device. */
  async sendTest(endpoint: string): Promise<boolean> {
    await this.load();
    const entry = this.subs.find((s) => s.subscription.endpoint === endpoint);
    if (!entry) return false;
    const payload: PushPayload = {
      id: `att-test-${randomUUID()}`,
      chatId: "",
      kind: "done",
      title: "Dispatch",
      body: "Push notifications are working on this device.",
      sticky: false,
    };
    await this.send(entry, JSON.stringify(payload));
    return true;
  }

  private async send(entry: StoredSubscription, payload: string): Promise<void> {
    try {
      const [wp, vapid] = await Promise.all([this.webPush(), this.vapidKeys()]);
      await wp.sendNotification(entry.subscription, payload, {
        vapidDetails: vapid,
        // Four hours. A permission prompt from this morning is still worth
        // delivering to a phone that just came back online; a week-old one is
        // archaeology, and the push service would hold it that long by default.
        TTL: 4 * 60 * 60,
      });
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode;
      // 404/410 is the push service saying this endpoint is permanently gone —
      // the app was uninstalled, or WebKit revoked it. Anything else (a 5xx, a
      // network blip) is transient and must NOT cost the device its registration.
      if (status === 404 || status === 410) {
        await this.unsubscribe(entry.subscription.endpoint).catch(() => undefined);
        return;
      }
      this.onError?.(err);
    }
  }
}
