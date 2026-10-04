/**
 * READING ONE ACCOUNT'S REMAINING BUDGET.
 *
 * Two providers answer the question "how much of this login is left" in two
 * different ways: a runtime that reports its own limits (Codex) is asked
 * directly, while Claude on subscription auth is read by the OAuth usage poller,
 * which keeps a 5-minute poll and a 429 cooldown no ad-hoc call could honour.
 *
 * Extracted out of `routes/usage.ts` because the failover picker needs the same
 * answer the usage card shows. Two readers would eventually disagree about what
 * "exhausted" means, and the one that decides whether to move a chat onto
 * another subscription is the one it would matter on.
 */
import { usageWindowsOf, type ResolvedSubscription, type UsageSnapshot } from "@dispatch/shared";
import type { HarnessRegistry } from "../harness/index.js";
import type { UsageRegistry } from "./usage.js";
import { accountOf } from "./subscriptions.js";

export interface UsageReadDeps {
  harnesses: HarnessRegistry;
  accountUsage: UsageRegistry;
}

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

/** Read an account's usage. `refresh` forces a fetch instead of the cache. */
export async function readAccountUsage(
  deps: UsageReadDeps,
  sub: ResolvedSubscription,
  refresh = false,
): Promise<AccountUsage> {
  const account = accountOf(sub);
  const harness = deps.harnesses.find(sub.provider);
  if (!harness?.capabilities.usageLimits) {
    const poller = deps.accountUsage.for(account);
    // Stamped here as well as by the poller: the default account's service polls
    // at boot, before anything has told it which subscription it is serving, so
    // its cached snapshot can predate the id.
    const snapshot = await (refresh ? poller.refresh() : poller.get());
    return { snapshot: { ...snapshot, subscriptionId: sub.id } };
  }
  const limits = await harness.readLimits(account);
  const win = (value: { usedPercent?: number; resetsAt?: number } | null | undefined) =>
    value && typeof value.usedPercent === "number"
      ? { percent: value.usedPercent, resetsAt: value.resetsAt ?? null }
      : null;
  const windows = limits?.windows?.flatMap((w) => {
    const shown = win(w);
    return shown ? [{ ...shown, title: w.title }] : [];
  });
  return {
    reached: limits?.reached,
    snapshot: {
      fiveHour: win(limits?.primary),
      sevenDay: win(limits?.secondary),
      fetchedAt: Date.now(),
      provider: sub.provider,
      subscriptionId: sub.id,
      primaryLabel: windowLabel(limits?.primary?.windowMinutes, "Primary window"),
      secondaryLabel: windowLabel(limits?.secondary?.windowMinutes, "Secondary window"),
      planType: limits?.planType,
      ...(windows ? { windows } : {}),
      ...(limits ? {} : { stale: true, error: "unavailable" }),
    },
  };
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
