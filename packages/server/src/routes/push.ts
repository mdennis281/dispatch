/**
 * REST for Web Push registration.
 *
 *   GET    /api/push/key         → { publicKey } — the VAPID key to subscribe against
 *   GET    /api/push/devices     → registered devices (endpoint hashed for display)
 *   POST   /api/push/subscribe   → { subscription, prefs?, label? }
 *   PUT    /api/push/prefs       → { endpoint, prefs } — retune one device's filters
 *   POST   /api/push/presence    → { endpoint, inFront } — "I'm looking at the app"
 *   POST   /api/push/test        → { endpoint } — send a sample push to one device
 *                                    (502 + the push service's own reason if it refused)
 *   POST   /api/push/unsubscribe → { endpoint }
 *
 * Filters live on the SERVER copy rather than being applied on the device: iOS
 * revokes a subscription whose push handler declines to show a notification, so
 * a muted event has to be one we never send. See services/push.ts.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { NotificationPrefsSchema } from "@dispatch/shared";
import { z } from "zod";
import { PushSubscriptionSchema } from "../services/push.js";

const SubscribeBody = z.object({
  subscription: PushSubscriptionSchema,
  prefs: NotificationPrefsSchema.optional(),
  label: z.string().max(80).optional(),
});

const PrefsBody = z.object({ endpoint: z.string().min(1), prefs: NotificationPrefsSchema });
const PresenceBody = z.object({ endpoint: z.string().min(1), inFront: z.boolean() });
const EndpointBody = z.object({ endpoint: z.string().min(1) });

/** A short stable id for display. The raw endpoint is a bearer capability — don't echo it. */
function fingerprint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 12);
}

export function registerPushRoutes(app: FastifyInstance): void {
  const { push } = app.services;

  app.get("/api/push/key", async () => ({ publicKey: await push.publicKey() }));

  app.get("/api/push/devices", async () => {
    const subs = await push.list();
    return subs.map((s) => ({
      id: fingerprint(s.subscription.endpoint),
      label: s.label,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  });

  app.post("/api/push/subscribe", async (req, reply) => {
    const parsed = SubscribeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid subscription" });
    const entry = await push.subscribe(parsed.data.subscription, parsed.data.prefs, parsed.data.label);
    return { id: fingerprint(entry.subscription.endpoint), prefs: entry.prefs };
  });

  app.put("/api/push/prefs", async (req, reply) => {
    const parsed = PrefsBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid prefs" });
    const ok = await push.setPrefs(parsed.data.endpoint, parsed.data.prefs);
    // 404 is the signal the client uses to re-subscribe: a registry that was
    // wiped (or a dev instance that never saw this device) must not leave the
    // phone believing it is registered when nothing will ever be sent to it.
    if (!ok) return reply.code(404).send({ error: "unknown subscription" });
    return { ok: true };
  });

  app.post("/api/push/presence", async (req, reply) => {
    const parsed = PresenceBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid presence" });
    await push.setPresence(parsed.data.endpoint, parsed.data.inFront);
    return { ok: true };
  });

  app.post("/api/push/test", async (req, reply) => {
    const parsed = EndpointBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid endpoint" });
    const result = await push.sendTest(parsed.data.endpoint);
    if (!result) return reply.code(404).send({ error: "unknown subscription" });
    // The one push whose outcome somebody is standing there waiting for. A 403
    // from Apple used to come back as `{ ok: true }`, so a device that could
    // never receive anything looked identical to one that just had. 502: the
    // failure is the upstream push service's, not the caller's.
    if (!result.ok) return reply.code(502).send({ error: result.error, statusCode: result.statusCode });
    return { ok: true };
  });

  app.post("/api/push/unsubscribe", async (req, reply) => {
    const parsed = EndpointBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid endpoint" });
    return { removed: await push.unsubscribe(parsed.data.endpoint) };
  });
}
