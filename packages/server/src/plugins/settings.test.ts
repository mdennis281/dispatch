/**
 * Plugin settings as a WRITE surface (E4): the plugin's own `ctx.settings.set`,
 * the merge-patch route the form and `host.settings` use, schema validation
 * that never blocks on a key the write left alone, and the other instance's
 * write reaching this one. Real app, real config dir — the shared config.json
 * is the thing under test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { PluginInfo, WsServerEvent } from "@dispatch/shared";
import { buildApp } from "../app.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close().catch(() => {})));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string" },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    // The plugin's own settings section owns this one; the generic form skips it.
    hosts: {
      type: "array",
      readOnly: true,
      items: {
        type: "object",
        required: ["id", "address"],
        properties: { id: { type: "string", pattern: "^[a-z0-9-]+$" }, address: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
};

/** Stores what its route is given, and records every `onChange`. */
const KEEPER_SERVER = `
export function activate(ctx) {
  const seen = [];
  ctx.settings.onChange((next) => seen.push(next));
  ctx.routes((r) => {
    r.post("/store", async (req, reply) => {
      try {
        return { stored: await ctx.settings.set(req.body) };
      } catch (err) {
        reply.code(400);
        return { error: err.message };
      }
    });
    r.get("/seen", async () => ({ seen, now: ctx.settings.get() }));
  });
}
`;

async function configRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "dispatch-plugin-settings-"));
  dirs.push(base);
  const configDir = join(base, "config");
  const dir = join(configDir, "plugins", "keeper");
  await mkdir(join(dir, "server"), { recursive: true });
  await writeFile(
    join(dir, "plugin.yaml"),
    "id: keeper\nname: Keeper\nversion: 1.0.0\ndispatch: '>=1'\nserver: ./server/index.js\nsettings: ./settings.schema.json\ncapabilities: [routes]\n",
  );
  await writeFile(join(dir, "settings.schema.json"), JSON.stringify(SCHEMA));
  await writeFile(join(dir, "server", "index.js"), KEEPER_SERVER);
  return configDir;
}

/** One Dispatch instance over `configDir` with its OWN data dir — as stable and dev are. */
async function instance(configDir: string) {
  const dataDir = await mkdtemp(join(tmpdir(), "dispatch-plugin-settings-data-"));
  dirs.push(dataDir);
  const bus = new EventBus();
  const events: Extract<WsServerEvent, { type: "plugin-settings" }>[] = [];
  bus.on("plugin-settings", (e) => events.push(e));
  const app = await buildApp({
    store: new Store(dataDir, configDir),
    bus,
    config: { port: 0, host: "127.0.0.1", dataDir, configDir, maxActiveSessions: 1, idleSessionMinutes: 30 },
  });
  apps.push(app);
  await app.services.plugins.activateAll();
  const call = async <T = unknown>(method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.json() as T };
  };
  const row = () => app.services.plugins.get("keeper") as PluginInfo;
  const seen = async () => (await call<{ seen: unknown[]; now: Record<string, unknown> }>("GET", "/api/plugins/keeper/seen")).body;
  return { app, events, call, row, seen };
}

const MAC = { id: "cvx-mac", address: "10.0.10.16" };

describe("ctx.settings.set and PATCH", () => {
  it("lets a plugin store a key the form cannot render, and a form save of another key keeps it", async () => {
    const a = await instance(await configRoot());
    const stored = await a.call<{ stored: Record<string, unknown> }>("POST", "/api/plugins/keeper/store", { hosts: [MAC] });
    expect(stored).toEqual({ status: 200, body: { stored: { hosts: [MAC] } } });
    expect(a.events.at(-1)).toEqual({ type: "plugin-settings", plugin: "keeper", settings: { hosts: [MAC] } });

    // The form saves only what the owner touched.
    const form = await a.call<PluginInfo>("PATCH", "/api/plugins/keeper/settings", { patch: { label: "garage", port: 22 } });
    expect(form.status).toBe(200);
    expect(form.body.settings).toEqual({ hosts: [MAC], label: "garage", port: 22 });
    // null removes a key; the rest stay.
    expect((await a.call<PluginInfo>("PATCH", "/api/plugins/keeper/settings", { patch: { port: null } })).body.settings).toEqual({
      hosts: [MAC],
      label: "garage",
    });

    // The plugin heard every change, and a write that changes nothing is not one.
    await a.call("POST", "/api/plugins/keeper/store", { hosts: [MAC] });
    const s = await a.seen();
    expect(s.seen).toEqual([{ hosts: [MAC] }, { hosts: [MAC], label: "garage", port: 22 }, { hosts: [MAC], label: "garage" }]);
    expect(s.now).toEqual({ hosts: [MAC], label: "garage" });
  });

  it("refuses a write that makes a key invalid, from the plugin or the route, and stores nothing", async () => {
    const a = await instance(await configRoot());
    await a.call("POST", "/api/plugins/keeper/store", { hosts: [MAC] });

    const bad = await a.call<{ error: string }>("POST", "/api/plugins/keeper/store", { hosts: [{ id: "Bad Id" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/hosts\.0\.id/);
    expect(bad.body.error).toMatch(/hosts\.0\.address/);

    const route = await a.call<{ error: string; errors: string[] }>("PATCH", "/api/plugins/keeper/settings", { patch: { port: 70000 } });
    expect(route.status).toBe(400);
    expect(route.body.errors).toEqual([expect.stringMatching(/^port: /)]);
    const put = await a.call("PUT", "/api/plugins/keeper/settings", { settings: { hosts: [MAC], port: "x" } });
    expect(put.status).toBe(400);

    expect(a.row().settings).toEqual({ hosts: [MAC] });
    expect((await a.seen()).seen).toHaveLength(1);
  });

  it("reports a value stored before the schema said otherwise, and never refuses a write that leaves it alone", async () => {
    const configDir = await configRoot();
    await writeFile(join(configDir, "config.json"), JSON.stringify({ plugins: { keeper: { settings: { port: "eighty" } } } }));
    const a = await instance(configDir);
    expect(a.row().settingsErrors).toEqual([expect.stringMatching(/^port: /)]);

    expect((await a.call("PATCH", "/api/plugins/keeper/settings", { patch: { label: "ok" } })).status).toBe(200);
    // The whole-blob PUT carries the bad value back unchanged — still fine.
    expect((await a.call("PUT", "/api/plugins/keeper/settings", { settings: { port: "eighty", label: "ok2" } })).status).toBe(200);
    // Changing it to something else invalid is not.
    expect((await a.call("PATCH", "/api/plugins/keeper/settings", { patch: { port: "ninety" } })).status).toBe(400);

    const fixed = await a.call<PluginInfo>("PATCH", "/api/plugins/keeper/settings", { patch: { port: 8080 } });
    expect(fixed.body.settings).toEqual({ port: 8080, label: "ok2" });
    expect(fixed.body.settingsErrors).toBeUndefined();
  });

  it("does not enforce a schema it cannot compile, and says so on the row", async () => {
    const configDir = await configRoot();
    await writeFile(
      join(configDir, "plugins", "keeper", "settings.schema.json"),
      JSON.stringify({ type: "object", properties: { a: { const: 1 } }, if: { properties: { a: { const: 1 } } }, then: { required: ["b"] } }),
    );
    const a = await instance(configDir);
    expect(a.row().warnings?.join("\n")).toMatch(/settings schema is not enforced/);
    expect((await a.call("PATCH", "/api/plugins/keeper/settings", { patch: { a: "anything" } })).status).toBe(200);
  });
});

describe("two instances sharing config/", () => {
  it("the other instance's write reaches this one's ctx.settings.get, onChange and clients", async () => {
    const configDir = await configRoot();
    const stable = await instance(configDir);
    const dev = await instance(configDir);

    // Dev pairs a machine.
    await dev.call("POST", "/api/plugins/keeper/store", { hosts: [MAC] });
    // Stable's cache is stale until it reconciles — what the watcher triggers.
    expect((await stable.seen()).now).toEqual({});
    await stable.app.services.plugins.reconcileSettings();
    expect(await stable.seen()).toEqual({ seen: [{ hosts: [MAC] }], now: { hosts: [MAC] } });
    expect(stable.events).toEqual([{ type: "plugin-settings", plugin: "keeper", settings: { hosts: [MAC] } }]);
    // Its own write, reconciled again, is not a second change.
    await stable.app.services.plugins.reconcileSettings();
    expect(stable.events).toHaveLength(1);

    // And without anyone calling reconcile: the config.json watcher started at boot.
    await dev.call("PATCH", "/api/plugins/keeper/settings", { patch: { label: "dev-wrote-this" } });
    await vi.waitFor(async () => expect((await stable.seen()).now).toEqual({ hosts: [MAC], label: "dev-wrote-this" }), {
      timeout: 15_000,
      interval: 250,
    });
  }, 30_000);
});
