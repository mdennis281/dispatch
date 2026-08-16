/**
 * REST for global app settings (config.json: theme, default mode, webhook).
 *   GET /api/settings   → AppSettings
 *   PUT /api/settings   → validate (full replace) + persist
 */
import type { FastifyInstance } from "fastify";
import { AppSettingsSchema } from "../store/index.js";

export function registerSettingsRoutes(app: FastifyInstance): void {
  const { store } = app.cm;

  app.get("/api/settings", async () => store.getSettings());

  app.put("/api/settings", async (req, reply) => {
    // PUT = full replace, NOT a shallow merge. The sole caller always sends a
    // complete AppSettings draft, so validating the body directly lets an omitted
    // optional actually clear (a merge stranded cleared fields — e.g. picking
    // "Auto (SDK default)" could never unset a previously-saved defaultModeId).
    // The schema still supplies the `theme` default for a sparse body.
    const parsed = AppSettingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    // Auth has its own transactional endpoints because toggling it also revokes
    // sessions. Older clients know nothing about the field and send a full PUT;
    // preserving it here prevents a routine preference save from disabling auth.
    //
    // `updateChannel` is preserved for exactly the same reason and it matters
    // more than it looks: the channel is owned by PUT /api/update/channel, so a
    // full-replace save from anywhere else in Settings — picking a theme — would
    // otherwise silently unsubscribe you from unstable back to stable.
    const current = await store.getSettings();
    return store.saveSettings({
      ...parsed.data,
      auth: current.auth,
      ...(current.updateChannel ? { updateChannel: current.updateChannel } : {}),
    });
  });
}
