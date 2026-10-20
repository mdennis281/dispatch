/**
 * REST for Web Push registration.
 *
 *   GET    /api/push/key         → { publicKey } — the VAPID key to subscribe against
 *   GET    /api/push/devices     → registered devices (endpoint hashed for display)
 *   DELETE /api/push/devices/:id → forget one device, by that hash
 *   POST   /api/push/subscribe   → { subscription, prefs?, label?, deviceId?, replaces? }
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
  /** The device's own stable id — see `StoredSubscription.deviceId`. */
  deviceId: z.string().min(1).max(64).optional(),
  /** The endpoint this subscription supersedes, when the caller knows it. */
  replaces: z.string().min(1).optional(),
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

  // By fingerprint, because the endpoint is a bearer capability and Settings
  // only ever sees the hash. This is how a stale registration gets removed from a
  // device that can't name it: after a reinstall the phone has a new id and no
  // memory of its old endpoint, so the server can't tell the two apart on its own.
  app.delete<{ Params: { id: string } }>("/api/push/devices/:id", async (req, reply) => {
    const target = (await push.list()).find((s) => fingerprint(s.subscription.endpoint) === req.params.id);
    if (!target) return reply.code(404).send({ error: "unknown device" });
    return { removed: await push.unsubscribe(target.subscription.endpoint) };
  });

  app.post("/api/push/subscribe", async (req, reply) => {
    const parsed = SubscribeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid subscription" });
    const { subscription, prefs, label, deviceId, replaces } = parsed.data;
    const entry = await push.subscribe(subscription, prefs, label, { deviceId, replaces });
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
