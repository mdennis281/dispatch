/**
 * The `terminals` capability end to end through the real plugin host: a
 * plugin's `ctx.terminals.registerBackend` lands in the registry, its ports
 * are its own, and switching it off unregisters the backend and withdraws the
 * ports. Without the capability the member is absent.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { TerminalBackendRegistry } from "../services/terminal-backends.js";
import type { PluginContext } from "@dispatch/shared";
import { PluginService } from "./service.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * The module is one fixed text for every plugin; what it does is read from
 * meta.json beside it, so no fixture value is ever spliced into code.
 */
const MODULE = `import { readFileSync } from "node:fs";
const meta = JSON.parse(readFileSync(new URL("./meta.json", import.meta.url), "utf8"));
export function activate(ctx) {
  globalThis.__terminalsTest ??= {};
  globalThis.__terminalsTest[meta.id] = { hasTerminals: Boolean(ctx.terminals) };
  if (!ctx.terminals) return;
  // Handed to the test, which drives the rest of the surface through the host.
  Object.defineProperty(globalThis.__terminalsTest[meta.id], "ctx", { value: ctx.terminals });
  ctx.terminals.registerBackend({
    id: meta.backend, label: "Box", shell: "bash",
    spawn: async () => { throw new Error("not in this test"); },
  });
  ctx.terminals.publishPort(meta.backend, { chatId: "c1", remotePort: 5173, url: "http://127.0.0.1:41000" });
  try {
    ctx.terminals.publishPort("someone-else", { chatId: "c1", remotePort: 1, url: "http://127.0.0.1:1" });
    globalThis.__terminalsTest[meta.id].foreign = "allowed";
  } catch (e) {
    globalThis.__terminalsTest[meta.id].foreign = String(e.message);
  }
}
`;

async function writePlugin(root: string, id: string, caps: string[], backend = "box"): Promise<void> {
  const dir = join(root, id);
  await mkdir(join(dir, "server"), { recursive: true });
  const capLines = caps.map((c) => `  - ${c}\n`).join("");
  await writeFile(
    join(dir, "plugin.yaml"),
    `id: ${id}\nname: ${id}\nversion: 1.0.0\ndispatch: '>=1'\nserver: ./server/main.js\ncapabilities:\n${capLines || "  []\n"}`,
  );
  await writeFile(join(dir, "server", "meta.json"), JSON.stringify({ id, backend }));
  await writeFile(join(dir, "server", "main.js"), MODULE);
}

async function host() {
  const base = await mkdtemp(join(tmpdir(), "dispatch-terminals-"));
  dirs.push(base);
  const configDir = join(base, "config");
  const dataDir = join(base, "data");
  await mkdir(join(configDir, "plugins"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const store = new Store(dataDir, configDir);
  await store.init();
  const bus = new EventBus();
  const registry = new TerminalBackendRegistry({ bus, chat: async () => null, projectDefault: () => undefined });
  const never = () => {
    throw new Error("not in this test");
  };
  const svc = new PluginService({
    configDir,
    store,
    context: {
      bus,
      secrets: { list: async () => [], resolve: () => undefined } as never,
      inspect: { findChats: never, readChat: never } as never,
      memory: { recall: never, write: never, delete: never } as never,
      attention: { list: () => [], get: () => undefined } as never,
      messenger: { send: never, ask: never, reply: never, state: never, targetOf: () => undefined } as never,
      broker: { answerQuestion: () => false, declineQuestion: () => false },
      terminals: registry,
    },
    log: () => {},
    fault: () => {},
  });
  return { configDir, store, registry, svc };
}

const seen = () => (globalThis as unknown as { __terminalsTest: Record<string, Record<string, unknown>> }).__terminalsTest;
const ctxOf = (id: string) => seen()[id]!.ctx as NonNullable<PluginContext["terminals"]>;

describe("the terminals capability", () => {
  it("registers a backend, scopes ports to the plugin's own backends, and tears both down on disable", async () => {
    const h = await host();
    await writePlugin(join(h.configDir, "plugins"), "termy", ["terminals"]);
    await h.svc.load();
    // Installed plugins that declare `terminals` hold the settle, like providers.
    const early = await Promise.race([
      h.svc.activationSettled().then(() => "settled"),
      new Promise((r) => setTimeout(() => r("waiting"), 30)),
    ]);
    expect(early).toBe("waiting");
    await h.svc.activateAll();

    expect(h.svc.get("termy")).toMatchObject({ status: "active" });
    expect(h.registry.list()).toEqual([{ id: "box", label: "Box", shell: "bash", pluginId: "termy", fallback: "local" }]);
    expect(h.registry.ports("c1")).toHaveLength(1);
    expect(seen().termy!.foreign).toMatch(/not registered by plugin "termy"/);

    await h.svc.setEnabled("termy", false);
    // `offs` fire the unregister without awaiting it; let it land.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.registry.size).toBe(0);
    expect(h.registry.ports("c1")).toEqual([]);
    await h.svc.dispose();
    h.store.close();
  });

  it("a plugin may register a backend qualified by its OWN id, and no other plugin's (E12)", async () => {
    const h = await host();
    await writePlugin(join(h.configDir, "plugins"), "remote-host", ["terminals"], "remote-host/cvx-mac");
    await writePlugin(join(h.configDir, "plugins"), "sneaky", ["terminals"], "remote-host/stolen");
    await h.svc.load();
    await h.svc.activateAll();

    expect(h.svc.get("remote-host")).toMatchObject({ status: "active" });
    expect(h.registry.list().map((b) => [b.id, b.pluginId])).toEqual([["remote-host/cvx-mac", "remote-host"]]);
    expect(h.svc.get("sneaky")).toMatchObject({
      status: "error",
      error: expect.stringMatching(/a qualified id must start with the registering plugin's id \("sneaky\/…"\)/),
    });
    // The owner check every other call makes works on a qualified id too.
    ctxOf("remote-host").setStatus("remote-host/cvx-mac", { state: "offline", detail: "asleep" });
    expect(h.registry.list()[0]!.status).toMatchObject({ state: "offline", detail: "asleep" });
    await h.svc.dispose();
    h.store.close();
  });

  it("setStatus / updateBackend / unregisterBackend act only on the plugin's own backends", async () => {
    const h = await host();
    await writePlugin(join(h.configDir, "plugins"), "termy", ["terminals"]);
    await writePlugin(join(h.configDir, "plugins"), "other", ["terminals"], "box2");
    await h.svc.load();
    await h.svc.activateAll();
    const termy = ctxOf("termy");
    const other = ctxOf("other");

    termy.setStatus("box", { state: "offline", detail: "asleep" });
    termy.updateBackend("box", { label: "Renamed" });
    expect(h.registry.list().find((b) => b.id === "box")).toMatchObject({
      label: "Renamed",
      status: { state: "offline", detail: "asleep" },
    });
    for (const call of [
      () => termy.setStatus("box2", { state: "online" }),
      () => termy.updateBackend("box2", { label: "Mine now" }),
      () => termy.unregisterBackend("box2"),
    ]) {
      expect(call).toThrow(/not registered by plugin "termy"/);
    }

    await termy.unregisterBackend("box");
    expect(h.registry.has("box")).toBe(false);
    expect(h.registry.ports("c1").map((p) => p.backend)).toEqual(["box2"]);

    // The id is free again — and once another plugin holds it, the first
    // plugin's teardown must not take it down with its own.
    other.registerBackend({ id: "box", label: "Other's box", shell: "bash", spawn: async () => Promise.reject(new Error("x")) });
    await h.svc.setEnabled("termy", false);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.registry.list().map((b) => `${b.id}:${b.pluginId}`).sort()).toEqual(["box2:other", "box:other"]);
    await h.svc.dispose();
    h.store.close();
  });

  it("is absent from the context when the manifest does not declare it", async () => {
    const h = await host();
    await writePlugin(join(h.configDir, "plugins"), "plain", ["kv"]);
    await h.svc.load();
    await h.svc.activateAll();
    expect(seen().plain).toEqual({ hasTerminals: false });
    expect(h.registry.size).toBe(0);
    await h.svc.dispose();
    h.store.close();
  });
});
