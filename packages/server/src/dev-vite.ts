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
import { createServer, type InlineConfig } from "vite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
/** The @dispatch/client package root (…/packages/client), relative to …/packages/server/src. */
const clientRoot = resolve(here, "../../client");
const indexHtmlPath = resolve(clientRoot, "index.html");

/**
 * Load the client's vite config OURSELVES and return it as an inline config so
 * `createServer` can be called with `configFile: false`.
 *
 * WHY (Windows dev loop): if we hand Vite the config PATH, it bundles the config
 * into a temp file under the client's `node_modules/.vite-temp/` dir on every
 * start, imports it, then unlinks it. Under `tsx watch` that temp file enters the
 * watched module graph, and its unlink kicks a server RESTART — which re-bundles a
 * new temp file, which unlinks… an endless restart loop. The tsx client-dir ignore
 * glob can't stop it: on Windows the event path is a backslash relative path
 * (`..\client\…`) that no forward-slash glob matches. Importing the config
 * directly keeps every watched file stable, so there is no loop.
 */
async function loadClientConfig(): Promise<InlineConfig> {
  const url = pathToFileURL(resolve(clientRoot, "vite.config.ts")).href;
  const mod = (await import(url)) as { default?: unknown };
  const raw = mod.default;
  const resolved =
    typeof raw === "function"
      ? await (raw as (env: { command: "serve"; mode: string }) => unknown)({
          command: "serve",
          mode: "development",
        })
      : raw;
  return (resolved ?? {}) as InlineConfig;
}

export async function attachViteDev(app: FastifyInstance): Promise<void> {
  const clientConfig = await loadClientConfig();
  const vite = await createServer({
    ...clientConfig,
    // Config is provided INLINE above — never let Vite load/bundle the file (see
    // loadClientConfig for the tsx-watch restart loop this avoids).
    configFile: false,
    root: clientRoot,
    appType: "custom", // we serve index.html ourselves via the SPA fallback below
    server: {
      ...(clientConfig.server ?? {}),
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
      console.error("[Dispatch] vite index transform failed:", err);
      reply.code(500).send((err as Error).message);
    }
  });

  app.addHook("onClose", async () => {
    await vite.close();
  });
}
