/**
 * REST for subscription usage (the header meter).
 *   GET  /api/usage          → latest UsageSnapshot (polls once if never fetched)
 *   POST /api/usage/refresh  → force a fresh fetch now (the "refresh" button)
 * The server polls this on a timer too and pushes `usage-update` over the bus;
 * these routes cover initial load + manual refresh.
 */
import type { FastifyInstance } from "fastify";
import { HarnessKindSchema, type UsageSnapshot } from "@dispatch/shared";

async function snapshotFor(app: FastifyInstance, raw: string | undefined): Promise<UsageSnapshot> {
  const parsed = HarnessKindSchema.safeParse(raw ?? "claude");
  const kind = parsed.success ? parsed.data : "claude";
  if (kind === "claude") return app.services.usage.get();
  const limits = await app.services.harnesses.find(kind)!.readLimits();
  const win = (value: { usedPercent?: number; resetsAt?: number } | null | undefined) =>
    value && typeof value.usedPercent === "number"
      ? { percent: value.usedPercent, resetsAt: value.resetsAt ?? null }
      : null;
  return {
    fiveHour: win(limits?.primary),
    sevenDay: win(limits?.secondary),
    fetchedAt: Date.now(),
    provider: kind,
    primaryLabel: limits?.primary?.windowMinutes
      ? `${limits.primary.windowMinutes}-minute window`
      : "Primary window",
    secondaryLabel: limits?.secondary?.windowMinutes
      ? `${limits.secondary.windowMinutes}-minute window`
      : "Secondary window",
    planType: limits?.planType,
    ...(limits ? {} : { stale: true, error: "unavailable" }),
  };
}

export function registerUsageRoutes(app: FastifyInstance): void {
  const { usage } = app.services;

  app.get<{ Querystring: { harness?: string } }>("/api/usage", async (req) =>
    snapshotFor(app, req.query.harness),
  );

  app.post<{ Querystring: { harness?: string } }>("/api/usage/refresh", async (req) => {
    const parsed = HarnessKindSchema.safeParse(req.query.harness ?? "claude");
    return parsed.success && parsed.data === "claude"
      ? usage.refresh()
      : snapshotFor(app, req.query.harness);
  });
}
