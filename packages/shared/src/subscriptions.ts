/**
 * Subscriptions — named login accounts, several per provider.
 *
 * A subscription is deliberately NOTHING BUT a pointer at a provider config
 * directory. The login inside it was made by that provider's own CLI login flow
 * (`claude /login` with `CLAUDE_CONFIG_DIR` set, `codex login` with `CODEX_HOME`
 * set); Dispatch never collects, stores or forwards a token. Selecting an
 * account for a chat is setting one env var on the runtime it spawns.
 *
 * Single-user by design: the accounts are one person's own, on one machine.
 * Nothing here is shareable, and nothing should grow to make it so.
 *
 * An install that has never listed any gets one IMPLICIT subscription per
 * provider, pointing at that provider's default directory — so a chat with no
 * `subscriptionId`, on an install with no list, runs exactly as it did before
 * subscriptions existed.
 */
import * as z from "zod";
import { HarnessKindSchema, type HarnessKind } from "./common.js";
import { PROVIDER_IDS, providerFor } from "./providers.js";

/** Lowercase slug: stable in URLs, chat records and MCP arguments. */
export const SubscriptionIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase letters, digits and dashes, 1-40 chars");

export const SubscriptionSchema = z.object({
  id: SubscriptionIdSchema,
  /** Freeform display name — "Personal Max", "claude2". */
  name: z.string().trim().min(1).max(80),
  provider: HarnessKindSchema,
  /**
   * The provider config directory holding this account's login. Absent means
   * the provider's default (its env var if the server was started with one,
   * else `~/<defaultConfigDir>`), which is what the implicit subscriptions use.
   */
  configDir: z.string().trim().min(1).optional(),
  /**
   * The endpoint this account serves models from, for a provider whose
   * `account.endpointEnv` says it has one (goose → `OLLAMA_HOST`). Absent means
   * that provider's default endpoint, which is what the implicit subscriptions
   * use. Meaningless — and ignored — for a provider without one.
   *
   * Stored as written. Ollama's own convention allows a bare `host:port`, so
   * demanding a scheme here would reject the exact string a user copies out of
   * their own Ollama config; normalising to an origin is the reader's job.
   */
  host: z.string().trim().min(1).max(200).optional(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

/**
 * The stored list. Ids must be unique; everything else about validity (does
 * the dir exist, is it logged in) is a runtime fact the settings pane shows
 * rather than a reason to refuse the save.
 */
export const SubscriptionListSchema = z
  .array(SubscriptionSchema)
  .max(32)
  .refine((list) => new Set(list.map((s) => s.id)).size === list.length, "duplicate subscription id");

/**
 * A stored `host` as an absolute origin, with no trailing slash.
 *
 * Shared because the value travels: `accountOf` writes it into the env a
 * runtime is spawned with, and the harness reads it back to decide which
 * Ollama to list models from. Two normalisers would eventually disagree about
 * a trailing slash and the model list would silently belong to a cache key
 * nobody looks up.
 *
 * A bare `host:port` is Ollama's own spelling — it is what `OLLAMA_HOST` is set
 * to in the service's config — so it is what a user copies, and rejecting it
 * for lacking a scheme would be pedantry at their expense.
 */
export function endpointOrigin(raw: string): string {
  const trimmed = raw.trim();
  const absolute = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  // Scanned rather than `replace(/\/+$/, "")`: an anchored `+` backtracks over
  // a long run of slashes, which CodeQL flags as polynomial. The schema caps a
  // STORED host at 200 chars, but this also normalises `OLLAMA_HOST` straight
  // out of the environment, where nothing caps anything.
  let end = absolute.length;
  while (end > 0 && absolute[end - 1] === "/") end -= 1;
  return absolute.slice(0, end);
}

/** A subscription as the rest of the app sees it: explicit or implicit. */
export interface ResolvedSubscription extends Subscription {
  /** Synthesized for a provider the stored list says nothing about. */
  implicit?: boolean;
}

/** The shape of settings this module reads, kept structural for both packages. */
export interface SubscriptionSettings {
  subscriptions?: Subscription[];
  harness?: {
    defaults?: Partial<Record<HarnessKind, { subscriptionId?: string }>>;
  };
}

/**
 * Every subscription in effect: the stored list, plus an implicit default for
 * each provider that has none. Per provider rather than "list or nothing", so
 * listing two Claude accounts does not quietly make Codex unusable.
 */
export function resolveSubscriptions(
  settings: SubscriptionSettings | null | undefined,
): ResolvedSubscription[] {
  const stored = settings?.subscriptions ?? [];
  const out: ResolvedSubscription[] = [...stored];
  const taken = new Set(stored.map((s) => s.id));
  for (const provider of PROVIDER_IDS) {
    if (stored.some((s) => s.provider === provider)) continue;
    // The provider id is the natural implicit id. Suffixed only when a stored
    // subscription of ANOTHER provider already took it, which is legal and rare.
    let id: string = provider;
    for (let n = 2; taken.has(id); n += 1) id = `${provider}-${n}`;
    taken.add(id);
    out.push({ id, name: providerFor(provider).label, provider, implicit: true });
  }
  return out;
}

/**
 * The subscription a chat on `provider` runs under.
 *
 * `wanted` wins when it names a subscription OF THAT PROVIDER. A missing one
 * (removed since the chat was pinned) or one on another provider (a stale pin
 * after a provider move) falls to the provider's default rather than failing:
 * a chat whose account was deleted must still open, and a Codex chat must never
 * be handed a Claude config dir.
 */
export function subscriptionFor(
  settings: SubscriptionSettings | null | undefined,
  provider: HarnessKind,
  wanted?: string | null,
): ResolvedSubscription {
  const all = resolveSubscriptions(settings);
  const mine = all.filter((s) => s.provider === provider);
  const pinned = wanted ? mine.find((s) => s.id === wanted) : undefined;
  if (pinned) return pinned;
  const preferred = settings?.harness?.defaults?.[provider]?.subscriptionId;
  // `resolveSubscriptions` guarantees at least one per provider.
  return mine.find((s) => s.id === preferred) ?? mine[0]!;
}

/**
 * The id to PIN on a chat for this subscription — none for an implicit one.
 *
 * An implicit id is a name for "the provider's default directory" that stops
 * existing the moment a real list mentions that provider. Pinning it would turn
 * the first saved account into a silent re-home: the stale pin falls to the
 * provider default, which may be a different directory from the one holding the
 * chat's session. Unpinned, the chat keeps resolving by directory instead.
 */
export function pinnedIdOf(sub: ResolvedSubscription): string | undefined {
  return sub.implicit ? undefined : sub.id;
}

/** Find a subscription by id across every provider. */
export function findSubscription(
  settings: SubscriptionSettings | null | undefined,
  id: string | null | undefined,
): ResolvedSubscription | undefined {
  return id ? resolveSubscriptions(settings).find((s) => s.id === id) : undefined;
}

/** A subscription plus what the server can tell about its directory. */
export interface SubscriptionStatus extends ResolvedSubscription {
  /** The config dir actually in effect (the default resolved when unset). */
  resolvedConfigDir: string;
  /** The directory exists. */
  dirExists: boolean;
  /** The provider's login file exists in it. Existence only — never contents. */
  loggedIn: boolean;
  /** This is the provider's default subscription. */
  isDefault: boolean;
  /**
   * Its directory IS the provider's default config dir — where every session a
   * chat wrote before subscriptions existed lives. See {@link chatAccountOf}.
   */
  atDefaultDir: boolean;
}

/**
 * The account a chat runs under, read off the server's status list — the
 * client's copy of the server's `chatSubscription`, which it can't call because
 * "the provider's default directory" is a fact about the server's machine. The
 * statuses carry that fact as `atDefaultDir`, so the two rules agree exactly.
 *
 * Pinned → that account while it is still one of the chat's provider's. Unpinned,
 * or a pin that no longer resolves → the account at the default dir, else the
 * provider default.
 *
 * The default-dir step is SKIPPED for an endpoint provider, matching the same
 * carve-out in the server's `chatSubscription`. Every goose account sits at the
 * same default dir — none of them sets `configDir` — so `atDefaultDir` is true
 * for all of them and this would never reach `isDefault`, showing the wrong
 * account as active in the composer and usage meter for exactly the chats the
 * server also resolves by default.
 */
export function chatAccountOf(
  statuses: readonly SubscriptionStatus[],
  chat: { harness?: HarnessKind; subscriptionId?: string },
  provider: HarnessKind,
): SubscriptionStatus | undefined {
  const mine = statuses.filter((s) => s.provider === provider);
  const pinned = chat.subscriptionId ? mine.find((s) => s.id === chat.subscriptionId) : undefined;
  const byDir = providerFor(provider).account.endpointEnv
    ? undefined
    : mine.find((s) => s.atDefaultDir);
  return pinned ?? byDir ?? mine.find((s) => s.isDefault) ?? mine[0];
}

/**
 * How to name an account in a picker: its own name, except an implicit one,
 * whose synthesized name is the provider's product name — "Claude" reads better
 * beside a model list than "Claude Code".
 */
export function accountLabel(sub: Pick<ResolvedSubscription, "name" | "provider" | "implicit">): string {
  return sub.implicit ? providerFor(sub.provider).shortLabel : sub.name;
}
