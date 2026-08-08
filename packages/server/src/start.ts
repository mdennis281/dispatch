/**
 * Shared boot sequence for both entrypoints. Builds one Fastify process that
 * serves the SPA + REST + the WebSocket event stream, seeds defaults on a fresh
 * dataDir, and listens. `dev: true` mounts Vite middleware so the SPA + HMR are
 * served from this same port (see index.ts vs dev.ts).
 */
import { networkInterfaces } from "node:os";
import { buildApp } from "./app.js";
import { config, envVar } from "./config.js";
import { seedDefaultsIfEmpty } from "./seed.js";
import { installShutdown } from "./shutdown.js";
import { installCrashNet, attachCrashBus } from "./crash-log.js";
import { claudeRuntime } from "./services/runtime.js";

/** Wildcard binds that answer on every interface — print real addresses instead. */
const WILDCARD = new Set(["0.0.0.0", "::", "::0"]);

/**
 * The URL a human should actually open on THIS machine. Never the bind host: a
 * wildcard bind prints `http://0.0.0.0:4318`, which is not an address you can
 * browse to, and — more importantly — `localhost` is the only origin Chromium
 * treats as secure over plain HTTP, so it's the one that gets the service
 * worker, the install prompt and notifications.
 */
function localUrl(): string {
  const host = WILDCARD.has(config.host) ? "127.0.0.1" : config.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${config.port}`;
}

/** Non-loopback IPv4 addresses this box answers on, for the "open it on your phone" line. */
function lanUrls(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${config.port}`);
    }
  }
  return out;
}

export async function start({ dev = false }: { dev?: boolean } = {}): Promise<void> {
  // FIRST, before anything can reject: a stray unhandled rejection used to kill
  // the whole process (and every live session with it) leaving no record at all.
  // See crash-log.ts for the 2026-08-07 double crash this was written for.
  installCrashNet({ dataDir: config.dataDir });

  const app = await buildApp({ config, dev });
  // The net had to go up before buildApp(), so this is the earliest the bus can
  // exist to bind. Without it the net's publish is a permanent no-op and a
  // survived crash is visible only in crash.log — never in the UI.
  attachCrashBus(app.cm.bus);
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
  const url = localUrl();
  // eslint-disable-next-line no-console
  console.log(
    `[dispatch] listening on ${url}  (data: ${config.dataDir}` +
      (config.configDir ? `, config: ${config.configDir}` : "") +
      `)` +
      (dev ? "  — SPA + HMR served here" : ""),
  );
  if (WILDCARD.has(config.host)) {
    const lan = lanUrls();
    // eslint-disable-next-line no-console
    console.log(
      lan.length > 0
        ? `[dispatch] host mode — also reachable at ${lan.join(", ")}  (no auth: trust the network, or set DISPATCH_HOST=127.0.0.1)`
        : `[dispatch] host mode — bound to every interface, but this box has no non-loopback IPv4 address`,
    );
  }
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
