/**
 * Dev-only glue: run Vite in *middleware mode* and mount it on the Fastify app so
 * the SPA, its ES modules, and HMR are all served from the API port. One process,
 * one URL (http://127.0.0.1:4319) — no separate client dev server, no second port.
 *
 * `/api` and `/ws` keep working because Vite's middleware calls next() for anything
 * it doesn't own, handing those requests back to Fastify's router. This module is
 * imported dynamically (only when buildApp is called with `dev: true`), so vite and
 * @fastify/middie never load in prod or in tests.
 */
import type { FastifyInstance } from "fastify";
import middie from "@fastify/middie";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
/** The @cm/client package root (…/packages/client), relative to …/packages/server/src. */
const clientRoot = resolve(here, "../../client");
const indexHtmlPath = resolve(clientRoot, "index.html");

export async function attachViteDev(app: FastifyInstance): Promise<void> {
  const vite = await createServer({
    root: clientRoot,
    configFile: resolve(clientRoot, "vite.config.ts"),
    appType: "custom", // we serve index.html ourselves via the SPA fallback below
    server: {
      middlewareMode: true,
      // HMR gets its own websocket port so it never collides with
      // @fastify/websocket's /ws upgrade handling. Invisible to the user.
      hmr: { port: 24678 },
    },
  });

  await app.register(middie);
  app.use(vite.middlewares);

  // SPA fallback: any GET that isn't /api, /ws, or a Vite-served asset gets the
  // transformed index.html, so client-side routes (and deep links) render.
  app.setNotFoundHandler(async (req, reply) => {
    const url = req.raw.url ?? "/";
    if (req.method !== "GET" || url.startsWith("/api") || url.startsWith("/ws")) {
      reply.code(404).send({ error: "Not found" });
      return;
    }
    try {
      const html = await vite.transformIndexHtml(url, await readFile(indexHtmlPath, "utf8"));
      reply.type("text/html").send(html);
    } catch (err) {
      vite.ssrFixStacktrace(err as Error);
      // eslint-disable-next-line no-console
      console.error("[claude-manager] vite index transform failed:", err);
      reply.code(500).send((err as Error).message);
    }
  });

  app.addHook("onClose", async () => {
    await vite.close();
  });
}
