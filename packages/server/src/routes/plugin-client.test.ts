/**
 * The public plugin-client mount (`/plugins/<id>/*`) and the `chat.ext` merge
 * on `PUT /api/chats/:id` — the two server seams the client host relies on.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { PluginInfo, WsServerEvent } from "@dispatch/shared";
import { buildApp } from "../app.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { contentTypeFor, resolveInside } from "./plugin-client.js";

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close().catch(() => {})));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function root(): Promise<{ configDir: string; dataDir: string }> {
  const base = await mkdtemp(join(tmpdir(), "dispatch-plugin-client-"));
  dirs.push(base);
  const configDir = join(base, "config");
  const dataDir = join(base, "data");
  await mkdir(join(configDir, "plugins"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  return { configDir, dataDir };
}

const ID = "slotty";

/** A plugin with a client directory holding two files, a server module beside it, and the manifest at the root. */
async function installSlotty(configDir: string, manifestExtra = ""): Promise<string> {
  const dir = join(configDir, "plugins", ID);
  await mkdir(join(dir, "client"), { recursive: true });
  await mkdir(join(dir, "server"), { recursive: true });
  await writeFile(
    join(dir, "plugin.yaml"),
    `id: ${ID}\nname: Slotty\nversion: 1.0.0\ndispatch: ">=1"\nclient: ./client/index.js\nserver: ./server/index.js\ncapabilities: [ui]\n${manifestExtra}`,
  );
  await writeFile(join(dir, "client", "index.js"), "export function activate(host) { host.toast('hi'); }\n");
  await writeFile(join(dir, "client", "style.css"), ".x{}\n");
  await writeFile(join(dir, "server", "index.js"), "export async function activate() {}\n");
  return dir;
}

async function app(opts: { configDir: string; dataDir: string; bus?: EventBus }) {
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
  });
  apps.push(instance);
  return { instance, store, bus, plugins: instance.services.plugins };
}

describe("resolveInside", () => {
  it("refuses lexical escapes before touching the disk, and a missing file after", async () => {
    const base = await mkdtemp(join(tmpdir(), "dispatch-inside-"));
    dirs.push(base);
    await writeFile(join(base, "a.js"), "1");
    expect(await resolveInside(base, "a.js")).toBeTruthy();
    expect(await resolveInside(base, "../a.js")).toBeUndefined();
    expect(await resolveInside(base, "%2e%2e/a.js")).toBeUndefined();
    expect(await resolveInside(base, "")).toBeUndefined();
    expect(await resolveInside(base, "nope.js")).toBeUndefined();
    expect(await resolveInside(base, "a.js\0")).toBeUndefined();
  });

  it("names the types a bundle ships and falls back to octet-stream", () => {
    expect(contentTypeFor("x/index.js")).toMatch(/^text\/javascript/);
    expect(contentTypeFor("x/a.css")).toMatch(/^text\/css/);
    expect(contentTypeFor("x/a.wasm")).toBe("application/wasm");
    expect(contentTypeFor("x/a.bin")).toBe("application/octet-stream");
  });
});

describe("GET /plugins/:id/*", () => {
  it("serves the client directory with content types and a short cache, and nothing above it", async () => {
    const r = await root();
    await installSlotty(r.configDir);
    const { instance } = await app(r);
    const js = await instance.inject({ url: `/plugins/${ID}/index.js` });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(js.headers["cache-control"]).toBe("no-cache");
    expect(js.body).toContain("export function activate");
    const css = await instance.inject({ url: `/plugins/${ID}/style.css` });
    expect(css.headers["content-type"]).toMatch(/^text\/css/);
    // The manifest, the server module and the directory itself are never served.
    expect((await instance.inject({ url: `/plugins/${ID}/../plugin.yaml` })).statusCode).toBe(404);
    expect((await instance.inject({ url: `/plugins/${ID}/..%2Fplugin.yaml` })).statusCode).toBe(404);
    expect((await instance.inject({ url: `/plugins/${ID}/../server/index.js` })).statusCode).toBe(404);
    expect((await instance.inject({ url: `/plugins/${ID}/` })).statusCode).toBe(404);
    expect((await instance.inject({ url: `/plugins/${ID}/missing.js` })).statusCode).toBe(404);
    expect((await instance.inject({ url: "/plugins/nobody/index.js" })).statusCode).toBe(404);
  });

  it("lists the entry module's URL on the plugin row, and stops serving when the plugin is toggled off", async () => {
    const r = await root();
    await installSlotty(r.configDir);
    const { instance, plugins } = await app(r);
    const rows = (await instance.inject({ url: "/api/plugins" })).json() as PluginInfo[];
    expect(rows.find((p) => p.id === ID)?.clientUrl).toBe(`/plugins/${ID}/index.js`);
    await plugins.setEnabled(ID, false);
    expect((await instance.inject({ url: `/plugins/${ID}/index.js` })).statusCode).toBe(404);
  });

  it("is NOT behind the auth gate — a bare import() cannot carry a bearer", async () => {
    const r = await root();
    await installSlotty(r.configDir);
    const { instance, store } = await app(r);
    await store.updateSettings((s) => ({ ...s, auth: { enabled: true, firstRunDismissed: true } }));
    expect((await instance.inject({ url: `/plugins/${ID}/index.js` })).statusCode).toBe(200);
    // …while the plugin's API prefix still is.
    expect((await instance.inject({ url: `/api/plugins/${ID}/x` })).statusCode).toBe(401);
  });

  it("never publishes a plugin whose manifest put the client at the root", async () => {
    const r = await root();
    const dir = join(r.configDir, "plugins", "rooty");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "plugin.yaml"), 'id: rooty\nname: R\nversion: 1.0.0\ndispatch: ">=1"\nclient: ./index.js\n');
    await writeFile(join(dir, "index.js"), "export function activate() {}\n");
    const { instance, plugins } = await app(r);
    expect(plugins.get("rooty")?.status).toBe("invalid");
    expect(plugins.clientRoot("rooty")).toBeUndefined();
    expect((await instance.inject({ url: "/plugins/rooty/index.js" })).statusCode).toBe(404);
    expect((await instance.inject({ url: "/plugins/rooty/plugin.yaml" })).statusCode).toBe(404);
  });
});

describe("PUT /api/chats/:id — ext", () => {
  async function chat(instance: FastifyInstance, repoPath: string): Promise<string> {
    const project = await instance.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "P", repoPath, worktreeRoot: "wt" },
    });
    expect(project.statusCode).toBe(201);
    const created = await instance.inject({
      method: "POST",
      url: "/api/chats",
      payload: { projectId: project.json().id },
    });
    expect(created.statusCode).toBe(201);
    return created.json().id as string;
  }

  it("merges per plugin key, clears a key with null, and carries the row on chat-update", async () => {
    const r = await root();
    const bus = new EventBus();
    const updates: WsServerEvent[] = [];
    bus.on("chat-update", (e) => updates.push(e));
    const { instance } = await app({ ...r, bus });
    const id = await chat(instance, r.dataDir);
    const put = (ext: unknown) => instance.inject({ method: "PUT", url: `/api/chats/${id}`, payload: { ext } });

    expect((await put({ voice: { mode: "on" } })).json().ext).toEqual({ voice: { mode: "on" } });
    // A second plugin's write leaves the first's key alone.
    expect((await put({ hello: { count: 1 } })).json().ext).toEqual({ voice: { mode: "on" }, hello: { count: 1 } });
    // A key's value is replaced, not deep-merged — the slice is the plugin's own.
    expect((await put({ hello: { count: 2 } })).json().ext).toEqual({ voice: { mode: "on" }, hello: { count: 2 } });
    expect((await put({ voice: null })).json().ext).toEqual({ hello: { count: 2 } });
    expect((await put(null)).json().ext).toBeUndefined();
    expect((await put("nope")).statusCode).toBe(400);

    const last = updates.filter((u) => u.type === "chat-update").at(-2);
    expect(last && last.type === "chat-update" ? last.chat.ext : null).toEqual({ hello: { count: 2 } });
  });
});
