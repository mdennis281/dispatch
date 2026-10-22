/**
 * REST for outbound webhook subscriptions.
 *
 *   GET    /api/webhooks                              → subscriptions (secret stripped)
 *   POST   /api/webhooks                              → create; the ONE response that carries the secret
 *   PUT    /api/webhooks/:id                          → partial update; echoes a rotated secret
 *   DELETE /api/webhooks/:id                          → remove the subscription and its delivery log
 *   POST   /api/webhooks/:id/test                     → fire a synthetic delivery, return it after attempt 1
 *   GET    /api/webhooks/:id/deliveries?limit         → newest-first delivery log
 *   POST   /api/webhooks/:id/deliveries/:d/redeliver  → send a settled delivery again
 *
 * The caller is read off `req.authIdentity`. A browser session may do
 * anything; an integration token (workstream B) needs `webhooks:manage`, is
 * bounded by its other scopes, and sees only subscriptions it created — all of
 * which `services/webhook-policy.ts` decides, so this file only maps errors.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WebhookError, callerFromIdentity } from "../services/webhook-policy.js";

export function registerWebhookRoutes(app: FastifyInstance): void {
  const { webhooks } = app.services;
  const caller = (req: FastifyRequest) => callerFromIdentity(req.authIdentity);
  const run = async <T>(reply: FastifyReply, fn: () => Promise<T> | T): Promise<T | FastifyReply> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof WebhookError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  };

  app.get("/api/webhooks", async (req) => webhooks.list(caller(req)));

  app.post("/api/webhooks", async (req, reply) =>
    run(reply, async () => {
      const sub = await webhooks.create(caller(req), req.body);
      return reply.code(201).send(sub);
    }),
  );

  app.put<{ Params: { id: string } }>("/api/webhooks/:id", async (req, reply) =>
    run(reply, () => webhooks.update(caller(req), req.params.id, req.body)),
  );

  app.delete<{ Params: { id: string } }>("/api/webhooks/:id", async (req, reply) =>
    run(reply, async () => {
      await webhooks.remove(caller(req), req.params.id);
      return reply.code(204).send();
    }),
  );

  app.post<{ Params: { id: string } }>("/api/webhooks/:id/test", async (req, reply) =>
    run(reply, () => webhooks.test(caller(req), req.params.id)),
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/webhooks/:id/deliveries",
    async (req, reply) =>
      run(reply, () => {
        const limit = Number(req.query.limit);
        return webhooks.deliveries(caller(req), req.params.id, Number.isFinite(limit) && limit > 0 ? limit : 100);
      }),
  );

  app.post<{ Params: { id: string; d: string } }>(
    "/api/webhooks/:id/deliveries/:d/redeliver",
    async (req, reply) => run(reply, () => webhooks.redeliver(caller(req), req.params.id, req.params.d)),
  );
}
