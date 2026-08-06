/**
 * Notifier — the "ping my phone when an agent needs me" seam.
 *
 * It subscribes to the bus and, for every `attention-add` event (the global
 * cross-chat Attention Queue: permission / question / idle / done), fires an
 * optional outbound webhook so Michael gets pinged away from the desk.
 *
 * IN-APP delivery is ALWAYS the bus itself (whoever created the AttentionItem
 * already published it) — the notifier NEVER gates or re-publishes that. It is a
 * pure *consumer* whose only side effect is the outbound HTTP POST, and only
 * when a webhook is configured AND enabled in config.json. Webhooks are OFF by
 * default, so with no config this class is a complete no-op (it never calls
 * fetch).
 *
 * Supported webhook shapes (config.json `webhook.kind`):
 *   - "ntfy"     → plain-text POST to the topic URL + Title/Tags/Priority headers.
 *   - "pushover" → form-encoded POST (title/message/priority).
 *   - (unset)    → generic Slack-style JSON `{ text }` POST.
 *
 * A failing webhook is swallowed (surfaced via the optional onError hook) so a
 * flaky endpoint can never crash the event bus.
 */
import type { AttentionItem } from "@dispatch/shared";
import type { EventBus } from "../bus.js";
import type { AppSettings, Store } from "../store/index.js";

/** The (enabled) webhook config block from AppSettings. */
export type WebhookConfig = NonNullable<AppSettings["webhook"]>;

/**
 * Minimal fetch surface the notifier needs. `globalThis.fetch` satisfies this;
 * tests inject a mock. Kept narrow so a `vi.fn()` mock needs no casting.
 */
export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number }>;

/** Per-kind copy + ntfy priority/tags for a notification. */
const KIND_META: Record<
  AttentionItem["kind"],
  { title: string; tags: string; priority: number }
> = {
  permission: { title: "Permission needed", tags: "lock", priority: 4 },
  question: { title: "Question", tags: "question", priority: 4 },
  idle: { title: "Waiting for input", tags: "hourglass", priority: 3 },
  done: { title: "Task done", tags: "white_check_mark", priority: 3 },
};

/** The four attention kinds we notify on (defensive guard for future kinds). */
const NOTIFY_KINDS: ReadonlySet<string> = new Set([
  "permission",
  "question",
  "idle",
  "done",
]);

/**
 * Build the outbound HTTP request for an attention item + webhook config.
 * Pure and side-effect-free so it can be unit-tested directly. Returns null when
 * the webhook has no URL (nothing to POST to).
 */
export function buildWebhookRequest(
  item: AttentionItem,
  webhook: WebhookConfig,
): { url: string; init: RequestInit } | null {
  if (!webhook.url) return null;

  const meta = KIND_META[item.kind] ?? {
    title: "Attention",
    tags: "bell",
    priority: 3,
  };
  const title = meta.title;
  const message = item.summary;

  if (webhook.kind === "ntfy") {
    // ntfy: message is the raw body; metadata rides in headers.
    return {
      url: webhook.url,
      init: {
        method: "POST",
        headers: {
          Title: title,
          Tags: meta.tags,
          Priority: String(meta.priority),
        },
        body: message,
      },
    };
  }

  if (webhook.kind === "pushover") {
    // Pushover: form-encoded. token/user are supplied out-of-band by the
    // endpoint config (the manager only knows the URL by design).
    const form = new URLSearchParams({
      title,
      message,
      priority: String(meta.priority >= 4 ? 1 : 0),
    });
    return {
      url: webhook.url,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
    };
  }

  // Generic Slack-style incoming webhook: JSON { text }.
  return {
    url: webhook.url,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `${title}: ${message}` }),
    },
  };
}

/** Constructor dependencies for the Notifier. */
export interface NotifierDeps {
  bus: EventBus;
  store: Store;
  /** Injectable fetch (defaults to global fetch). */
  fetch?: FetchLike;
  /** Optional observer for webhook delivery failures (defaults to stderr). */
  onError?: (err: unknown, item: AttentionItem) => void;
}

export class Notifier {
  private readonly bus: EventBus;
  private readonly store: Store;
  private readonly fetchImpl: FetchLike;
  private readonly onError: (err: unknown, item: AttentionItem) => void;
  private unsub: (() => void) | undefined;
  /** In-flight deliveries, so tests can deterministically await the bus path. */
  private readonly pending = new Set<Promise<void>>();

  constructor(deps: NotifierDeps) {
    this.bus = deps.bus;
    this.store = deps.store;
    this.fetchImpl =
      deps.fetch ?? ((url, init) => fetch(url, init));
    this.onError =
      deps.onError ??
      ((err) => {
        // eslint-disable-next-line no-console
        console.error("[notifier] webhook delivery failed:", err);
      });
  }

  /** Begin listening for attention events. Idempotent. */
  start(): void {
    if (this.unsub) return;
    this.unsub = this.bus.on("attention-add", (evt) => {
      const p = this.handle(evt.item).finally(() => this.pending.delete(p));
      this.pending.add(p);
    });
  }

  /** Stop listening. Idempotent. */
  stop(): void {
    this.unsub?.();
    this.unsub = undefined;
  }

  /** Resolve once every in-flight delivery has settled (test helper). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  /**
   * Deliver one attention item to the configured webhook. No-op (never touches
   * fetch) when the item isn't notifiable or no enabled webhook with a URL is
   * configured. Safe to call directly; never rejects.
   */
  async handle(item: AttentionItem): Promise<void> {
    if (!NOTIFY_KINDS.has(item.kind)) return;

    let webhook: WebhookConfig | undefined;
    try {
      const settings = await this.store.getSettings();
      webhook = settings.webhook;
    } catch (err) {
      this.onError(err, item);
      return;
    }

    // OFF by default: no config, disabled, or no URL → nothing to send.
    if (!webhook || !webhook.enabled || !webhook.url) return;

    const req = buildWebhookRequest(item, webhook);
    if (!req) return;

    try {
      await this.fetchImpl(req.url, req.init);
    } catch (err) {
      this.onError(err, item);
    }
  }
}

/** Construct and start a Notifier in one call. */
export function startNotifier(deps: NotifierDeps): Notifier {
  const n = new Notifier(deps);
  n.start();
  return n;
}
