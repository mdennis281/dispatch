/**
 * REST for the homepage.
 *
 *   GET /api/home?window=24h|7d|30d[&force=1] → HomeOverview
 *
 * ONE endpoint, deliberately — see `services/home.ts` for why the page is a
 * single request and what it refuses to put behind it. GET rather than POST
 * because there is no filter to encode: the only input is a window width from
 * a fixed set of three, and a flag.
 *
 * `force` bypasses the cache and WAITS for the recompute. It is the Reload
 * button, and it is a separate flag rather than the default because every
 * other caller wants the opposite — see `HomeService.overview`. Still a GET:
 * it recomputes a cache, it does not change anything a second call would see
 * differently.
 */
import type { FastifyInstance } from "fastify";
import { HomeWindowSchema } from "@dispatch/shared";

export function registerHomeRoutes(app: FastifyInstance): void {
  const { home } = app.services;

  app.get<{ Querystring: { window?: string; force?: string } }>(
    "/api/home",
    async (req, reply) => {
      const parsed = HomeWindowSchema.safeParse(req.query.window ?? "7d");
      if (!parsed.success) return reply.code(400).send({ error: "unknown window" });
      return home.overview(parsed.data, { force: req.query.force === "1" });
    },
  );
}
