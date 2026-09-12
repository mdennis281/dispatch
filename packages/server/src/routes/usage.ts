/**
 * REST for subscription usage (the header meter).
 *   GET  /api/usage          → latest UsageSnapshot (polls once if never fetched)
 *   POST /api/usage/refresh  → force a fresh fetch now (the "refresh" button)
 * The server polls this on a timer too and pushes `usage-update` over the bus;
 * these routes cover initial load + manual refresh.
 */
import type { FastifyInstance } from "fastify";
import { HarnessKindSchema, type UsageSnapshot } from "@dispatch/shared";

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
    primaryLabel: windowLabel(limits?.primary?.windowMinutes, "Primary window"),
    secondaryLabel: windowLabel(limits?.secondary?.windowMinutes, "Secondary window"),
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
