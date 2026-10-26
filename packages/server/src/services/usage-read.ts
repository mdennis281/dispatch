/**
 * READING ONE ACCOUNT'S REMAINING BUDGET.
 *
 * Every provider answers through `Harness.readLimits`, and only a provider that
 * declares `capabilities.usageLimits` is asked. One that doesn't gets an honest
 * "no meter" — never another provider's numbers. It used to get Claude's: any
 * provider without `usageLimits` was routed to the Claude OAuth poller, and a
 * goose default account (empty env overlay) was handed the DEFAULT Claude
 * login's poller, stamped with goose's subscription id. Its usage row and the
 * failover check both read Claude's windows (#425).
 *
 * Extracted out of `routes/usage.ts` because the failover picker needs the same
 * answer the usage card shows. Two readers would eventually disagree about what
 * "exhausted" means, and the one that decides whether to move a chat onto
 * another subscription is the one it would matter on.
 */
import {
  usageWindowsOf,
  type HarnessLimits,
  type ResolvedSubscription,
  type UsageSnapshot,
} from "@dispatch/shared";
import type { HarnessRegistry } from "../harness/index.js";
import { accountOf } from "./subscriptions.js";

export interface UsageReadDeps {
  harnesses: Pick<HarnessRegistry, "find">;
}

/** The snapshot `error` for a provider that reports no usage at all. */
export const NO_METER = "no_meter";

/**
 * A rate-limit window's length as a person would say it. Codex reports its
 * windows in raw minutes, and the usage card used to print "10080-minute
 * window" for what is simply the weekly limit.
 */
export function windowLabel(minutes: number | undefined, fallback: string): string {
  if (!minutes || minutes <= 0) return fallback;
  if (minutes === 7 * 24 * 60) return "Weekly";
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

/** One account's windows, plus the runtime's own verdict when it gave one. */
export interface AccountUsage {
  snapshot: UsageSnapshot;
  /**
   * The runtime said outright that this account is OUT of budget — not merely
   * near it. Only Codex-shaped providers report this; it is strictly better
   * evidence than a percentage, which can read 99.6% on a dead account.
   */
  reached?: boolean;
}

/** A provider's limits as the snapshot the meter and the card draw. */
export function snapshotOfLimits(
  sub: ResolvedSubscription,
  limits: HarnessLimits | null,
  now = Date.now(),
): UsageSnapshot {
  const win = (value: { usedPercent?: number; resetsAt?: number } | null | undefined) =>
    value && typeof value.usedPercent === "number"
      ? { percent: value.usedPercent, resetsAt: value.resetsAt ?? null }
      : null;
  const windows = limits?.windows?.flatMap((w) => {
    const shown = win(w);
    return shown ? [{ ...shown, title: w.title }] : [];
  });
  return {
    fiveHour: win(limits?.primary),
    sevenDay: win(limits?.secondary),
    fetchedAt: now,
    provider: sub.provider,
    subscriptionId: sub.id,
    primaryLabel: windowLabel(limits?.primary?.windowMinutes, "Primary window"),
    secondaryLabel: windowLabel(limits?.secondary?.windowMinutes, "Secondary window"),
    ...(limits?.planType ? { planType: limits.planType } : {}),
    ...(windows ? { windows } : {}),
    ...(!limits
      ? { stale: true, error: "unavailable" }
      : limits.stale
        ? { stale: true, error: limits.error ?? "unavailable" }
        : {}),
  };
}

/** Read an account's usage. `refresh` asks the provider past its cache. */
export async function readAccountUsage(
  deps: UsageReadDeps,
  sub: ResolvedSubscription,
  refresh = false,
): Promise<AccountUsage> {
  const harness = deps.harnesses.find(sub.provider);
  if (!harness?.capabilities.usageLimits) {
    // Not stale and not a failure: there is nothing to read, and saying so is
    // the honest meter. `usageExhausted` reads the error as "has budget".
    return {
      snapshot: {
        fiveHour: null,
        sevenDay: null,
        fetchedAt: Date.now(),
        provider: sub.provider,
        subscriptionId: sub.id,
        error: NO_METER,
      },
    };
  }
  const account = accountOf(sub);
  // A refresh that fails falls back to the cache, which carries the failure as
  // `stale` — the card shows the last good numbers and why they're old.
  const fresh = refresh ? await harness.readLimits(account, { fresh: true }).catch(() => null) : null;
  const limits = fresh ?? (await harness.readLimits(account));
  return { reached: limits?.reached, snapshot: snapshotOfLimits(sub, limits) };
}

/**
 * Is this account out of budget right now?
 *
 * A failed or stale read answers NO on purpose. The two callers both act on a
 * yes — one parks a chat, the other moves it to a different login — so an
 * unreachable usage endpoint must not be able to condemn an account that is
 * perfectly usable. The limit sentence on a real turn remains the authority;
 * this is only ever the cheaper check made first.
 */
export function usageExhausted(usage: AccountUsage): boolean {
  if (usage.reached) return true;
  if (usage.snapshot.stale || usage.snapshot.error) return false;
  return usageWindowsOf(usage.snapshot).some((w) => w.percent >= 100);
}
