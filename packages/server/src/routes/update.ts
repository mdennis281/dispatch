/**
 * REST for the in-app release update.
 *   GET  /api/update          → UpdateStatus (cached; never hits the network)
 *   POST /api/update/check    → refresh from GitHub, then UpdateStatus
 *   PUT  /api/update/channel  → switch stable/unstable, then UpdateStatus
 *   POST /api/update/install  → { ok: true }, then the installer takes over
 *
 * `POST /api/update/install` is the only endpoint here with teeth, and it stays
 * deliberately narrow: the ONLY tag it will ever install is the head of the
 * subscribed channel, which the server resolved itself. A caller may now name
 * that tag explicitly — that is how the unstable → stable step-back works, since
 * a downgrade is by definition not `available` — but naming any OTHER tag is
 * refused, so this cannot be talked into fetching a build from somewhere else.
 * It also refuses on a payload that is not a release install (`supported:
 * false`) — there, the installer has nothing to replace.
 *
 * The response is flushed BEFORE the installer is launched, the same ordering
 * `routes/shutdown.ts` enforces for the same reason: the installer's first act
 * is to stop this server, and a caller that gets a dropped connection instead of
 * its `{ ok: true }` cannot tell "the update started" from "the update failed".
 */
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { UpdateChannelSchema, type UpdateProgress } from "@dispatch/shared";
import { launchUpdate } from "../services/update-install.js";
import { readUpdateProgress } from "../services/update-progress.js";
import { payloadAppDir } from "../services/release.js";

/** Breathing room after the response is on the wire — mirrors shutdown.ts. */
const SETTLE_MS = 150;

export function registerUpdateRoutes(app: FastifyInstance): void {
  const { release } = app.services;

  app.get("/api/update", async () => release.status());

  /**
   * How far the running install has got. Exempt from the auth gate
   * (`app.ts`) for the same reason `/api/health` is: it is polled by a screen
   * that has to keep working across the restart, and on the far side of that
   * restart the answer may be "your update failed and rolled back" — which is
   * precisely the moment you must not be bounced to a login form instead.
   *
   * Being exempt, it authenticates itself, and only to decide how much to say:
   * the phase is handed to anyone (it is a state machine position, and the
   * screen needs it before the auth store has even hydrated), while the log tail
   * carries filesystem paths and is withheld unless the caller proves it may
   * read them. The tab that started the update still holds its access token —
   * it no longer reloads mid-install — so in practice it sees the log.
   */
  app.get("/api/update/progress", async (req) => {
    let includeLog = true;
    if (await app.auth.enabled()) {
      const header = req.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
      includeLog = Boolean(await app.auth.authenticateAccess(token));
    }
    const progress = await readUpdateProgress({ root: resolve(payloadAppDir(), ".."), includeLog });

    // The stamp on disk is written by the installer launch, which happens after
    // this reply flushes plus SETTLE_MS. Between `markInstalling()` and that
    // write, the newest `update.json` is still the PREVIOUS install's — and
    // answering with its `done` would tell the screen the update it just started
    // had already succeeded. So an install this process launched outranks a
    // stamp that predates the launch.
    const since = release.installingSince();
    const stampedAt = progress.startedAt ? Date.parse(progress.startedAt) : NaN;
    if (since !== null && !(stampedAt >= since)) {
      return { inFlight: true, phase: "launching", tag: null, startedAt: null, failure: null,
        ...(includeLog ? { log: [] } : {}) } satisfies UpdateProgress;
    }

    // An install that fails BEFORE the stop — a bad download, a checksum
    // mismatch — leaves this server running with the latch still set, and
    // `status.installing` would then strand every tab on an update screen
    // waiting for a restart that is never coming, with no way out but a manual
    // restart. The log reaching a terminal phase is the authoritative signal
    // that nothing is in flight, so let it release the latch.
    if (!progress.inFlight) release.clearInstalling();
    return progress;
  });

  app.post("/api/update/check", async () => release.check(true));

  app.put("/api/update/channel", async (req, reply) => {
    const parsed = UpdateChannelSchema.safeParse(
      (req.body as { channel?: unknown } | undefined)?.channel,
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'channel must be "stable" or "unstable"' });
    }
    // Answers with the REFRESHED status, not the stale one: the switch is only
    // meaningful once the new channel's head is known, and a client that had to
    // fire its own follow-up check would render one frame of the old channel's
    // answer under the new channel's label.
    return release.setChannel(parsed.data);
  });

  app.post("/api/update/install", async (req, reply) => {
    const status = release.status();
    const requested = (req.body as { tag?: unknown } | undefined)?.tag;

    if (!status.supported) {
      reply.code(409);
      return {
        ok: false,
        error:
          "this Dispatch was not installed from a release, so it cannot update itself — " +
          "rebuild it from source instead",
      };
    }
    // An explicitly named tag is how a step-back is asked for, so it is checked
    // BEFORE `available` — a downgrade is never "available" by construction.
    // What it must be is the head of the channel you are actually subscribed to,
    // which is the whole of the trust boundary here.
    if (requested !== undefined) {
      if (typeof requested !== "string" || requested !== release.headTag()) {
        reply.code(409);
        return {
          ok: false,
          error: `only the head of the ${status.channel} channel can be installed`,
        };
      }
    } else if (!status.available || !status.latest) {
      reply.code(409);
      return { ok: false, error: "there is no newer release to install" };
    }
    if (status.installing) {
      reply.code(409);
      return { ok: false, error: "an update is already running" };
    }

    const tag = typeof requested === "string" ? requested : status.latest!.tag;
    // Latched before the reply, not after the spawn: two clicks that arrive
    // together would otherwise both pass the check above and start two
    // installers racing for the same `app/` rename.
    release.markInstalling();

    reply.raw.once("finish", () => {
      setTimeout(() => {
        void launchUpdate({ tag, appDir: payloadAppDir() }).catch((err: unknown) => {
          // The latch has to come off: nothing was spawned, so this server is
          // staying up, and leaving `installing: true` set would strand the UI
          // on a restart that is never coming with no way to retry but a
          // restart. A reloaded tab now sees the button again.
          release.clearInstalling();
          // Nothing left to tell the client directly — it is already polling
          // /api/health. The server log is the only place this can be said.
          console.error("[Dispatch] update install failed to launch:", err);
        });
      }, SETTLE_MS).unref?.();
    });

    return { ok: true, tag };
  });
}
