/**
 * REST for the plugin host.
 *   GET  /api/plugins                  → PluginInfo[] (status, error, settings schema, client URL)
 *   PUT  /api/plugins/:id/enabled      → { enabled }  — targeted patch, not a settings-draft write
 *   PUT  /api/plugins/:id/settings     → { settings } — same
 *   POST /api/plugins/:id/reveal       → open the plugin directory on the HOST machine
 *   *    /api/plugins/:id/*            → the plugin's own route table
 *
 * The wildcard is registered HERE, at build time, because Fastify cannot add a
 * route to a listening instance and plugins activate after listen. It is one
 * route for every plugin; `PluginService.handle` does the per-plugin lookup
 * and answers 503 while the plugin is activating, 404 when it is off.
 *
 * The three static routes above it win over the wildcard for their exact
 * paths (find-my-way prefers static segments), which means a plugin cannot
 * define `PUT enabled` or `PUT settings` under its own prefix. Acceptable: both
 * names are the host's, and a plugin that wants them has worse problems.
 */
import { spawn } from "node:child_process";
import type { FastifyInstance } from "fastify";
import * as z from "zod";
import { PluginNotFound } from "../plugins/service.js";

const EnabledBody = z.object({ enabled: z.boolean() });
const SettingsBody = z.object({ settings: z.record(z.string(), z.unknown()) });

/**
 * Open a directory in the host OS's file manager. Fire-and-forget: the
 * process is detached and its exit is nobody's concern. This opens a window
 * on the machine Dispatch RUNS on, which is the owner's own box — the one
 * place a plugin directory exists.
 */
function revealDirectory(dir: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["explorer.exe", [dir]]
      : process.platform === "darwin"
        ? ["open", [dir]]
        : ["xdg-open", [dir]];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

export function registerPluginRoutes(app: FastifyInstance): void {
  const { plugins } = app.services;

  app.get("/api/plugins", async () => plugins.list());

  app.put<{ Params: { id: string } }>("/api/plugins/:id/enabled", async (req, reply) => {
    const parsed = EnabledBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      return await plugins.setEnabled(req.params.id, parsed.data.enabled);
    } catch (err) {
      if (err instanceof PluginNotFound) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  app.put<{ Params: { id: string } }>("/api/plugins/:id/settings", async (req, reply) => {
    const parsed = SettingsBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      return await plugins.setSettings(req.params.id, parsed.data.settings);
    } catch (err) {
      if (err instanceof PluginNotFound) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/api/plugins/:id/reveal", async (req, reply) => {
    const info = plugins.get(req.params.id);
    if (!info) return reply.code(404).send({ error: `no plugin "${req.params.id}"` });
    revealDirectory(info.dir);
    return { ok: true, dir: info.dir };
  });

  app.all<{ Params: { id: string; "*": string } }>("/api/plugins/:id/*", async (req, reply) =>
    plugins.handle(req.params.id, req.params["*"] ?? "", req, reply),
  );
}
