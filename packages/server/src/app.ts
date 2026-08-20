/**
 * Fastify app factory. Wires the shared seam every service builds on:
 *   - @fastify/websocket   (the multiplexed event stream; routes added by the WS layer)
 *   - @fastify/static      (serves the built SPA at ../client/dist when present)
 *   - GET /api/health      (readiness probe — see health.ts)
 * The config, Store, and EventBus are decorated onto the instance as `app.cm`
 * so downstream route/service registrars share one wired context.
 */
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { config as defaultConfig, type ServerConfig } from "./config.js";
import { bus as defaultBus, type EventBus } from "./bus.js";
import { Store } from "./store/index.js";
import {
  createServices,
  type Services,
  type ServiceOverrides,
} from "./services/container.js";
import { registerRoutes } from "./routes/index.js";
import { healthReport } from "./health.js";
import { AuthService, type RequestIdentity } from "./services/auth.js";

/** Wired context shared across routes/services via `app.cm`. */
export interface CmContext {
  config: ServerConfig;
  store: Store;
  bus: EventBus;
}

declare module "fastify" {
  interface FastifyInstance {
    cm: CmContext;
    services: Services;
    auth: AuthService;
    /**
     * Begin a graceful shutdown. Decorated by `installShutdown`, which the
     * ENTRYPOINT wires — never `buildApp` — so it is genuinely absent in tests
     * and anywhere the app is built but not run. `POST /api/shutdown` refuses
     * rather than pretending when it's missing.
     */
    requestShutdown?: (reason: string) => Promise<void>;
  }
  interface FastifyRequest {
    authIdentity?: RequestIdentity;
  }
}

export interface BuildAppOptions {
  config?: ServerConfig;
  store?: Store;
  bus?: EventBus;
  /** Pre-built service container (tests inject fakes); built from ctx otherwise. */
  services?: Services;
  /** Per-service overrides used when `services` isn't supplied (tests inject fakes). */
  serviceOverrides?: ServiceOverrides;
  /** Override the client dist dir (defaults to ../client/dist relative to this file). */
  clientDist?: string;
  /** Dev mode: serve the SPA + HMR via Vite middleware on this same port. */
  dev?: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Build (but do not listen on) the Fastify app. */
export async function buildApp(
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = opts.config ?? defaultConfig;
  const store = opts.store ?? new Store(config.dataDir, config.configDir);
  const bus = opts.bus ?? defaultBus;

  await store.init();

  const services =
    opts.services ?? createServices({ config, store, bus }, opts.serviceOverrides);
  const auth = new AuthService(store);

  // Base64/data-URL image uploads (POST /api/chats/:id/assets) ride the JSON body,
  // so the body cap must clear the route's MAX_UPLOAD_BYTES (12 MiB) with headroom
  // for base64 (~+34%) + JSON wrapping. Fastify's 1 MiB default would 413 any
  // real screenshot/photo before the handler's own size check ever ran.
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  // Fastify's stock JSON parser answers a bodyless POST that still carries
  // `content-type: application/json` with FST_ERR_CTP_EMPTY_JSON_BODY (400)
  // before any handler runs. Browsers and fetch wrappers send exactly that, and
  // it silently broke every bodyless auth endpoint (TOTP setup, passkey
  // enrollment, invites, logout, disable). An empty body is simply no body.
  app.addContentTypeParser<string>("application/json", { parseAs: "string" }, (_req, body, done) => {
    // Strictly empty only — a whitespace-only payload is malformed JSON, and
    // trimming would copy every byte of a 16 MiB base64 image upload.
    if (body.length === 0) return done(null, undefined);
    try { done(null, JSON.parse(body) as unknown); }
    catch { done(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 })); }
  });

  app.decorate("cm", { config, store, bus } satisfies CmContext);
  app.decorate("services", services);
  app.decorate("auth", auth);

  // A single gate covers every current and future API route. Missing auth
  // settings resolve to disabled, preserving pre-auth installs byte-for-byte.
  app.addHook("onRequest", async (req, reply) => {
    if (!(await auth.enabled())) return;
    const path = req.url.split("?", 1)[0]!;
    // `/api/update/progress` is exempt for the same reason `/api/health` is: the
    // updating screen polls it across a restart, and it must answer during the
    // window where the tab has no live session to authenticate with. It gates
    // its own log tail on a bearer token — see routes/update.ts.
    if (path === "/api/health" || path === "/api/update/progress" ||
        path === "/api/auth/status" ||
        path === "/api/auth/login" || path === "/api/auth/refresh" ||
        path === "/api/auth/enable" || path === "/api/auth/setup/redeem" ||
        path === "/api/auth/passkeys/login/options" || path === "/api/auth/passkeys/login/verify" ||
        // The manager bridge has its own per-chat, ephemeral bearer grants. A
        // browser JWT cannot replace those without breaking tool isolation.
        path === "/api/mcp/manager") return;
    if (path === "/ws") {
      const ticket = new URL(req.url, "http://dispatch.local").searchParams.get("ticket") ?? undefined;
      const found = await auth.authenticateWs(ticket);
      if (!found) return reply.code(401).send({ error: "Authentication required." });
      req.authIdentity = found;
      return;
    }
    if (!path.startsWith("/api/")) return;
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const found = await auth.authenticateAccess(token);
    if (!found) return reply.code(401).send({ error: "Authentication required." });
    req.authIdentity = found;
  });

  await app.register(fastifyWebsocket);

  if (opts.dev) {
    // Dev: Vite runs in-process (middleware mode) so the SPA and HMR are served
    // from this same port. `/api` + `/ws` still resolve to their Fastify handlers.
    // Loaded dynamically so vite never enters the prod/test dependency graph.
    const { attachViteDev } = await import("./dev-vite.js");
    await attachViteDev(app);
  } else {
    const clientDist = opts.clientDist ?? resolve(here, "../../client/dist");
    if (existsSync(clientDist)) {
      await app.register(fastifyStatic, { root: clientDist });
    }
  }

  // 503 when degraded, so a caller that only looks at the status code (the
  // verify harness, any future load balancer) still gets the right answer
  // without parsing the body.
  app.get("/api/health", async (_req, reply) => {
    const report = await healthReport({
      store,
      dataDir: config.dataDir,
      ...(config.configDir ? { configDir: config.configDir } : {}),
      ...(opts.dev ? { dev: true } : {}),
      ...(opts.clientDist ? { clientDist: opts.clientDist } : {}),
    });
    return reply.code(report.ok ? 200 : 503).send(report);
  });

  registerRoutes(app);

  // Background wiring (attention aggregation, notifier, runner reconcile,
  // auto-checkpoint). Best-effort; a failure here must not stop the app booting.
  await services.start().catch(() => {});

  // Tear the service container down with the server, then release the state
  // database — services dispose FIRST because their teardown still writes (the
  // broker persists live session state, the terminal service flushes its
  // write-behind buffer), and a store closed underneath them would silently
  // reopen mid-shutdown.
  app.addHook("onClose", async () => {
    await auth.dispose().catch(() => {});
    await services.dispose().catch(() => {});
    store.close();
  });

  return app;
}
