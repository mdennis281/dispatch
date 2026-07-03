/**
 * Server entrypoint. Boots one Fastify process that serves the SPA + REST +
 * the WebSocket event stream. Auth is the Claude subscription — no API key.
 */
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { seedDefaultsIfEmpty } from "./seed.js";

async function main(): Promise<void> {
  const app = await buildApp({ config });
  // Seed default modes/agents + the Hivebreak project on a fresh dataDir so the
  // live UI has content on first boot. No-op once anything exists.
  await seedDefaultsIfEmpty(app.cm.store).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("[claude-manager] seed skipped:", err);
  });
  await app.listen({ port: config.port, host: config.host });
  const url = `http://${config.host}:${config.port}`;
  // eslint-disable-next-line no-console
  console.log(`[claude-manager] listening on ${url}  (data: ${config.dataDir})`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[claude-manager] failed to start:", err);
  process.exit(1);
});
