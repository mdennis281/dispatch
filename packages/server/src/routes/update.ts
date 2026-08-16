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
import type { FastifyInstance } from "fastify";
import { UpdateChannelSchema } from "@dispatch/shared";
import { launchUpdate } from "../services/update-install.js";
import { payloadAppDir } from "../services/release.js";

/** Breathing room after the response is on the wire — mirrors shutdown.ts. */
const SETTLE_MS = 150;

export function registerUpdateRoutes(app: FastifyInstance): void {
  const { release } = app.services;

  app.get("/api/update", async () => release.status());

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
