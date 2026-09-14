/**
 * REST for subscription usage (the header meter).
 *   GET  /api/usage          → latest UsageSnapshot (polls once if never fetched)
 *   POST /api/usage/refresh  → force a fresh fetch now (the "refresh" button)
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
  subscriptionFor,
  type UsageSnapshot,
} from "@dispatch/shared";
import { accountOf } from "../services/subscriptions.js";

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

interface UsageQuery {
  harness?: string;
  subscription?: string;
}

/** The account a usage request is about. */
async function accountFor(app: FastifyInstance, query: UsageQuery) {
  const settings = await app.cm.store.getSettings().catch(() => null);
  const named = findSubscription(settings, query.subscription);
  const parsed = HarnessKindSchema.safeParse(query.harness ?? DEFAULT_HARNESS);
  const sub = named ?? subscriptionFor(settings, parsed.success ? parsed.data : DEFAULT_HARNESS);
  return { sub, account: accountOf(sub) };
}

async function snapshotFor(
  app: FastifyInstance,
  query: UsageQuery,
  refresh: boolean,
): Promise<UsageSnapshot> {
  const { sub, account } = await accountFor(app, query);
  const harness = app.services.harnesses.find(sub.provider)!;
  // A runtime that reports limits itself answers directly. One that doesn't
  // (Claude, on subscription auth) is read by the OAuth usage poller instead —
  // the one remaining provider-shaped branch here, because that endpoint has a
  // polling/429 discipline no `readLimits()` call could keep.
  if (!harness.capabilities.usageLimits) {
    const poller = app.services.accountUsage.for(account);
    return refresh ? poller.refresh() : poller.get();
  }
  const limits = await harness.readLimits(account);
  const win = (value: { usedPercent?: number; resetsAt?: number } | null | undefined) =>
    value && typeof value.usedPercent === "number"
      ? { percent: value.usedPercent, resetsAt: value.resetsAt ?? null }
      : null;
  return {
    fiveHour: win(limits?.primary),
    sevenDay: win(limits?.secondary),
    fetchedAt: Date.now(),
    provider: sub.provider,
    subscriptionId: sub.id,
    primaryLabel: windowLabel(limits?.primary?.windowMinutes, "Primary window"),
    secondaryLabel: windowLabel(limits?.secondary?.windowMinutes, "Secondary window"),
    planType: limits?.planType,
    ...(limits ? {} : { stale: true, error: "unavailable" }),
  };
}

export function registerUsageRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: UsageQuery }>("/api/usage", async (req) =>
    snapshotFor(app, req.query, false),
  );

  app.post<{ Querystring: UsageQuery }>("/api/usage/refresh", async (req) =>
    snapshotFor(app, req.query, true),
  );
}
