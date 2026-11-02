/**
 * REST for plugin catalogs (plugin-catalog.ts) — Settings → Plugins' browse list.
 *   GET    /api/plugin-catalogs                       → PluginCatalogsStatus, from cache (installed state is live)
 *   POST   /api/plugin-catalogs                       → { url, label? } → read it, then add it (owner only)
 *   POST   /api/plugin-catalogs/refresh               → re-read every enabled catalog (owner only)
 *   POST   /api/plugin-catalogs/:id/refresh           → re-read one (owner only)
 *   PUT    /api/plugin-catalogs/:id/enabled           → { enabled } (owner only)
 *   DELETE /api/plugin-catalogs/:id                   → remove an added catalog; the built-in one is refused (owner only)
 *   GET    /api/plugin-catalogs/:id/plugin?subdir=…   → one member's full PluginInspection (owner only)
 *
 * Its own prefix, not `/api/plugins/catalogs`: everything under
 * `/api/plugins/:id/*` is a plugin's own route table, and a plugin with the id
 * `catalogs` would be shadowed by — or shadow — these.
 *
 * Owner-only for the reasons inspect is: a refresh makes this server fetch
 * from whatever URL the list holds, and the list decides what code is offered
 * for install. Reading it is owner-only too, since member reports describe
 * what is installed here.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as z from "zod";
import { PluginCatalogAddRequestSchema, PluginCatalogEnabledRequestSchema } from "@dispatch/shared";
import { PluginInspectError } from "../plugins/inspect/index.js";

const MemberQuery = z.object({ subdir: z.string().max(1024).default("") });

function refuseNonOwner(req: FastifyRequest, reply: FastifyReply): FastifyReply | null {
  const who = req.authIdentity;
  if (!who) return null;
  if (who.kind !== "user") return reply.code(403).send({ error: "Integration tokens cannot manage plugin catalogs." });
  if (!who.user.owner) return reply.code(403).send({ error: "Only the owner can manage plugin catalogs." });
  return null;
}

function failure(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof PluginInspectError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

export function registerPluginCatalogRoutes(app: FastifyInstance): void {
  const catalogs = () => app.services.pluginCatalogs;

  app.get("/api/plugin-catalogs", async (req, reply) => {
    const refused = refuseNonOwner(req, reply);
    if (refused) return refused;
    return catalogs().status();
  });

  app.post("/api/plugin-catalogs", async (req, reply) => {
    const refused = refuseNonOwner(req, reply);
    if (refused) return refused;
    const parsed = PluginCatalogAddRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "url is required" });
    try {
      return await catalogs().add(parsed.data.url, parsed.data.label);
    } catch (err) {
      return failure(reply, err);
    }
  });

  app.post("/api/plugin-catalogs/refresh", async (req, reply) => {
    const refused = refuseNonOwner(req, reply);
    if (refused) return refused;
    return catalogs().refreshAll();
  });

  app.post<{ Params: { id: string } }>("/api/plugin-catalogs/:id/refresh", async (req, reply) => {
    const refused = refuseNonOwner(req, reply);
    if (refused) return refused;
    try {
      return await catalogs().refresh(req.params.id);
    } catch (err) {
      return failure(reply, err);
    }
  });

  app.put<{ Params: { id: string } }>("/api/plugin-catalogs/:id/enabled", async (req, reply) => {
    const refused = refuseNonOwner(req, reply);
    if (refused) return refused;
    const parsed = PluginCatalogEnabledRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "enabled must be a boolean" });
    try {
      return await catalogs().setEnabled(req.params.id, parsed.data.enabled);
    } catch (err) {
      return failure(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/plugin-catalogs/:id", async (req, reply) => {
    const refused = refuseNonOwner(req, reply);
    if (refused) return refused;
    try {
      await catalogs().remove(req.params.id);
      return { ok: true };
    } catch (err) {
      return failure(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/api/plugin-catalogs/:id/plugin", async (req, reply) => {
    const refused = refuseNonOwner(req, reply);
    if (refused) return refused;
    const parsed = MemberQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "subdir must be a string" });
    try {
      return await catalogs().member(req.params.id, parsed.data.subdir);
    } catch (err) {
      return failure(reply, err);
    }
  });
}
