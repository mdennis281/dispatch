/**
 * Built-in plugins: discovered from the shipped root, activated by
 * `activateShipped()` before anything an owner installed, owners of their ids,
 * and — for the `providers` capability — registered with the harness registry
 * and dropped from it when switched off.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { PluginService } from "./service.js";
import { findShippedPluginsRoot } from "./shipped.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A provider plugin whose module registers a fake harness named `id`. */
async function writeProviderPlugin(root: string, id: string, version = "1.0.0"): Promise<void> {
  const dir = join(root, id);
  await mkdir(join(dir, "server"), { recursive: true });
  await writeFile(
    join(dir, "plugin.yaml"),
    `id: ${id}\nname: ${id}\nversion: ${version}\ndispatch: '>=1'\nserver: ./server/main.js\ncapabilities:\n  - providers\n`,
  );
  // The module is the same text for every plugin and reads its identity from
  // a JSON file beside it — no value is ever spliced into code.
  await writeFile(join(dir, "server", "meta.json"), JSON.stringify({ id, version }));
  await writeFile(join(dir, "server", "main.js"), PROVIDER_MODULE);
}

const PROVIDER_MODULE = `import { readFileSync } from "node:fs";
const { id, version } = JSON.parse(readFileSync(new URL("./meta.json", import.meta.url), "utf8"));
export function activate(ctx) {
  ctx.providers.register(
    { kind: id, capabilities: {}, runtime: () => ({ kind: id, source: "installed", available: true }), listModels: async () => [] },
    { id, label: "v" + version, shortLabel: id, blurb: "", fallbackModels: [], efforts: [], subagents: false, skillsDir: ".agents",
      account: { configDirEnv: "X_HOME", defaultConfigDir: ".x", loginFile: "auth.json" } },
  );
}
`;

async function host() {
  const base = await mkdtemp(join(tmpdir(), "dispatch-shipped-"));
  dirs.push(base);
  const configDir = join(base, "config");
  const dataDir = join(base, "data");
  const shippedRoot = join(base, "shipped");
  await mkdir(join(configDir, "plugins"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(shippedRoot, { recursive: true });
  const store = new Store(dataDir, configDir);
  await store.init();
  const registered: string[] = [];
  const unregistered: string[] = [];
  const logs: string[] = [];
  const make = () =>
    new PluginService({
      configDir,
      shippedRoot,
      store,
      context: {
        ...stubContext(),
        providers: {
          register: (harness, descriptor) => {
            if (registered.includes(harness.kind)) throw new Error(`provider "${harness.kind}" is already registered`);
            registered.push(`${harness.kind}:${descriptor.label}`);
          },
          unregister: async (kind) => {
            unregistered.push(kind);
          },
        },
      },
      log: (line) => logs.push(line),
      fault: () => {},
    });
  return { configDir, shippedRoot, store, registered, unregistered, logs, make };
}

describe("built-in plugins", () => {
  it("activate from the shipped root in activateShipped(), ahead of anything installed", async () => {
    const h = await host();
    await writeProviderPlugin(h.shippedRoot, "codexish");
    await writeProviderPlugin(join(h.configDir, "plugins"), "installedish");
    const svc = h.make();
    await svc.load();
    await svc.activateShipped();
    // Only the built-in ran; the installed one waits for `warm()`.
    expect(h.registered).toEqual(["codexish:v1.0.0"]);
    expect(svc.get("codexish")).toMatchObject({ builtin: true, status: "active" });
    expect(svc.get("installedish")!.builtin).toBeUndefined();
    await svc.activateAll();
    expect(h.registered).toEqual(["codexish:v1.0.0", "installedish:v1.0.0"]);
    await svc.dispose();
    h.store.close();
  });

  it("own their id: an installed copy under the same name is ignored, not loaded", async () => {
    const h = await host();
    await writeProviderPlugin(h.shippedRoot, "codexish", "1.0.0");
    await writeProviderPlugin(join(h.configDir, "plugins"), "codexish", "9.9.9");
    const svc = h.make();
    await svc.load();
    await svc.activateShipped();
    await svc.activateAll();
    expect(h.registered).toEqual(["codexish:v1.0.0"]);
    expect(svc.list().filter((p) => p.id === "codexish")).toHaveLength(1);
    expect(h.logs.some((l) => /is ignored — "codexish" is a built-in plugin/.test(l))).toBe(true);
    await svc.dispose();
    h.store.close();
  });

  it("unregister their provider when switched off", async () => {
    const h = await host();
    await writeProviderPlugin(h.shippedRoot, "codexish");
    const svc = h.make();
    await svc.load();
    await svc.activateShipped();
    await svc.setEnabled("codexish", false);
    expect(h.unregistered).toEqual(["codexish"]);
    expect(svc.get("codexish")).toMatchObject({ builtin: true, enabled: false });
    await svc.dispose();
    h.store.close();
  });

  it("hold a chat's provider wait until an installed provider plugin has activated", async () => {
    // `warm()` runs resume.restore() BEFORE activateAll, so "activation not
    // started yet" must not read as "settled" — that is the window in which a
    // restored chat on this provider would fall back and be rewritten.
    const h = await host();
    await writeProviderPlugin(join(h.configDir, "plugins"), "installedish");
    const svc = h.make();
    await svc.load();
    await svc.activateShipped();
    const early = await Promise.race([
      svc.activationSettled().then(() => "settled"),
      new Promise((r) => setTimeout(() => r("waiting"), 50)),
    ]);
    expect(early).toBe("waiting");
    await svc.activateAll();
    await expect(svc.activationSettled()).resolves.toBeUndefined();
    expect(h.registered).toEqual(["installedish:v1.0.0"]);
    await svc.dispose();
    h.store.close();
  });

  it("settle at once when nothing installed could register a provider", async () => {
    const h = await host();
    await writeProviderPlugin(h.shippedRoot, "codexish");
    const svc = h.make();
    await svc.load();
    await svc.activateShipped();
    // Only a built-in, now active: no warm-up can bring in another provider.
    await expect(svc.activationSettled()).resolves.toBeUndefined();
    await svc.dispose();
    h.store.close();
  });

  it("are found beside this server package — Codex and goose both ship", () => {
    const root = findShippedPluginsRoot();
    expect(root).toBeDefined();
    expect(root!.replace(/\\/g, "/")).toMatch(/packages\/plugins$/);
  });
});

function stubContext(): Omit<ConstructorParameters<typeof PluginService>[0]["context"], "providers"> {
  const never = () => {
    throw new Error("not in this test");
  };
  return {
    bus: new EventBus(),
    secrets: { list: async () => [], resolve: () => undefined } as never,
    inspect: { findChats: never, readChat: never } as never,
    memory: { recall: never, write: never, delete: never } as never,
    attention: { list: () => [], get: () => undefined } as never,
    messenger: { send: never, ask: never, reply: never, state: never, targetOf: () => undefined } as never,
    broker: { answerQuestion: () => false, declineQuestion: () => false },
  };
}
