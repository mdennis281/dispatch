/**
 * FALLING BACK TO ANOTHER SUBSCRIPTION WHEN ONE RUNS OUT.
 *
 * Hitting a 5-hour or weekly limit used to mean one thing: the chat parks and
 * waits for the window to reopen (services/resume-scheduler.ts). That is the
 * right answer only when there is nowhere else to go. With a second login
 * configured — another Claude account, or Claude for a Codex chat — the work can
 * carry on immediately instead of stopping for hours.
 *
 * WHAT THIS DOES NOT DECIDE. The chain is pure configuration, read from each
 * subscription's `fallbacks` (see `fallbackChain` in @dispatch/shared). This
 * service only filters that list down to accounts that could actually take the
 * work right now, and hands the move to `SessionBroker.setSubscription`, which
 * already knows how to carry a session across config dirs and how to degrade to
 * a transcript handoff when it can't.
 *
 * ONE HOP IS NOT ALWAYS LOSSLESS. Claude → Claude copies the session file, so
 * the chat continues with its real context. Codex → Claude cannot (no provider
 * implements `transferSession` across providers), so it continues from a
 * transcript handoff. That cost is the user's to accept by configuring the edge;
 * it is not a reason to refuse the hop, because the alternative is a chat that
 * does nothing at all until tomorrow.
 *
 * THE EXHAUSTION LEDGER is why this is a service and not a function. An account
 * that just ended a turn with a limit sentence is known-dead until its window
 * reopens, and that fact has to outlive the chat that discovered it: otherwise
 * A→B→A ping-pongs, since each hop re-reads a usage API whose snapshot is up to
 * five minutes old and whose failure mode is "looks fine". It is deliberately
 * in-memory — a restart drops it, and the usage read plus the next real limit
 * sentence rebuild it — because it is a cache of something the provider owns.
 */
import {
  DEFAULT_HARNESS,
  accountLabel,
  fallbackChain,
  usageWindowsOf,
  type HarnessKind,
  type ResolvedSubscription,
} from "@dispatch/shared";
import type { Store } from "../store/index.js";
import type { EventBus } from "../bus.js";
import type { HarnessRegistry } from "../harness/index.js";
import type { UsageRegistry } from "./usage.js";
import { chatSubscription, subscriptionStatuses } from "./subscriptions.js";
import { readAccountUsage, usageExhausted, type AccountUsage, type UsageReadDeps } from "./usage-read.js";

/** How long an account stays marked dead when the limit named no reset time. */
const UNKNOWN_RESET_MS = 60 * 60_000;

/** A completed move. */
export interface FailoverResult {
  from: ResolvedSubscription;
  to: ResolvedSubscription;
}

export interface FailoverServiceOpts {
  store: Store;
  bus: EventBus;
  harnesses: HarnessRegistry;
  accountUsage: UsageRegistry;
  /**
   * Move the chat. Injected rather than taking the broker, because the broker
   * constructs this service's caller — and because the whole contract here is
   * "pick an account", which is testable without a session machine.
   */
  switchTo: (chatId: string, subscriptionId: string) => Promise<void>;
  now?: () => number;
}

export class FailoverService {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly harnesses: HarnessRegistry;
  /** The two registries as `readAccountUsage` wants them, built once. */
  private readonly usageDeps: UsageReadDeps;
  private readonly switchTo: (chatId: string, subscriptionId: string) => Promise<void>;
  private readonly now: () => number;
  /** subscription id → epoch ms its window reopens. See the header. */
  private readonly dead = new Map<string, number>();

  constructor(opts: FailoverServiceOpts) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.harnesses = opts.harnesses;
    this.usageDeps = { harnesses: opts.harnesses, accountUsage: opts.accountUsage };
    this.switchTo = opts.switchTo;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Record that an account is out of budget until `resetsAt`.
   *
   * Called for every limit we see, including ones we then fail to act on — the
   * knowledge is worth keeping either way, since the next chat to consider this
   * account as a fallback target should skip it.
   */
  markExhausted(subscriptionId: string, resetsAt?: number): void {
    const until = resetsAt && resetsAt > this.now() ? resetsAt : this.now() + UNKNOWN_RESET_MS;
    const existing = this.dead.get(subscriptionId);
    // Keep the later reset: a weekly limit must not be shortened by a 5-hour
    // one seen afterwards.
    if (existing === undefined || until > existing) this.dead.set(subscriptionId, until);
  }

  /** Is this account known-dead right now (and not merely stale in the ledger)? */
  private isDead(subscriptionId: string): boolean {
    const until = this.dead.get(subscriptionId);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.dead.delete(subscriptionId);
    return false;
  }

  /**
   * The first account in `from`'s chain that could take work right now, or null.
   *
   * Three filters, cheapest first: the provider has to be installed (falling
   * back to a runtime that isn't on this machine fails on the first turn), the
   * account has to be logged in (same), and it must not be out of budget.
   */
  async pick(from: ResolvedSubscription): Promise<ResolvedSubscription | null> {
    const settings = await this.store.getSettings().catch(() => null);
    const candidates = fallbackChain(settings, from.id);
    if (candidates.length === 0) return null;
    const installed = new Set<HarnessKind>(
      this.harnesses
        .list()
        .filter((h) => h.runtime().available)
        .map((h) => h.kind),
    );
    const statuses = subscriptionStatuses(settings);
    for (const candidate of candidates) {
      if (!installed.has(candidate.provider)) continue;
      if (this.isDead(candidate.id)) continue;
      if (!statuses.find((s) => s.id === candidate.id)?.loggedIn) continue;
      // Forced fresh: a cached snapshot can be five minutes old, and we are
      // about to move a conversation onto this account on the strength of it.
      // A read that fails answers "has budget" (see `usageExhausted`), which is
      // the right bias — the hop's own limit sentence would catch it, and that
      // costs a turn where refusing costs the whole task.
      const usage = await readAccountUsage(this.usageDeps, candidate, true).catch(() => null);
      if (usage && usageExhausted(usage)) {
        this.markExhausted(candidate.id, nextReset(usage));
        continue;
      }
      return candidate;
    }
    return null;
  }

  /**
   * A chat's turn died on a usage limit — move it to a fallback and say so.
   *
   * Returns the move, or null when there was nowhere to go, which is the signal
   * to fall back on falling back: the caller parks the chat until the window
   * reopens, exactly as before this service existed.
   */
  async onLimit(
    chatId: string,
    reason: string,
    resetsAt: number | undefined,
  ): Promise<FailoverResult | null> {
    const chat = await this.store.getChat(chatId).catch(() => null);
    if (!chat) return null;
    const settings = await this.store.getSettings().catch(() => null);
    const from = chatSubscription(settings, {
      harness: chat.harness ?? DEFAULT_HARNESS,
      subscriptionId: chat.subscriptionId,
    });
    this.markExhausted(from.id, resetsAt);
    const to = await this.pick(from);
    if (!to) return null;
    // Announced BEFORE the move, because `setSubscription` publishes its own
    // "Switched to …" notice and a bare switch with no stated cause reads as
    // something the human did.
    this.notice(
      chatId,
      `${accountLabel(from)} is out of budget (${reason.trim()}) — falling back to ${accountLabel(to)}.`,
    );
    try {
      await this.switchTo(chatId, to.id);
    } catch (err) {
      this.notice(
        chatId,
        `Could not fall back to ${accountLabel(to)}: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return null;
    }
    return { from, to };
  }

  /**
   * The account a NEW chat should actually start on.
   *
   * A chat created against an account with nothing left would otherwise burn a
   * turn discovering that, then fall back — which works, but means every chat
   * spawned after a limit opens with an error in it. Resolution stays with
   * `resolveChatPosture`; this only redirects an answer already known to be
   * dead, and returns null to mean "keep what you resolved".
   */
  async redirectNewChat(resolved: ResolvedSubscription): Promise<ResolvedSubscription | null> {
    // Cached, not forced: this runs on every chat creation, and a cheap stale
    // "fine" simply leaves the old behaviour in place.
    const usage = await readAccountUsage(this.usageDeps, resolved, false).catch(() => null);
    const out = this.isDead(resolved.id) || (usage ? usageExhausted(usage) : false);
    if (!out) return null;
    if (usage) this.markExhausted(resolved.id, nextReset(usage));
    return this.pick(resolved);
  }

  private notice(chatId: string, text: string, level: "info" | "error" = "info"): void {
    this.bus.publish({ type: "notice", chatId, level, text });
  }
}

/**
 * When the account becomes usable again: the LATEST reopening among the windows
 * that are out. The latest rather than the soonest because an account whose
 * weekly budget is gone is not usable when its 5-hour window rolls over.
 *
 * `reached` widens that to EVERY window, because the runtime's own verdict is
 * independent of the percentages — Codex sets it from a spend cap or a rate
 * limit type, which can fire at 60% used. Reading only the full windows there
 * found nothing and fell back to the one-hour guess, so a spend-capped account
 * got a fresh forced usage read every hour for as long as the cap held, instead
 * of waiting for the real reset already sitting in the snapshot.
 */
export function nextReset(usage: AccountUsage): number | undefined {
  const times = usageWindowsOf(usage.snapshot).flatMap((w) =>
    (usage.reached || w.percent >= 100) && typeof w.resetsAt === "number" ? [w.resetsAt] : [],
  );
  return times.length > 0 ? Math.max(...times) : undefined;
}
