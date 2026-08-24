/**
 * REST for global app settings (config.json: theme, default mode, webhook).
 *   GET /api/settings          → AppSettings
 *   PUT /api/settings          → validate (full replace) + persist
 *   GET /api/settings/defaults → the server-side defaults a field must NAME
 */
import type { FastifyInstance } from "fastify";
import { AppSettingsSchema } from "../store/index.js";

export function registerSettingsRoutes(app: FastifyInstance): void {
  const { store, config } = app.cm;
  const { broker } = app.services;

  app.get("/api/settings", async () => store.getSettings());

  /**
   * What a CLEARED optional setting falls back to — a fact about how this server
   * was started, not a stored preference.
   *
   * `maxActiveSessions` is the case that forced this. The setting is optional and
   * a blank box means "whatever this server was started with", which is
   * `DISPATCH_MAX_ACTIVE_SESSIONS` when one is set and only otherwise the shared
   * constant. The field printed the constant, so an install running the env var at
   * 12 was told `blank = 6` — the one place the feature misreported its own state.
   *
   * Deliberately NOT folded into `GET /api/settings`: that body round-trips
   * straight back into the full-replace PUT above, so a server fact mixed into it
   * becomes a field the client sends back as though it owned it.
   */
  app.get("/api/settings/defaults", async () => ({
    maxActiveSessions: config.maxActiveSessions,
    idleSessionMinutes: config.idleSessionMinutes,
  }));

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
    const saved = await store.saveSettings({
      ...parsed.data,
      auth: current.auth,
      ...(current.updateChannel ? { updateChannel: current.updateChannel } : {}),
      // And `setup`, for the third time and the same reason. It is owned by
      // POST /api/setup/complete, and no client sends it — so a full-replace
      // save from Settings would drop it, which on the next load reads as "this
      // install has never been set up" and puts the wizard back over a working
      // app. Changing your theme must not un-install you.
      ...(current.setup ? { setup: current.setup } : {}),
    });
    // The concurrency cap is held by the LIVE broker, not re-read per turn, so a
    // save has to hand it over or the new number means nothing until a restart —
    // and raising it drains whatever is already parked in `queued`. Off the
    // saved object rather than `parsed.data` so it can never disagree with what
    // was written (the preserved-field spread above sits between the two).
    broker.setCap(saved.maxActiveSessions);
    // Same reason: the idle window lives on the live broker's sweep timer.
    broker.setIdleTimeout(saved.idleSessionMinutes);
    return saved;
  });
}
