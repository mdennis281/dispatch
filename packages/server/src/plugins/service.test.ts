/**
 * The plugin host, end to end: a real Fastify app over a temp config root
 * holding `examples/plugins/hello-server`, plus hand-written broken plugins.
 * Discovery, enablement, activation isolation, kv, route prefixing, settings
 * preservation, the `plugin-event`, and deactivation.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { PluginInfo, WsServerEvent } from "@dispatch/shared";
import { buildApp } from "../app.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { PluginService } from "./service.js";

const here = dirname(fileURLToPath(import.meta.url));
const HELLO = resolve(here, "../../../../examples/plugins/hello-server");

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close().catch(() => {})));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function root(): Promise<{ configDir: string; dataDir: string }> {
  const base = await mkdtemp(join(tmpdir(), "dispatch-plugins-"));
  dirs.push(base);
  const configDir = join(base, "config");
  const dataDir = join(base, "data");
  await mkdir(join(configDir, "plugins"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  return { configDir, dataDir };
}

async function installHello(configDir: string): Promise<void> {
  await cp(HELLO, join(configDir, "plugins", "hello-server"), { recursive: true });
}

/** A plugin dir written from strings — for the failure cases. */
async function writePlugin(
  configDir: string,
  id: string,
  manifest: string,
  server?: string,
): Promise<void> {
  const dir = join(configDir, "plugins", id);
  await mkdir(join(dir, "server"), { recursive: true });
  await writeFile(join(dir, "plugin.yaml"), manifest);
  if (server !== undefined) await writeFile(join(dir, "server", "index.js"), server);
}

async function app(opts: { configDir: string; dataDir: string; bus?: EventBus; activateBudgetMs?: number; fault?: (k: string, e: unknown) => void }) {
  const store = new Store(opts.dataDir, opts.configDir);
  const bus = opts.bus ?? new EventBus();
  const instance = await buildApp({
    store,
    bus,
    config: {
      port: 0,
      host: "127.0.0.1",
      dataDir: opts.dataDir,
      configDir: opts.configDir,
      maxActiveSessions: 1,
      idleSessionMinutes: 30,
    },
    serviceOverrides:
      opts.activateBudgetMs || opts.fault
        ? {
            // Built the way the container builds it, with the knobs this test needs.
            plugins: undefined,
          }
        : undefined,
  });
  apps.push(instance);
  return { instance, store, bus, plugins: instance.services.plugins };
}

const list = async (instance: FastifyInstance): Promise<PluginInfo[]> =>
  (await instance.inject({ url: "/api/plugins" })).json() as PluginInfo[];

describe("discovery", () => {
  it("lists a valid plugin, skips a manifest-less directory, and reports a broken one as invalid", async () => {
    const r = await root();
    await installHello(r.configDir);
    await mkdir(join(r.configDir, "plugins", "not-a-plugin", "sub"), { recursive: true });
    await writePlugin(r.configDir, "broken", "id: broken\nname: [unclosed\n");
    await writePlugin(r.configDir, "mismatch", "id: other\nname: X\nversion: 1.0.0\ndispatch: '>=1'\n");
    await writePlugin(r.configDir, "future", "id: future\nname: F\nversion: 1.0.0\ndispatch: '>=99'\n");
    await writePlugin(r.configDir, "escapes", "id: escapes\nname: E\nversion: 1.0.0\ndispatch: '>=1'\nserver: ../../x.js\n");
    const { instance } = await app(r);
    const rows = await list(instance);
    expect(rows.map((p) => [p.id, p.status])).toEqual([
      ["broken", "invalid"],
      ["escapes", "invalid"],
      ["future", "incompatible"],
      ["hello-server", "active"],
      ["mismatch", "invalid"],
    ]);
    expect(rows.find((p) => p.id === "broken")!.error).toMatch(/YAML/);
    expect(rows.find((p) => p.id === "mismatch")!.error).toMatch(/does not match its directory/);
    expect(rows.find((p) => p.id === "future")!.error).toMatch(/plugin API/);
    const hello = rows.find((p) => p.id === "hello-server")!;
    expect(hello).toMatchObject({
      name: "Hello (server)",
      version: "0.1.0",
      enabled: true,
      hasServer: true,
      capabilities: ["events", "routes", "kv"],
      settings: {},
    });
    expect((hello.settingsSchema as { properties: Record<string, unknown> }).properties).toHaveProperty("greeting");
    expect(hello.dir).toBe(join(r.configDir, "plugins", "hello-server"));
  });
});

describe("activation", () => {
  it("answers 503 on the prefix before activation and 200 after", async () => {
    const r = await root();
    await installHello(r.configDir);
    const { instance, plugins } = await app(r);
    // `buildApp` only discovers; `warm()` activates. Between the two the
    // prefix must say "not yet", not "not found".
    const early = await instance.inject({ url: "/api/plugins/hello-server/hello" });
    expect(early.statusCode).toBe(503);
    await plugins.activateAll();
    const res = await instance.inject({ url: "/api/plugins/hello-server/hello" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ greeting: "hello", tone: "friendly", seen: 0 });
  });

  it("isolates a throwing activate: the plugin is `error`, its sibling is active, the fault is filed", async () => {
    const r = await root();
    await installHello(r.configDir);
    await writePlugin(
      r.configDir,
      "boom",
      "id: boom\nname: Boom\nversion: 1.0.0\ndispatch: '>=1'\nserver: ./server/index.js\ncapabilities: [events]\n",
      "export async function activate(ctx) { ctx.bus.on('chat-status', () => {}); throw new Error('kaboom at activate'); }\n",
    );
    const fault = vi.fn();
    const { instance, plugins } = await app(r);
    (plugins as unknown as { fault: typeof fault }).fault = fault;
    await plugins.activateAll();
    const rows = await list(instance);
    expect(rows.find((p) => p.id === "boom")).toMatchObject({ status: "error", error: "kaboom at activate" });
    expect(rows.find((p) => p.id === "hello-server")!.status).toBe("active");
    expect(fault).toHaveBeenCalledWith(expect.stringContaining('"boom"'), expect.any(Error));
    // Whatever it registered before throwing is gone with it.
    expect((await instance.inject({ url: "/api/plugins/boom/anything" })).statusCode).toBe(404);
  });

  it("marks a plugin that runs past its budget as `error` and moves on", async () => {
    const r = await root();
    await writePlugin(
      r.configDir,
      "slow",
      "id: slow\nname: Slow\nversion: 1.0.0\ndispatch: '>=1'\nserver: ./server/index.js\n",
      "export function activate() { return new Promise(() => {}); }\n",
    );
    await installHello(r.configDir);
    const store = new Store(r.dataDir, r.configDir);
    await store.init();
    const svc = new PluginService({
      configDir: r.configDir,
      store,
      context: stubContext(),
      activateBudgetMs: 50,
      fault: () => {},
      log: () => {},
    });
    await svc.load();
    await svc.activateAll();
    expect(svc.get("slow")).toMatchObject({ status: "error", error: expect.stringMatching(/did not finish within/) });
    expect(svc.get("hello-server")!.status).toBe("active");
    await svc.dispose();
    store.close();
  });

  it("reports a module without activate() as `error`", async () => {
    const r = await root();
    await writePlugin(
      r.configDir,
      "empty",
      "id: empty\nname: Empty\nversion: 1.0.0\ndispatch: '>=1'\nserver: ./server/index.js\n",
      "export const nothing = 1;\n",
    );
    const { plugins } = await app(r);
    await plugins.activateAll();
    expect(plugins.get("empty")).toMatchObject({ status: "error", error: expect.stringMatching(/does not export activate/) });
  });
});

describe("enablement", () => {
  it("does not activate a plugin whose stored toggle is off, and its prefix answers 404", async () => {
    const r = await root();
    await installHello(r.configDir);
    await writeFile(
      join(r.configDir, "config.json"),
      JSON.stringify({ theme: "dark", plugins: { "hello-server": { enabled: false } } }),
    );
    const { instance, plugins } = await app(r);
    await plugins.activateAll();
    expect(plugins.get("hello-server")).toMatchObject({ status: "disabled", enabled: false });
    expect((await instance.inject({ url: "/api/plugins/hello-server/hello" })).statusCode).toBe(404);
  });

  it("toggling off deactivates now and drops the plugin's bus listener; toggling on says restart", async () => {
    const r = await root();
    await installHello(r.configDir);
    const { instance, plugins, bus } = await app(r);
    await plugins.activateAll();
    const seen = async () =>
      ((await instance.inject({ url: "/api/plugins/hello-server/hello" })).json() as { seen: number }).seen;
    bus.publish(msg("c1"));
    await flush();
    expect(await seen()).toBe(1);

    const off = await instance.inject({ method: "PUT", url: "/api/plugins/hello-server/enabled", payload: { enabled: false } });
    expect(off.json()).toMatchObject({ status: "disabled", enabled: false });
    expect((await instance.inject({ url: "/api/plugins/hello-server/hello" })).statusCode).toBe(404);
    bus.publish(msg("c2"));
    await flush();

    const on = await instance.inject({ method: "PUT", url: "/api/plugins/hello-server/enabled", payload: { enabled: true } });
    expect(on.json()).toMatchObject({ status: "disabled", enabled: true, needsRestart: true });
    expect((await instance.inject({ url: "/api/settings" })).json().plugins).toEqual({ "hello-server": { enabled: true } });

    // The count did not move while off: the listener was really gone. Proven
    // on a fresh service over the same store, since the route is off too.
    const svc = new PluginService({ configDir: r.configDir, store: instance.cm.store, context: stubContext(), log: () => {} });
    await svc.load();
    await svc.activateAll();
    const req = { method: "GET" } as never;
    const reply = fakeReply();
    const body = (await svc.handle("hello-server", "hello", req, reply)) as { seen: number };
    expect(body.seen).toBe(1);
    await svc.dispose();
  });

  it("404s a toggle for a plugin that does not exist", async () => {
    const r = await root();
    const { instance } = await app(r);
    const res = await instance.inject({ method: "PUT", url: "/api/plugins/nope/enabled", payload: { enabled: false } });
    expect(res.statusCode).toBe(404);
  });
});

describe("routes", () => {
  it("serves the plugin's table under its prefix, with :params and a JSON body, and 404s the rest", async () => {
    const r = await root();
    await installHello(r.configDir);
    const { instance, plugins } = await app(r);
    await plugins.activateAll();
    expect((await instance.inject({ url: "/api/plugins/hello-server/chats/abc123" })).json()).toEqual({ chatId: "abc123" });
    const echo = await instance.inject({ method: "POST", url: "/api/plugins/hello-server/echo", payload: { a: 1 } });
    expect(echo.json()).toEqual({ echoed: { a: 1 } });
    expect((await instance.inject({ url: "/api/plugins/hello-server/nothing-here" })).statusCode).toBe(404);
    expect((await instance.inject({ method: "DELETE", url: "/api/plugins/hello-server/hello" })).statusCode).toBe(404);
    expect((await instance.inject({ url: "/api/plugins/unknown/hello" })).statusCode).toBe(404);
  });

  it("is behind the global auth gate like everything under /api/", async () => {
    const r = await root();
    await installHello(r.configDir);
    const { instance, plugins, store } = await app(r);
    await plugins.activateAll();
    await store.updateSettings((s) => ({ ...s, auth: { enabled: true, firstRunDismissed: true } }));
    const res = await instance.inject({ url: "/api/plugins/hello-server/hello" });
    expect(res.statusCode).toBe(401);
  });
});

describe("settings", () => {
  it("a plugin's settings survive a full-replace PUT /api/settings and reach the plugin live", async () => {
    const r = await root();
    await installHello(r.configDir);
    const { instance, plugins } = await app(r);
    await plugins.activateAll();
    const put = await instance.inject({
      method: "PUT",
      url: "/api/plugins/hello-server/settings",
      payload: { settings: { greeting: "hey", shout: true, repeat: 2 } },
    });
    expect(put.json()).toMatchObject({ settings: { greeting: "hey", shout: true, repeat: 2 } });
    // The theme change — a draft that knows nothing about plugins.
    await instance.inject({ method: "PUT", url: "/api/settings", payload: { theme: "light" } });
    const settings = (await instance.inject({ url: "/api/settings" })).json();
    expect(settings.theme).toBe("light");
    expect(settings.plugins).toEqual({ "hello-server": { settings: { greeting: "hey", shout: true, repeat: 2 } } });
    // And the route reads the new value without a restart.
    expect((await instance.inject({ url: "/api/plugins/hello-server/hello" })).json().greeting).toBe("HEY HEY");
  });

  it("rejects a non-object settings body", async () => {
    const r = await root();
    await installHello(r.configDir);
    const { instance } = await app(r);
    const res = await instance.inject({ method: "PUT", url: "/api/plugins/hello-server/settings", payload: { settings: "x" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("kv and events", () => {
  it("persists kv across a restart of the host, and counts bus events while active", async () => {
    const r = await root();
    await installHello(r.configDir);
    const bus = new EventBus();
    const first = await app({ ...r, bus });
    await first.plugins.activateAll();
    bus.publish(msg("c1"));
    bus.publish(msg("c2"));
    await flush();
    expect((await first.instance.inject({ url: "/api/plugins/hello-server/hello" })).json().seen).toBe(2);
    await first.instance.close();
    apps.splice(apps.indexOf(first.instance), 1);

    const second = await app({ ...r, bus: new EventBus() });
    await second.plugins.activateAll();
    expect((await second.instance.inject({ url: "/api/plugins/hello-server/hello" })).json().seen).toBe(2);
  });

  it("publishes the plugin-event the plugin emits", async () => {
    const r = await root();
    await installHello(r.configDir);
    const bus = new EventBus();
    const events: WsServerEvent[] = [];
    bus.on("plugin-event", (e) => events.push(e));
    const { plugins } = await app({ ...r, bus });
    await plugins.activateAll();
    expect(events).toEqual([{ type: "plugin-event", plugin: "hello-server", payload: { hello: true, version: "0.1.0" } }]);
  });
});

/* ----------------------------------------------------------------- helpers */

function msg(chatId: string): WsServerEvent {
  return {
    type: "chat-message",
    chatId,
    message: { id: `m-${chatId}`, chatId, ts: 1, kind: "user", text: "hi" },
  } as WsServerEvent;
}

const flush = () => new Promise((r) => setTimeout(r, 20));

/** Context deps for a service driven without an app: nothing the hello plugin touches. */
function stubContext(): ConstructorParameters<typeof PluginService>[0]["context"] {
  const bus = new EventBus();
  const never = () => {
    throw new Error("not in this test");
  };
  return {
    bus,
    secrets: { list: async () => [], resolve: () => undefined } as never,
    inspect: { findChats: never, readChat: never } as never,
    memory: { recall: never, write: never, delete: never } as never,
    attention: { list: () => [], get: () => undefined } as never,
    messenger: { send: never, ask: never, reply: never, state: never, targetOf: () => undefined } as never,
    broker: { answerQuestion: () => false, declineQuestion: () => false },
  };
}

function fakeReply() {
  const reply = {
    statusCode: 200,
    code(n: number) {
      reply.statusCode = n;
      return reply;
    },
    header() {
      return reply;
    },
    send(body: unknown) {
      return body;
    },
  };
  return reply as never;
}
