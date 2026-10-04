/**
 * REST for subscription usage (the header meter).
 *   GET  /api/usage          → latest UsageSnapshot (polls once if never fetched)
 *   POST /api/usage/refresh  → force a fresh fetch now (the "refresh" button)
 *   GET  /api/usage/subscriptions[?refresh=1] → every logged-in account's windows (the card)
 * Both take `?subscription=<id>` (whose windows) and/or `?harness=<provider>`
 * (that provider's default account when no subscription is named).
 * The server polls this on a timer too and pushes `usage-update` over the bus;
 * these routes cover initial load + manual refresh.
 */
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_HARNESS,
  HarnessKindSchema,
  findSubscription,
  accountLabel,
  subscriptionFor,
  usageWindowsOf,
  type SubscriptionUsage,
  type UsageOverview,
  type UsageSnapshot,
} from "@dispatch/shared";
import { subscriptionStatuses } from "../services/subscriptions.js";
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
  const parsed = HarnessKindSchema.safeParse(query.harness ?? DEFAULT_HARNESS);
  return named ?? subscriptionFor(settings, parsed.success ? parsed.data : DEFAULT_HARNESS);
}

async function snapshotFor(
  app: FastifyInstance,
  query: UsageQuery,
  refresh: boolean,
): Promise<UsageSnapshot> {
  const sub = await accountFor(app, query);
  const usage = await readAccountUsage(app.services, sub, refresh);
  return usage.snapshot;
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
  const subscriptions = await Promise.all(
    accounts.map(async (sub): Promise<SubscriptionUsage> => {
      const base = { subscriptionId: sub.id, name: accountLabel(sub), provider: sub.provider };
      try {
        const snap = await snapshotFor(app, { subscription: sub.id }, refresh);
        return {
          ...base,
          windows: usageWindowsOf(snap),
          fetchedAt: snap.fetchedAt,
          ...(snap.planType ? { planType: snap.planType } : {}),
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
    }),
  );
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
}
