/**
 * REST for the in-app release update.
 *   GET  /api/update          → UpdateStatus (cached; never hits the network)
 *   POST /api/update/check    → refresh from GitHub, then UpdateStatus
 *   POST /api/update/install  → { ok: true }, then the installer takes over
 *
 * `POST /api/update/install` is the only endpoint here with teeth, and it is
 * deliberately narrow: it will not install an arbitrary tag. The only thing it
 * can do is install the release the server itself has already resolved as newer,
 * so a caller cannot talk this into a downgrade or into fetching a tag from
 * somewhere else. It also refuses on a payload that is not a release install
 * (`supported: false`) — there, the installer has nothing to replace.
 *
 * The response is flushed BEFORE the installer is launched, the same ordering
 * `routes/shutdown.ts` enforces for the same reason: the installer's first act
 * is to stop this server, and a caller that gets a dropped connection instead of
 * its `{ ok: true }` cannot tell "the update started" from "the update failed".
 */
import type { FastifyInstance } from "fastify";
import { launchUpdate } from "../services/update-install.js";
import { payloadAppDir } from "../services/release.js";

/** Breathing room after the response is on the wire — mirrors shutdown.ts. */
const SETTLE_MS = 150;

export function registerUpdateRoutes(app: FastifyInstance): void {
  const { release } = app.services;

  app.get("/api/update", async () => release.status());

  app.post("/api/update/check", async () => release.check(true));

  app.post("/api/update/install", async (_req, reply) => {
    const status = release.status();

    if (!status.supported) {
      reply.code(409);
      return {
        ok: false,
        error:
          "this Dispatch was not installed from a release, so it cannot update itself — " +
          "rebuild it from source instead",
      };
    }
    if (!status.available || !status.latest) {
      reply.code(409);
      return { ok: false, error: "there is no newer release to install" };
    }
    if (status.installing) {
      reply.code(409);
      return { ok: false, error: "an update is already running" };
    }

    const tag = status.latest.tag;
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
