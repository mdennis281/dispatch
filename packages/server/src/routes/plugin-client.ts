/**
 * `/plugins/<id>/*` — the public static mount for each plugin's CLIENT half.
 *
 * What it serves: the directory holding the manifest's `client` entry, and
 * nothing else of the plugin (`PluginService.clientRoot` decides the root and
 * refuses the plugin dir itself; the manifest schema refuses a layout that
 * puts the server module beside the client). See docs/plugins.md → "Client
 * host".
 *
 * NOT AUTH-GATED, BY CONSTRUCTION. The gate in app.ts covers `/api/` and `/ws`
 * only, so this prefix is as public as the SPA bundle — deliberately: a plugin's
 * client code is code, not data, and the browser loads it with a bare
 * `import()`, which can no more carry a bearer header than an `<img>` can. That
 * is exactly why the served directory must hold only what is meant to be
 * public, and why that is validated rather than documented.
 *
 * ONE wildcard rather than a `@fastify/static` registration per plugin,
 * because plugins are discovered in `services.start()` — after routes are
 * built — and Fastify cannot add a route to a listening instance. The handler
 * resolves the plugin per request, so a plugin toggled off stops being served
 * the moment `clientRoot` says so.
 */
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * The types a plugin bundle plausibly ships. Anything else is
 * `application/octet-stream`, which a browser will download rather than run —
 * fine for a file nobody asked the host to understand.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** Exported for the tests; pure. */
export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve `rest` inside `root`, or return undefined when it escapes.
 *
 * Two checks, because they catch different things. The LEXICAL one
 * (`resolve` + prefix) refuses `..` and absolute segments before anything
 * touches the disk. The REAL one (`realpath` on both sides) refuses a symlink
 * inside the client directory that points outside it — `cm plugin link`
 * junctions a whole working tree in, and a stray link in a build output is not
 * a reason to serve the owner's home directory. The root is realpath'd too,
 * because the plugin dir itself may be the junction.
 */
export async function resolveInside(root: string, rest: string): Promise<string | undefined> {
  const decoded = (() => {
    try {
      return decodeURIComponent(rest);
    } catch {
      return undefined;
    }
  })();
  if (decoded === undefined || decoded.includes("\0")) return undefined;
  const base = resolve(root);
  const target = resolve(base, decoded.replace(/^[\\/]+/, ""));
  if (target === base || !target.startsWith(base + sep)) return undefined;
  try {
    const [realBase, realTarget] = await Promise.all([realpath(base), realpath(target)]);
    if (!realTarget.startsWith(realBase + sep)) return undefined;
    return realTarget;
  } catch {
    return undefined; // does not exist, or unreadable — same answer either way
  }
}

export function registerPluginClientRoutes(app: FastifyInstance): void {
  const { plugins } = app.services;

  app.get<{ Params: { id: string; "*": string } }>("/plugins/:id/*", async (req, reply) => {
    const root = plugins.clientRoot(req.params.id);
    if (!root) return reply.code(404).send({ error: `no plugin "${req.params.id}" serves a client` });
    const file = await resolveInside(root, req.params["*"] ?? "");
    if (!file) return reply.code(404).send({ error: "not found" });
    const info = await stat(file).catch(() => undefined);
    // A directory is never listed: the entry module is named by the manifest
    // and the SPA already knows it, so there is nothing an index would add
    // except a map of the bundle.
    if (!info?.isFile()) return reply.code(404).send({ error: "not found" });
    return reply
      .header("content-type", contentTypeFor(file))
      .header("content-length", String(info.size))
      // `no-cache`, not `immutable`: the URL is the manifest's path, which is
      // stable across rebuilds of the plugin, so a long max-age would pin a
      // tab to the bundle it first loaded until the cache was cleared by hand.
      // Revalidation is one conditional request per load; the bytes stream
      // only when they changed.
      .header("cache-control", "no-cache")
      .header("x-content-type-options", "nosniff")
      .send(createReadStream(file));
  });
}
