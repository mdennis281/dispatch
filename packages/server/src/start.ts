/**
 * Shared boot sequence for both entrypoints. Builds one Fastify process that
 * serves the SPA + REST + the WebSocket event stream, seeds defaults on a fresh
 * dataDir, and listens. `dev: true` mounts Vite middleware so the SPA + HMR are
 * served from this same port (see index.ts vs dev.ts).
 */
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { seedDefaultsIfEmpty } from "./seed.js";

export async function start({ dev = false }: { dev?: boolean } = {}): Promise<void> {
  const app = await buildApp({ config, dev });
  // Seed default modes/agents + the Hivebreak project on a fresh dataDir so the
  // live UI has content on first boot. No-op once anything exists.
  await seedDefaultsIfEmpty(app.cm.store).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("[claude-manager] seed skipped:", err);
  });
  await app.listen({ port: config.port, host: config.host });
  const url = `http://${config.host}:${config.port}`;
  // eslint-disable-next-line no-console
  console.log(
    `[claude-manager] listening on ${url}  (data: ${config.dataDir})` +
      (dev ? "  — SPA + HMR served here" : ""),
  );
}
