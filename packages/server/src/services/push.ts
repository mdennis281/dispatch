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
import { createHash } from "node:crypto";
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
    options: {
      vapidDetails: { subject: string; publicKey: string; privateKey: string };
      TTL?: number;
      /** RFC 8030 §5.4 — see {@link topicForChat}. */
      topic?: string;
    },
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
  /**
   * How many items this chat has outstanding INCLUDING this one, so the worker
   * can render "…and 2 more" on the single notification it keeps per chat.
   *
   * Counted here rather than from `getNotifications()` on the device because the
   * server's count is the true one: a human who swiped the last toast away has
   * an empty tray and three things still waiting.
   *
   * **Zero means WITHDRAW** — close this chat's notification and show nothing.
   * See {@link PushService.withdraw} for why that push never reaches an iPhone.
   */
  outstanding: number;
  /**
   * Total outstanding across every chat — the app icon badge. Omitted means
   * "leave the badge alone", which is what the test push wants: proving that
   * notifications arrive should not claim you have work waiting.
   */
  badge?: number;
}

/** The host Apple issues push endpoints on. */
const APPLE_PUSH_HOST = "web.push.apple.com";

/**
 * Is this device behind Apple's push service (i.e. an iOS/macOS web app)?
 *
 * Load-bearing, not cosmetic: WebKit revokes a subscription after a handful of
 * pushes that display nothing, so the withdraw path — whose whole purpose is to
 * display nothing — must never be sent to one of these.
 */
export function isAppleEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname === APPLE_PUSH_HOST;
  } catch {
    return false;
  }
}

/**
 * The RFC 8030 §5.4 `Topic` for a chat.
 *
 * A push service stores at most ONE undelivered message per topic per
 * subscription, and a new one with a matching topic *deletes* the one already
 * queued. So a phone that was off for an hour wakes to the LATEST state of each
 * chat instead of a burst of twelve — and, because a withdrawal shares its
 * chat's topic, a notification whose reason has since evaporated is dropped
 * before it is ever delivered.
 *
 * That only works because every push carries the chat's whole current state
 * rather than a delta: superseding is always safe, which is not true of a
 * "+1 item" message.
 *
 * The header is limited to 32 characters of the URL-safe base64 alphabet, and
 * `web-push` rejects anything else outright. Chat ids are nanoids — 21
 * characters of exactly that alphabet — so the fast path is the normal one; the
 * digest is for the hand-written slugs the store also accepts as ids.
 */
export function topicForChat(chatId: string): string {
  if (/^[A-Za-z0-9_-]{1,32}$/.test(chatId)) return chatId;
  return createHash("sha256").update(chatId).digest("base64url").slice(0, 32);
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
  /**
   * chatId → its outstanding attention item ids.
   *
   * A second copy of what {@link AttentionQueue} already holds, and deliberately
   * so: it is derived from the same two bus events in the same order, so the two
   * cannot drift, and keeping it here means `PushService` stays constructible
   * from `{bus, configDir, dataDir}` alone. The alternative — injecting the
   * queue — would reorder container construction and rewrite every test's setup
   * to buy a count this map already has.
   */
  private readonly outstanding = new Map<string, Set<string>>();
  /**
   * endpoint → chats that device is currently holding a notification for.
   *
   * Only an approximation of its tray (the human may have swiped one away), but
   * it is enough to answer the one question the withdraw path asks: is there any
   * point waking this device to close something? Without it, every resolved item
   * would wake every registered device to close a notification most of them
   * never had — and on Chrome a push that displays nothing spends budget.
   */
  private readonly shown = new Map<string, Set<string>>();
  private loaded = false;
  /** Serializes the read-modify-write of the registry file. */
  private writeChain: Promise<unknown> = Promise.resolve();
  private offs: Array<() => void> = [];

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
    if (this.offs.length) return;
    this.offs.push(
      this.bus.on("attention-add", (e) => {
        this.track(e.item);
        void this.fanOut(e.item).catch((err) => this.onError?.(err));
      }),
      // The other half of the deal: a notification whose reason is gone is worse
      // than no notification, because acting on it wastes a trip to the desk.
      this.bus.on("attention-resolve", (e) => {
        const emptied = this.untrack(e.id, e.chatId);
        if (emptied) void this.withdraw(emptied).catch((err) => this.onError?.(err));
      }),
    );
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  /* ------------------------------------------------- outstanding bookkeeping */

  private track(item: AttentionItem): void {
    let set = this.outstanding.get(item.chatId);
    if (!set) this.outstanding.set(item.chatId, (set = new Set()));
    set.add(item.id);
  }

  /**
   * Forget one resolved item. Returns its chatId ONLY when that was the chat's
   * last outstanding item, which is the single condition a withdrawal fires on.
   *
   * That is also what keeps a burst quiet without a debounce timer: deleting a
   * chat resolves all six of its items at once, but only the sixth empties the
   * set, so exactly one withdrawal goes out.
   */
  private untrack(id: string, chatId?: string): string | undefined {
    // `chatId` is optional on the event, so fall back to finding the owner.
    const owner =
      chatId && this.outstanding.has(chatId)
        ? chatId
        : [...this.outstanding.entries()].find(([, ids]) => ids.has(id))?.[0];
    if (!owner) return undefined;
    const set = this.outstanding.get(owner);
    if (!set?.delete(id) || set.size > 0) return undefined;
    this.outstanding.delete(owner);
    return owner;
  }

  /** Items waiting across every chat — what the app icon badges. */
  private totalOutstanding(): number {
    let n = 0;
    for (const ids of this.outstanding.values()) n += ids.size;
    return n;
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
  static payloadFor(item: AttentionItem, counts?: { outstanding: number; badge: number }): PushPayload {
    return {
      id: item.id,
      chatId: item.chatId,
      kind: item.kind,
      title: KIND_TITLE[item.kind] ?? "Attention",
      body: item.summary,
      sticky: STICKY.has(item.kind),
      permissionRequestId: item.permissionRequestId,
      url: item.url,
      // Defaults describe exactly this one item, which is what a caller with no
      // queue state (a test, the test button) means by "send this".
      outstanding: counts?.outstanding ?? 1,
      badge: counts?.badge,
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
    const payload = JSON.stringify(
      PushService.payloadFor(item, {
        outstanding: this.outstanding.get(item.chatId)?.size ?? 1,
        badge: this.totalOutstanding(),
      }),
    );
    // Remember who is now holding a notification for this chat, so resolving it
    // later wakes these devices and only these devices.
    for (const t of targets) {
      const ep = t.subscription.endpoint;
      let chats = this.shown.get(ep);
      if (!chats) this.shown.set(ep, (chats = new Set()));
      chats.add(item.chatId);
    }
    const topic = topicForChat(item.chatId);
    await Promise.all(targets.map((t) => this.send(t, payload, topic)));
  }

  /**
   * A chat has nothing outstanding any more — take its notification back.
   *
   * This is the "the question got answered / the thread got resolved / the PR
   * merged while you were away" path. The device is asleep, so the only way to
   * reach into its tray is a push whose handler closes the notification and
   * shows nothing in its place.
   *
   * ── Why iPhones are skipped ────────────────────────────────────────────────
   * That is precisely the shape of push WebKit punishes: display nothing a few
   * times and iOS revokes the subscription, and the symptom is notifications
   * quietly stopping days later. There is no way to withdraw on iOS *and* keep
   * the subscription, so an iPhone keeps the stale notification until it is
   * tapped — the behaviour it already had. Chrome is explicitly fine with this:
   * its forced "site updated in the background" notification is skipped whenever
   * the origin still has one showing, and otherwise costs push budget rather
   * than the subscription.
   */
  async withdraw(chatId: string): Promise<void> {
    await this.load();
    const targets = this.subs.filter((s) => {
      const ep = s.subscription.endpoint;
      if (!this.shown.get(ep)?.has(chatId)) return false;
      if (isAppleEndpoint(ep)) return false;
      // No kind filter: this is the removal of a notification the device already
      // accepted, so re-asking whether it wanted that kind can only strand it.
      return s.prefs.enabled;
    });
    // Forget the chat everywhere, including on the devices we just declined to
    // wake — there is no second attempt, so a lingering entry would only make a
    // future unrelated resolve believe it has something to withdraw.
    for (const chats of this.shown.values()) chats.delete(chatId);
    if (!targets.length) return;
    const payload = JSON.stringify({
      id: `withdraw-${chatId}`,
      chatId,
      kind: "done",
      title: "Dispatch",
      body: "",
      sticky: false,
      outstanding: 0,
      badge: this.totalOutstanding(),
    } satisfies PushPayload);
    const topic = topicForChat(chatId);
    await Promise.all(targets.map((t) => this.send(t, payload, topic)));
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
      outstanding: 1,
      // No `badge`: a test must not make the icon claim there is work waiting.
    };
    return this.send(entry, JSON.stringify(payload));
  }

  private async send(
    entry: StoredSubscription,
    payload: string,
    topic?: string,
  ): Promise<PushSendResult> {
    try {
      const [wp, vapid] = await Promise.all([this.webPush(), this.vapidKeys()]);
      await wp.sendNotification(entry.subscription, payload, {
        vapidDetails: vapid,
        topic,
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
