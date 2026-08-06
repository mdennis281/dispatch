/**
 * Shared boot sequence for both entrypoints. Builds one Fastify process that
 * serves the SPA + REST + the WebSocket event stream, seeds defaults on a fresh
 * dataDir, and listens. `dev: true` mounts Vite middleware so the SPA + HMR are
 * served from this same port (see index.ts vs dev.ts).
 */
import { buildApp } from "./app.js";
import { config, envVar } from "./config.js";
import { seedDefaultsIfEmpty } from "./seed.js";
import { installShutdown } from "./shutdown.js";
import { claudeRuntime } from "./services/runtime.js";

export async function start({ dev = false }: { dev?: boolean } = {}): Promise<void> {
  const app = await buildApp({ config, dev });
  // Seed default modes/agents + the Hivebreak project on a fresh dataDir so the
  // live UI has content on first boot. No-op once anything exists.
  await seedDefaultsIfEmpty(app.cm.store).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("[dispatch] seed skipped:", err);
  });
  // Wire teardown BEFORE listening, so a signal arriving during boot still runs
  // `services.dispose()` instead of orphaning whatever already started.
  installShutdown(app);

  await app.listen({ port: config.port, host: config.host });
  const url = `http://${config.host}:${config.port}`;
  // eslint-disable-next-line no-console
  console.log(
    `[dispatch] listening on ${url}  (data: ${config.dataDir}` +
      (config.configDir ? `, config: ${config.configDir}` : "") +
      `)` +
      (dev ? "  — SPA + HMR served here" : ""),
  );
  // Which `claude` binary every session runs on. Worth a line: it decides which
  // models the picker can offer, so "why is Opus 5 missing" is answered here.
  // eslint-disable-next-line no-console
  console.log(
    `[dispatch] claude runtime ${claudeRuntime.version ?? "unknown"} (${claudeRuntime.source})` +
      (claudeRuntime.path ? ` — ${claudeRuntime.path}` : ""),
  );
  // The desktop shell waits for this exact line before showing its window.
  if (envVar(process.env, "IPC") === "1") {
    // eslint-disable-next-line no-console
    console.log(`[dispatch] ready ${url}`);
    // A shell installed BEFORE the rename matches only the old prefix, and
    // `desktop:publish` swaps the payload without touching the shell. Emit the
    // legacy line too so that pairing still boots. Safe to delete once the shell
    // has been reinstalled (`pnpm desktop:install-shell`).
    // eslint-disable-next-line no-console
    console.log(`[claude-manager] ready ${url}`);
  }
}
