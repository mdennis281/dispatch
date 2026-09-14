/**
 * REST for the composer's model picker and the provider/account lists.
 *   GET /api/models                          → ModelOption[]  (cached ~5min)
 *   GET /api/models?refresh=1                → ModelOption[]  (re-probe the runtime now)
 *   GET /api/models?subscription=<id>        → that ACCOUNT's list
 *   GET /api/harnesses                       → registered providers + capabilities
 *   GET /api/subscriptions                   → every account, with login presence
 *   PUT /api/subscriptions                   → replace the stored account list
 *
 * Models are live from each runtime's own list, which works on subscription auth
 * with no API key. See services/models.ts.
 */
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_HARNESS,
  HarnessKindSchema,
  SubscriptionListSchema,
  findSubscription,
  subscriptionFor,
} from "@dispatch/shared";
import { accountOf, subscriptionStatuses } from "../services/subscriptions.js";

export function registerModelRoutes(app: FastifyInstance): void {
  const { store } = app.cm;

  app.get<{ Querystring: { refresh?: string; harness?: string; subscription?: string } }>(
    "/api/models",
    async (req) => {
      const settings = await store.getSettings().catch(() => null);
      const parsed = HarnessKindSchema.safeParse(req.query.harness ?? DEFAULT_HARNESS);
      const kind = parsed.success ? parsed.data : DEFAULT_HARNESS;
      // A named account wins, but only on ITS provider: `?harness=codex&subscription=claude2`
      // is a stale client, and answering it with Claude's catalogue would put a
      // Claude id in a Codex picker.
      const named = findSubscription(settings, req.query.subscription);
      const sub = named?.provider === kind ? named : subscriptionFor(settings, kind);
      const harness = app.services.harnesses.find(kind)!;
      return harness.listModels({ refresh: req.query.refresh === "1", account: accountOf(sub) });
    },
  );

  app.get("/api/harnesses", async () =>
    app.services.harnesses.list().map((harness) => ({
      kind: harness.kind,
      runtime: harness.runtime(),
      capabilities: harness.capabilities,
    })),
  );

  app.get("/api/subscriptions", async () =>
    subscriptionStatuses(await store.getSettings().catch(() => null)),
  );

  /**
   * Replace the stored list. Its own route rather than a field of the settings
   * PUT, which preserves `subscriptions` by hand: the settings pane round-trips
   * a whole draft, and a draft loaded before an account was added would
   * otherwise delete it on the next theme change.
   *
   * Removing an account that chats are pinned to is allowed — those chats fall
   * back to their provider's default account (see `subscriptionFor`). Refusing
   * would make a deleted login directory impossible to clean up after.
   */
  app.put("/api/subscriptions", async (req, reply) => {
    const parsed = SubscriptionListSchema.safeParse(
      (req.body as { subscriptions?: unknown } | null)?.subscriptions,
    );
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const current = await store.getSettings();
    const saved = await store.saveSettings({ ...current, subscriptions: parsed.data });
    return subscriptionStatuses(saved);
  });
}
