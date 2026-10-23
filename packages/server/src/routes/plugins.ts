/**
 * REST for the plugin host.
 *   GET  /api/plugins                  → PluginInfo[] (status, error, settings schema, client URL)
 *   PUT  /api/plugins/:id/enabled      → { enabled }  — targeted patch, not a settings-draft write
 *   PUT  /api/plugins/:id/settings     → { settings } — same
 *   POST /api/plugins/:id/reveal       → open the plugin directory on the HOST machine
 *   POST /api/plugins/inspect          → { url } → PluginInspection, read without running anything (owner only)
 *   POST /api/plugins/install          → { url, sha, replace? } → install exactly that sha (owner only)
 *   POST /api/plugins/:id/check-update → PluginUpdateCheck — resolve the recorded source, diff the target (owner only)
 *   POST /api/plugins/:id/update       → { sha } → install the checked target (owner only)
 *   GET  /api/plugins/:id/uninstall    → PluginUninstallPreview — what Uninstall would remove (owner only)
 *   POST /api/plugins/:id/uninstall    → { purge? } → PluginUninstallResult (owner only)
 *   *    /api/plugins/:id/*            → the plugin's own route table
 *
 * The wildcard is registered HERE, at build time, because Fastify cannot add a
 * route to a listening instance and plugins activate after listen. It is one
 * route for every plugin; `PluginService.handle` does the per-plugin lookup
 * and answers 503 while the plugin is activating, 404 when it is off.
 *
 * The static routes above it win over the wildcard for their exact paths
 * (find-my-way prefers static segments), which means a plugin cannot define
 * `PUT enabled`, `PUT settings`, `POST update` or `* uninstall` under its own
 * prefix. Acceptable: those names are the host's, and a plugin that wants them
 * has worse problems.
 */
import { spawn } from "node:child_process";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as z from "zod";
import {
  PluginInspectRequestSchema,
  PluginInstallRequestSchema,
  PluginUninstallRequestSchema,
  PluginUpdateRequestSchema,
} from "@dispatch/shared";
import { PluginLifecycleError, PluginNotFound } from "../plugins/service.js";
import { PluginInspectError } from "../plugins/inspect/index.js";

const EnabledBody = z.object({ enabled: z.boolean() });
const SettingsBody = z.object({ settings: z.record(z.string(), z.unknown()) });
const InstallBody = PluginInstallRequestSchema.extend({
  /** The owner confirmed replacing the installed copy ("Update to x.y.z"). */
  replace: z.boolean().optional(),
});

/**
 * Inspect and install are OWNER-only. Installing a plugin is installing code
 * that runs in-process with the server's privileges, and inspecting one makes
 * this server fetch from an arbitrary URL — neither belongs to an integration
 * token or a non-owner account. With auth off there is no identity and the
 * single local user is the owner, the same reading the plugin OAuth connect
 * route makes.
 */
function refuseNonOwner(req: FastifyRequest, reply: FastifyReply): FastifyReply | null {
  const who = req.authIdentity;
  if (!who) return null;
  if (who.kind !== "user") return reply.code(403).send({ error: "Integration tokens cannot install plugins." });
  if (!who.user.owner) return reply.code(403).send({ error: "Only the owner can install, update or remove plugins." });
  return null;
}

function inspectFailure(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof PluginInspectError || err instanceof PluginLifecycleError) {
    return reply.code(err.status).send({ error: err.message });
  }
  if (err instanceof PluginNotFound) return reply.code(404).send({ error: err.message });
  throw err;
}

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

  app.post("/api/plugins/inspect", async (req, reply) => {
    const refused = refuseNonOwner(req, reply);
    if (refused) return refused;
    const parsed = PluginInspectRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "url is required" });
    try {
      return await app.services.pluginInspector.inspect(parsed.data.url);
    } catch (err) {
      return inspectFailure(reply, err);
    }
  });

  app.post("/api/plugins/install", async (req, reply) => {
    const refused = refuseNonOwner(req, reply);
    if (refused) return refused;
    const parsed = InstallBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    try {
      const { url, sha, replace } = parsed.data;
      return await app.services.pluginInspector.install(url, sha, !!replace);
    } catch (err) {
      return inspectFailure(reply, err);
    }
  });

  // Owner-only for the same reason as inspect: a check makes this server
  // fetch from the recorded remote, and an update installs code.
  app.post<{ Params: { id: string } }>("/api/plugins/:id/check-update", async (req, reply) => {
    const refused = refuseNonOwner(req, reply);
    if (refused) return refused;
    try {
      return await app.services.pluginInspector.checkUpdate(req.params.id);
    } catch (err) {
      return inspectFailure(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/plugins/:id/update", async (req, reply) => {
    const refused = refuseNonOwner(req, reply);
    if (refused) return refused;
    const parsed = PluginUpdateRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    try {
      return await app.services.pluginInspector.update(req.params.id, parsed.data.sha);
    } catch (err) {
      return inspectFailure(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/api/plugins/:id/uninstall", async (req, reply) => {
    const refused = refuseNonOwner(req, reply);
    if (refused) return refused;
    try {
      return await plugins.uninstallPreview(req.params.id);
    } catch (err) {
      return inspectFailure(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/plugins/:id/uninstall", async (req, reply) => {
    const refused = refuseNonOwner(req, reply);
    if (refused) return refused;
    const parsed = PluginUninstallRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "purge must be a boolean" });
    try {
      return await plugins.uninstall(req.params.id, { purge: !!parsed.data.purge });
    } catch (err) {
      return inspectFailure(reply, err);
    }
  });

  app.all<{ Params: { id: string; "*": string } }>("/api/plugins/:id/*", async (req, reply) =>
    plugins.handle(req.params.id, req.params["*"] ?? "", req, reply),
  );
}
