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
/**
 * The VAPID `sub` claim — who to contact about pushes coming from this app.
 *
 * It is not part of the crypto and nothing reads it in practice, so it looks
 * like a formality. It is not: **Apple VALIDATES it and refuses the push if it
 * is not a routable https URL or mailto address.** This defaulted to
 * `mailto:dispatch@localhost`, and `web.push.apple.com` answered every single
 * send with `403 {"reason":"BadJwtToken"}` — while FCM, which ignores the field
 * entirely, took the same JWT with a 201. So notifications worked perfectly on
 * desktop Chrome and no iPhone ever made a sound, which is the hardest version
 * of this bug to see: the subscription registers, the toggle says On, the test
 * button reports success, and the only evidence is a 403 in the server log.
 *
 * A URL is used rather than an email so the default carries nobody's address.
 */
const DEFAULT_VAPID_SUBJECT = "https://github.com/mdennis281/dispatch";

/** Hosts that exist only on this machine, which is the whole failure above. */
const PRIVATE_HOST = /(^|\.)(localhost|local|internal|localdomain|invalid|home|lan)$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Would a push service accept this as a `sub`? Apple's rule, as far as it can be
 * observed from the outside: an `https:` or `mailto:` URI whose host is a real
 * public name. An IP literal or a machine-local name is rejected.
 */
export function isValidVapidSubject(subject: string): boolean {
  let url: URL;
  try {
    url = new URL(subject.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "mailto:") return false;
  const host =
    url.protocol === "mailto:" ? (url.pathname.split("@")[1] ?? "").toLowerCase() : url.hostname.toLowerCase();
  if (!host || host.includes(",") || host.startsWith("[") || IPV4.test(host)) return false;
  if (PRIVATE_HOST.test(host)) return false;
  // A bare name with no dot ("localhost", "dispatch") resolves nowhere off this
  // machine, so it is the same failure by a different spelling.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host);
}

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
  /**
   * Override the VAPID `sub`. Falls back to `DISPATCH_VAPID_SUBJECT`, then to
   * `DEFAULT_VAPID_SUBJECT`. An invalid value is reported and ignored rather
   * than honoured — a bad subject silently costs you every iOS device.
   */
  subject?: string;
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

/**
 * What one send did.
 *
 * Returned rather than swallowed because the previous version's `sendTest` was
 * `await this.send(...); return true` — it reported success for a push the push
 * service had just refused, which is why "Send test does nothing" was the only
 * symptom of a total iOS outage. A failure the human asked for has to reach the
 * human.
 */
export interface PushSendResult {
  ok: boolean;
  /** HTTP status from the push service, when it answered at all. */
  statusCode?: number;
  /** One line, safe to show in the UI. */
  error?: string;
  /** The endpoint was permanently gone and has been dropped from the registry. */
  gone?: boolean;
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

  /** An explicit, validated subject override, or undefined to use the default. */
  private readonly configuredSubject: string | undefined;

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
    const override = deps.subject ?? process.env.DISPATCH_VAPID_SUBJECT;
    if (override && !isValidVapidSubject(override)) {
      this.onError?.(
        new Error(
          `Ignoring VAPID subject ${JSON.stringify(override)}: it must be an https: URL or ` +
            `mailto: address on a public host, or Apple rejects every push with BadJwtToken.`,
        ),
      );
    }
    this.configuredSubject = override && isValidVapidSubject(override) ? override.trim() : undefined;
  }

  /**
   * The subject to sign with. An explicit override wins; a subject already on
   * disk is kept if it still validates (someone may have set their own address);
   * anything else heals to the default.
   */
  private subjectFor(stored?: string): string {
    if (this.configuredSubject) return this.configuredSubject;
    // Trimmed, because that is what the validator actually inspected: a stored
    // subject padded with whitespace would otherwise pass and then be SIGNED
    // with the padding. Returning the trimmed form also makes the heal below
    // see a difference and rewrite the file, so it doesn't come back next boot.
    if (stored && isValidVapidSubject(stored)) return stored.trim();
    return DEFAULT_VAPID_SUBJECT;
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
      const subject = this.subjectFor(parsed.data.subject);
      if (subject === parsed.data.subject) {
        this.vapid = parsed.data;
        return this.vapid;
      }
      // Heal the subject IN PLACE, keeping the keypair. The `sub` claim is not
      // part of the crypto, so every device that already registered stays valid
      // — which is the point: an install carrying the old `@localhost` subject
      // starts working again on restart, with no phone re-registering anything.
      this.vapid = { ...parsed.data, subject };
      await writeJsonAtomic(this.vapidFile, this.vapid, { mode: 0o600 });
      return this.vapid;
    }
    const wp = await this.webPush();
    const keys = wp.generateVAPIDKeys();
    this.vapid = { ...keys, subject: this.subjectFor() };
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

  /**
   * Send a "this is what a Dispatch notification looks like" push to one device,
   * and REPORT WHAT HAPPENED. Returns null when the endpoint isn't registered.
   *
   * The whole value of this button is that it is the one push whose outcome
   * somebody is watching, so unlike `fanOut` it does not get to fail quietly.
   */
  async sendTest(endpoint: string): Promise<PushSendResult | null> {
    await this.load();
    const entry = this.subs.find((s) => s.subscription.endpoint === endpoint);
    if (!entry) return null;
    const payload: PushPayload = {
      // A fixed id, so the notification's `tag` collapses repeats: press the
      // button twice and you replace the toast rather than stacking two, and a
      // phone that somehow holds two subscriptions still shows one.
      id: "att-test",
      chatId: "",
      kind: "done",
      title: "Dispatch",
      body: "Push notifications are working on this device.",
      sticky: false,
    };
    return this.send(entry, JSON.stringify(payload));
  }

  private async send(entry: StoredSubscription, payload: string): Promise<PushSendResult> {
    try {
      const [wp, vapid] = await Promise.all([this.webPush(), this.vapidKeys()]);
      await wp.sendNotification(entry.subscription, payload, {
        vapidDetails: vapid,
        // Four hours. A permission prompt from this morning is still worth
        // delivering to a phone that just came back online; a week-old one is
        // archaeology, and the push service would hold it that long by default.
        TTL: 4 * 60 * 60,
      });
      return { ok: true };
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode;
      // 404/410 is the push service saying this endpoint is permanently gone —
      // the app was uninstalled, or WebKit revoked it. Anything else (a 5xx, a
      // network blip) is transient and must NOT cost the device its registration.
      if (status === 404 || status === 410) {
        await this.unsubscribe(entry.subscription.endpoint).catch(() => undefined);
        return { ok: false, statusCode: status, gone: true, error: describePushFailure(err) };
      }
      this.onError?.(err);
      return { ok: false, statusCode: status, error: describePushFailure(err) };
    }
  }
}

/**
 * Turn a `web-push` rejection into one line a human can act on.
 *
 * The push service's own body is the useful part and it is small and
 * machine-written (`{"reason":"BadJwtToken"}`), so it is passed through rather
 * than mapped to friendlier prose that would hide which of Apple's many JWT
 * complaints this actually is.
 */
export function describePushFailure(err: unknown): string {
  const e = err as { statusCode?: number; body?: unknown; message?: string };
  const status = e?.statusCode;
  const body = typeof e?.body === "string" ? e.body.trim().slice(0, 200) : "";
  if (status === 403) {
    return (
      `The push service refused this device's credentials (403${body ? ` ${body}` : ""}). ` +
      `Usually the VAPID subject: Apple requires a public https: or mailto: contact.`
    );
  }
  if (status === 404 || status === 410) {
    return `This device's subscription no longer exists (${status}). Turn push off and on again to re-register.`;
  }
  if (status) return `The push service rejected the send (${status}${body ? ` ${body}` : ""}).`;
  return e?.message ? `Could not reach the push service: ${e.message}` : "Could not reach the push service.";
}
