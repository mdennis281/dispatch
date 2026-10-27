/**
 * The last known login state of each provider ACCOUNT, so a chat on a provider
 * that is not logged in shows "provider unavailable" instead of failing
 * mid-turn on the runtime's own auth error (#428).
 *
 * Cached on purpose, and read synchronously: `HarnessRegistry.resolve` runs on
 * every turn start, and a login probe is a subprocess (`claude auth status`,
 * `codex login status`) of up to several seconds. So a send never waits on a
 * probe. It reads what the last one said, and a stale or missing entry kicks a
 * background refresh whose answer applies to the NEXT send — and announces
 * itself with `providers-changed`, so an open composer's banner appears or
 * clears without a reload.
 *
 * Keyed by provider and config DIRECTORY, the same identity a subscription
 * has: a chat on a second Claude account must not be refused because the
 * default one is logged out, or let through because it isn't.
 *
 * Only ever probes a REGISTERED provider. With the Claude plugin switched off
 * nothing here can spawn `claude` — which is the point of #422.
 */
import {
  isLoggedOut,
  subscriptionFor,
  type HarnessKind,
  type RuntimeLoginStatus,
  type SubscriptionSettings,
} from "@dispatch/shared";
import type { HarnessAccount } from "../harness/types.js";
import type { HarnessRegistry } from "../harness/index.js";
import { probeRuntimeLogins } from "./runtime-login.js";
import { accountOf } from "./subscriptions.js";

/**
 * How long a probe's answer stands. Long enough that a busy install probes a
 * handful of times an hour, short enough that logging in elsewhere is noticed
 * without a restart — and the setup card's Re-check updates it at once.
 */
const TTL_MS = 5 * 60_000;

interface Entry {
  status: RuntimeLoginStatus;
  at: number;
}

export interface ProviderLoginsOpts {
  harnesses: HarnessRegistry;
  settings: () => Promise<SubscriptionSettings | null | undefined>;
  /** A cached answer changed — the host publishes `providers-changed`. */
  onChange?: (kind: HarnessKind) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  ttlMs?: number;
}

const keyOf = (kind: HarnessKind, configDir: string): string =>
  `${kind}\0${process.platform === "win32" ? configDir.toLowerCase() : configDir}`;

export class ProviderLogins {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<RuntimeLoginStatus | undefined>>();
  /** Each provider's default account dir, learnt from the settings on refresh. */
  private readonly defaultDirs = new Map<HarnessKind, string>();
  private readonly now: () => number;
  private readonly ttl: number;

  constructor(private readonly opts: ProviderLoginsOpts) {
    this.now = opts.now ?? Date.now;
    this.ttl = opts.ttlMs ?? TTL_MS;
  }

  /**
   * The cached status for an account (the provider's default when `account`
   * is absent), or undefined when none is known. Never waits; a missing or
   * stale entry starts a refresh in the background.
   */
  peek(kind: HarnessKind, account?: HarnessAccount): RuntimeLoginStatus | undefined {
    const dir = account?.configDir ?? this.defaultDirs.get(kind);
    const entry = dir !== undefined ? this.entries.get(keyOf(kind, dir)) : undefined;
    if (!entry || this.now() - entry.at > this.ttl) void this.refresh(kind, account).catch(() => {});
    return entry?.status;
  }

  /**
   * Probe one account now (deduplicated while one is running) and cache the
   * answer. Resolves undefined when the provider is not registered.
   */
  async refresh(kind: HarnessKind, account?: HarnessAccount): Promise<RuntimeLoginStatus | undefined> {
    const harness = this.opts.harnesses.find(kind);
    if (!harness) return undefined;
    const settings = await this.opts.settings().catch(() => null);
    const fallback = accountOf(subscriptionFor(settings, kind));
    this.defaultDirs.set(kind, fallback.configDir);
    const target = account ?? fallback;
    const key = keyOf(kind, target.configDir);
    const running = this.inflight.get(key);
    if (running) return running;
    const probe = (async () => {
      // One harness, under THIS account's env overlay — the same probe the
      // setup card runs, so the two can never disagree about a login.
      const [status] = await probeRuntimeLogins([harness], null, {
        env: { ...(this.opts.env ?? process.env), ...target.env },
      });
      if (!status) return undefined;
      this.record(kind, target.configDir, status.login);
      return status.login;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, probe);
    return probe;
  }

  /**
   * Store an answer someone else already paid for — the setup card's Re-check
   * runs the same probe uncached, and a login it just saw must clear the
   * banner at once rather than after the TTL.
   */
  record(kind: HarnessKind, configDir: string, status: RuntimeLoginStatus): void {
    const key = keyOf(kind, configDir);
    const before = this.entries.get(key)?.status;
    this.entries.set(key, { status, at: this.now() });
    // Only a flip that changes whether a chat may RUN is news: announcing every
    // first probe at boot would have every tab re-read the provider list once
    // per provider for nothing.
    if (isLoggedOut(before) !== isLoggedOut(status)) this.opts.onChange?.(kind);
  }

  /** Record a setup-card probe for a provider's DEFAULT account. */
  async recordDefault(kind: HarnessKind, status: RuntimeLoginStatus): Promise<void> {
    const settings = await this.opts.settings().catch(() => null);
    const dir = accountOf(subscriptionFor(settings, kind)).configDir;
    this.defaultDirs.set(kind, dir);
    this.record(kind, dir, status);
  }

  /** Probe every registered provider's default account, in the background. */
  warm(): void {
    for (const harness of this.opts.harnesses.list()) void this.refresh(harness.kind).catch(() => {});
  }

  /** Forget a provider whose plugin went away; a re-enabled one probes afresh. */
  forget(kind: HarnessKind): void {
    for (const key of [...this.entries.keys()]) if (key.startsWith(`${kind}\0`)) this.entries.delete(key);
    this.defaultDirs.delete(kind);
  }
}
