/**
 * REST for subscription usage (the header meter).
 *   GET  /api/usage          → latest UsageSnapshot (polls once if never fetched)
 *   POST /api/usage/refresh  → force a fresh fetch now (the "refresh" button)
 *   GET  /api/usage/subscriptions[?refresh=1] → every logged-in account's windows (the card)
 *   POST /api/usage/reset?subscription=<id>    → spend one of that account's early resets
 * Both take `?subscription=<id>` (whose windows) and/or `?harness=<provider>`
 * (that provider's default account when no subscription is named).
 * The server polls this on a timer too and pushes `usage-update` over the bus;
 * these routes cover initial load + manual refresh.
 */
import type { FastifyInstance } from "fastify";
import {
  isKnownProvider,
  findSubscription,
  accountLabel,
  subscriptionFor,
  usageWindowsOf,
  type ResetSpendResult,
  type ResolvedSubscription,
  type SubscriptionUsage,
  type UsageOverview,
  type UsageSnapshot,
} from "@dispatch/shared";
import { accountOf, subscriptionStatuses } from "../services/subscriptions.js";
import { readAccountUsage } from "../services/usage-read.js";

// Re-exported rather than defined here: the failover picker reads the same
// windows this route renders, so the reader moved down into the services layer
// and took its label helper with it.
export { windowLabel } from "../services/usage-read.js";

interface UsageQuery {
  harness?: string;
  subscription?: string;
}

/** The account a usage request is about. */
async function accountFor(app: FastifyInstance, query: UsageQuery) {
  const settings = await app.cm.store.getSettings().catch(() => null);
  const named = findSubscription(settings, query.subscription);
  if (named) return named;
  // An unknown or absent provider has no account — it is not Claude's. This
  // used to answer `?harness=<disabled plugin>` with the Claude login's
  // windows, so a chat on a provider that was gone showed somebody else's
  // meter (#426).
  return isKnownProvider(query.harness) ? subscriptionFor(settings, query.harness) : undefined;
}

async function snapshotFor(
  app: FastifyInstance,
  query: UsageQuery,
  refresh: boolean,
): Promise<UsageSnapshot> {
  const sub = await accountFor(app, query);
  // An honest "no meter" rather than a borrowed one.
  if (!sub) return { fiveHour: null, sevenDay: null, fetchedAt: Date.now(), error: "unavailable" };
  const usage = await readAccountUsage(app.services, sub, refresh);
  return usage.snapshot;
}

/** One account's row in the card. A failure stays on the row, never throws. */
async function usageRow(
  app: FastifyInstance,
  sub: Pick<ResolvedSubscription, "id" | "provider" | "name" | "implicit">,
  refresh: boolean,
): Promise<SubscriptionUsage> {
  const base = { subscriptionId: sub.id, name: accountLabel(sub), provider: sub.provider };
  try {
    const snap = await snapshotFor(app, { subscription: sub.id }, refresh);
    return {
      ...base,
      windows: usageWindowsOf(snap),
      fetchedAt: snap.fetchedAt,
      ...(snap.planType ? { planType: snap.planType } : {}),
      ...(snap.resetCredits !== undefined ? { resetCredits: snap.resetCredits } : {}),
      ...(snap.resetGrants ? { resetGrants: snap.resetGrants } : {}),
      ...(snap.resetHint ? { resetHint: snap.resetHint } : {}),
      ...(snap.reached ? { reached: true } : {}),
      ...(snap.stale ? { stale: true } : {}),
      ...(snap.error ? { error: snap.error } : {}),
    };
  } catch (err) {
    return {
      ...base,
      windows: [],
      fetchedAt: Date.now(),
      stale: true,
      error: err instanceof Error ? err.message : "unavailable",
    };
  }
}

/**
 * Every logged-in account of an installed provider, read at once.
 *
 * One request for the whole card rather than one per account the client picks:
 * the card used to switch accounts with tabs, and reaching for a tab moved the
 * pointer off the hover card, which closed it. A stacked list needs every
 * account's windows up front.
 *
 * Accounts are read in parallel and each failure stays on its own row — a Codex
 * app-server that won't answer must not cost the Claude rows their numbers.
 */
async function overview(app: FastifyInstance, refresh: boolean): Promise<UsageOverview> {
  const settings = await app.cm.store.getSettings().catch(() => null);
  const installed = new Set(
    app.services.harnesses
      .list()
      .filter((h) => h.runtime().available)
      .map((h) => h.kind),
  );
  const accounts = subscriptionStatuses(settings).filter(
    (s) => s.loggedIn && installed.has(s.provider),
  );
  const subscriptions = await Promise.all(accounts.map((sub) => usageRow(app, sub, refresh)));
  return { fetchedAt: Date.now(), subscriptions };
}

export function registerUsageRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { refresh?: string } }>("/api/usage/subscriptions", async (req) =>
    overview(app, req.query.refresh === "1"),
  );

  app.get<{ Querystring: UsageQuery }>("/api/usage", async (req) =>
    snapshotFor(app, req.query, false),
  );

  app.post<{ Querystring: UsageQuery }>("/api/usage/refresh", async (req) =>
    snapshotFor(app, req.query, true),
  );

  /**
   * Spend one early reset on a named account. The account must be named: a
   * credit is not refundable, so "the provider's default" is too loose a target.
   * The provider decides eligibility (Codex keeps the credit and answers
   * `nothingToReset` below the cap) — the card's disabled button is a courtesy,
   * not the guard. The row is re-read fresh so the card shows the refill.
   */
  app.post<{ Querystring: { subscription?: string } }>("/api/usage/reset", async (req, reply) => {
    const settings = await app.cm.store.getSettings().catch(() => null);
    const sub = findSubscription(settings, req.query.subscription);
    if (!req.query.subscription || !sub) return reply.code(404).send({ error: "unknown account" });
    const harness = app.services.harnesses.find(sub.provider);
    if (!harness?.spendReset) {
      return reply.code(409).send({ error: "this provider's resets can only be spent from its own client" });
    }
    try {
      const outcome = await harness.spendReset(accountOf(sub));
      const result: ResetSpendResult = { outcome, usage: await usageRow(app, sub, true) };
      return result;
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : "reset failed" });
    }
  });
}
