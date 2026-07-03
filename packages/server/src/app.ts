/**
 * Fastify app factory. Wires the shared seam every service builds on:
 *   - @fastify/websocket   (the multiplexed event stream; routes added by the WS layer)
 *   - @fastify/static      (serves the built SPA at ../client/dist when present)
 *   - GET /api/health      (placeholder liveness probe)
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
}

const here = dirname(fileURLToPath(import.meta.url));

/** Build (but do not listen on) the Fastify app. */
export async function buildApp(
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = opts.config ?? defaultConfig;
  const store = opts.store ?? new Store(config.dataDir);
  const bus = opts.bus ?? defaultBus;

  await store.init();

  const services =
    opts.services ?? createServices({ config, store, bus }, opts.serviceOverrides);

  // Base64/data-URL image uploads (POST /api/chats/:id/assets) ride the JSON body,
  // so the body cap must clear the route's MAX_UPLOAD_BYTES (12 MiB) with headroom
  // for base64 (~+34%) + JSON wrapping. Fastify's 1 MiB default would 413 any
  // real screenshot/photo before the handler's own size check ever ran.
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  app.decorate("cm", { config, store, bus } satisfies CmContext);
  app.decorate("services", services);

  await app.register(fastifyWebsocket);

  const clientDist = opts.clientDist ?? resolve(here, "../../client/dist");
  if (existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist });
  }

  app.get("/api/health", async () => ({ ok: true }));

  registerRoutes(app);

  // Background wiring (attention aggregation, notifier, runner reconcile,
  // auto-checkpoint). Best-effort; a failure here must not stop the app booting.
  await services.start().catch(() => {});

  // Tear the service container down with the server.
  app.addHook("onClose", async () => {
    await services.dispose().catch(() => {});
  });

  return app;
}
