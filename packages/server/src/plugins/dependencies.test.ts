/**
 * Plugin dependencies through the real plugin host: activation in dependency
 * order (not id order), blocking on a required dependency that is missing,
 * off, failed or on a cycle, the cascade when a provider is switched off, and
 * the refusals that keep an uninstall from destroying what a dependent made.
 *
 * Modules are injected through `importModule`; the manifests on disk are real.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginModule, TerminalBackend } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { TerminalBackendRegistry } from "../services/terminal-backends.js";
import { PluginCleanupQueue } from "./cleanup.js";
import { PluginLifecycleError, PluginService } from "./service.js";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface PluginSpec {
  version?: string;
  caps?: string[];
  /** YAML for `dependencies:`, already indented by two. */
  dependencies?: string;
  provides?: string;
  client?: boolean;
}

async function writePlugin(configDir: string, id: string, spec: PluginSpec = {}): Promise<void> {
  const dir = join(configDir, "plugins", id);
  await mkdir(join(dir, "server"), { recursive: true });
  const lines = [
    `id: ${id}`,
    `name: ${id}`,
    `version: ${spec.version ?? "1.0.0"}`,
    `dispatch: '>=1'`,
    `server: ./server/index.js`,
    `capabilities: [${(spec.caps ?? []).join(", ")}]`,
  ];
  if (spec.client) {
    lines.push("client: ./client/index.js");
    await mkdir(join(dir, "client"), { recursive: true });
    await writeFile(join(dir, "client", "index.js"), "export function activate() {}\n");
  }
  if (spec.dependencies) lines.push("dependencies:", spec.dependencies);
  if (spec.provides) lines.push("provides:", spec.provides);
  await writeFile(join(dir, "plugin.yaml"), lines.join("\n") + "\n");
  await writeFile(join(dir, "server", "index.js"), "export function activate() {}\n");
}

/** A module that writes every lifecycle call to a shared log as `<id>:<call>`. */
function logged(id: string, log: string[], extra: Partial<PluginModule> = {}): PluginModule {
  return {
    activate: () => {
      log.push(`${id}:activate`);
    },
    deactivate: () => {
      log.push(`${id}:deactivate`);
    },
    onShutdown: (e) => {
      log.push(`${id}:onShutdown:${e.reason}`);
    },
    ...extra,
  };
}

async function paths(): Promise<{ configDir: string; dataDir: string }> {
  const base = await mkdtemp(join(tmpdir(), "dispatch-deps-"));
  dirs.push(base);
  const configDir = join(base, "config");
  const dataDir = join(base, "data");
  await mkdir(join(configDir, "plugins"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  return { configDir, dataDir };
}

/** One "process", wired like the container. `activate: false` stops after `load()`. */
async function host(
  base: { configDir: string; dataDir: string },
  modules: Record<string, PluginModule>,
  opts: { activate?: boolean; activateBudgetMs?: number } = {},
) {
  const store = new Store(base.dataDir, base.configDir);
  await store.init();
  stores.push(store);
  const bus = new EventBus();
  const logs: string[] = [];
  // eslint-disable-next-line prefer-const
  let registry: TerminalBackendRegistry;
  const cleanups = new PluginCleanupQueue({
    db: store.stateDb,
    run: (row) => registry.runChatDeleted(row.target, { chatId: row.chatId, projectId: row.projectId }),
  });
  registry = new TerminalBackendRegistry({ bus, chat: async () => null, projectDefault: () => undefined, cleanups });
  const never = () => {
    throw new Error("not in this test");
  };
  const svc = new PluginService({
    configDir: base.configDir,
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
    importModule: async (url) => {
      const id = Object.keys(modules).find((k) => url.includes(`/plugins/${k}/`));
      if (!id) throw new Error(`no module for ${url}`);
      return modules[id];
    },
    cleanups,
    ...(opts.activateBudgetMs ? { activateBudgetMs: opts.activateBudgetMs } : {}),
    log: (line) => logs.push(line),
    fault: () => {},
  });
  await svc.load();
  if (opts.activate !== false) await svc.activateAll();
  return { store, svc, registry, logs };
}

const status = (svc: PluginService, id: string) => svc.get(id)?.status;

describe("activation order", () => {
  it("activates a provider before its consumer even when the consumer's id sorts first, and disposes in reverse", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "aaa-consumer", { dependencies: "  zzz-provider:\n    uses: [machines@1]" });
    await writePlugin(base.configDir, "zzz-provider", { provides: "  machines: [1]" });
    await writePlugin(base.configDir, "mmm-plain");
    const log: string[] = [];
    const h = await host(base, {
      "aaa-consumer": logged("aaa-consumer", log),
      "zzz-provider": logged("zzz-provider", log),
      "mmm-plain": logged("mmm-plain", log),
    });
    expect(log.filter((l) => l.endsWith(":activate"))).toEqual([
      "mmm-plain:activate",
      "zzz-provider:activate",
      "aaa-consumer:activate",
    ]);
    const row = h.svc.get("aaa-consumer")!;
    expect(row.status).toBe("active");
    expect(row.dependencies).toEqual([{ id: "zzz-provider", uses: ["machines@1"], optional: false, state: "ok", detail: "" }]);
    expect(h.svc.get("zzz-provider")).toMatchObject({ dependents: ["aaa-consumer"], provides: ["machines@1"] });

    log.length = 0;
    await h.svc.dispose();
    const downs = log.filter((l) => l.endsWith(":deactivate"));
    expect(downs.indexOf("aaa-consumer:deactivate")).toBeLessThan(downs.indexOf("zzz-provider:deactivate"));
  });
});

describe("blocking", () => {
  it("never activates a plugin whose required dependency is missing, and says which on its row", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "consumer", {
      dependencies: "  remote-host:\n    uses: [machines@1]",
      client: true,
      caps: ["ui"],
    });
    const log: string[] = [];
    const h = await host(base, { consumer: logged("consumer", log) });
    expect(log).toEqual([]);
    const row = h.svc.get("consumer")!;
    expect(row.status).toBe("blocked");
    expect(row.error).toBe("needs remote-host (machines@1): remote-host is not installed");
    expect(row.dependencies?.[0]?.state).toBe("missing");
    // Not running, so nothing of it is served.
    expect(h.svc.clientRoot("consumer")).toBeUndefined();
  });

  it("blocks on a provider out of range or not providing the major, and on a required cycle", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "old", { version: "0.9.2", provides: "  machines: [1]" });
    await writePlugin(base.configDir, "wants-new", { dependencies: "  old:\n    uses: [machines@1]\n    version: '>=0.10.0'" });
    await writePlugin(base.configDir, "wants-v2", { dependencies: "  old:\n    uses: [machines@2]" });
    await writePlugin(base.configDir, "ping", { provides: "  a: [1]", dependencies: "  pong:\n    uses: [b@1]" });
    await writePlugin(base.configDir, "pong", { provides: "  b: [1]", dependencies: "  ping:\n    uses: [a@1]" });
    const log: string[] = [];
    const h = await host(base, Object.fromEntries(["old", "wants-new", "wants-v2", "ping", "pong"].map((id) => [id, logged(id, log)])));
    expect(log).toEqual(["old:activate"]);
    expect(h.svc.get("wants-new")?.error).toContain("old 0.9.2 is installed; this needs >=0.10.0");
    expect(h.svc.get("wants-v2")?.error).toContain("does not provide machines@2");
    expect(h.svc.get("ping")?.error).toContain("dependency cycle: ping → pong → ping");
    expect(status(h.svc, "pong")).toBe("blocked");
  });

  it("blocks a required consumer when its provider fails to activate, and still starts an optional one", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "provider", { provides: "  machines: [1]" });
    await writePlugin(base.configDir, "needs-it", { dependencies: "  provider:\n    uses: [machines@1]" });
    await writePlugin(base.configDir, "likes-it", { dependencies: "  provider:\n    uses: [machines@1]\n    optional: true" });
    const log: string[] = [];
    const h = await host(base, {
      provider: logged("provider", log, {
        activate: () => {
          throw new Error("boom");
        },
      }),
      "needs-it": logged("needs-it", log),
      "likes-it": logged("likes-it", log),
    });
    expect(status(h.svc, "provider")).toBe("error");
    expect(status(h.svc, "needs-it")).toBe("blocked");
    expect(h.svc.get("needs-it")?.error).toBe("needs provider (machines@1): provider failed to start: boom");
    expect(log).toContain("likes-it:activate");
    expect(log).not.toContain("needs-it:activate");
    expect(h.svc.get("likes-it")?.dependencies?.[0]).toMatchObject({ state: "failed", optional: true });
  });
});

describe("switching a provider off", () => {
  it("takes required dependents down first, as a disable, after their backends have finished unregistering", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "base", { provides: "  b: [1]" });
    await writePlugin(base.configDir, "mid", {
      caps: ["terminals"],
      provides: "  m: [1]",
      dependencies: "  base:\n    uses: [b@1]",
    });
    await writePlugin(base.configDir, "top", { dependencies: "  mid:\n    uses: [m@1]" });
    await writePlugin(base.configDir, "fan", { dependencies: "  base:\n    uses: [b@1]\n    optional: true" });
    const log: string[] = [];
    const backend: TerminalBackend = {
      id: "mid-term",
      label: "mid",
      shell: "bash",
      spawn: async () => {
        throw new Error("no shells here");
      },
      // Slow on purpose: the provider must not go down until this has finished.
      dispose: async () => {
        await sleep(80);
        log.push("mid:backend-disposed");
      },
    };
    const h = await host(base, {
      base: logged("base", log),
      mid: logged("mid", log, {
        activate: (ctx) => {
          log.push("mid:activate");
          ctx.terminals!.registerBackend(backend);
        },
      }),
      top: logged("top", log),
      fan: logged("fan", log),
    });
    log.length = 0;

    await h.svc.setEnabled("base", false);
    expect(log).toEqual([
      "top:onShutdown:disable",
      "top:deactivate",
      "mid:onShutdown:disable",
      "mid:deactivate",
      "mid:backend-disposed",
      "base:onShutdown:disable",
      "base:deactivate",
    ]);
    expect(log.some((l) => l.includes("uninstall"))).toBe(false);
    expect(status(h.svc, "mid")).toBe("blocked");
    expect(status(h.svc, "top")).toBe("blocked");
    expect(h.svc.get("mid")?.error).toBe("needs base, which was switched off");
    // An optional dependent is not taken down for it (C2 tells it instead).
    expect(status(h.svc, "fan")).toBe("active");
    expect(h.svc.get("fan")?.dependencies?.[0]?.state).toBe("disabled");
    // The toggles of the dependents were not touched.
    expect(h.svc.get("mid")?.enabled).toBe(true);
    expect(h.registry.list().some((b) => b.id === "mid-term")).toBe(false);
  });
});

describe("refusals", () => {
  it("refuses to uninstall a plugin another one depends on, naming it — and allows it once that one is gone", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "remote-host", { provides: "  machines: [1]" });
    await writePlugin(base.configDir, "proxmox-terminal", { dependencies: "  remote-host:\n    uses: [machines@1]\n    optional: true" });
    const log: string[] = [];
    const h = await host(base, { "remote-host": logged("remote-host", log), "proxmox-terminal": logged("proxmox-terminal", log) });
    await expect(h.svc.uninstall("remote-host")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(`"remote-host" is used by "proxmox-terminal"`),
    });
    // Nothing was taken down by the refusal.
    expect(log.some((l) => l.includes("onShutdown"))).toBe(false);
    await h.svc.uninstall("proxmox-terminal");
    expect(log).toContain("proxmox-terminal:onShutdown:uninstall");
    await expect(h.svc.uninstall("remote-host")).resolves.toMatchObject({ id: "remote-host" });
  });

  it("refuses to switch off, or uninstall, a plugin that is still starting", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "aaa-slow");
    await writePlugin(base.configDir, "bbb-later");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const log: string[] = [];
    const h = await host(
      base,
      { "aaa-slow": logged("aaa-slow", log, { activate: () => gate }), "bbb-later": logged("bbb-later", log) },
      { activate: false },
    );
    const all = h.svc.activateAll();
    await sleep(20);
    await expect(h.svc.setEnabled("aaa-slow", false)).rejects.toBeInstanceOf(PluginLifecycleError);
    await expect(h.svc.setEnabled("bbb-later", false)).rejects.toMatchObject({ status: 409 });
    await expect(h.svc.uninstall("bbb-later")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("still starting") });
    release();
    await all;
    await expect(h.svc.setEnabled("bbb-later", false)).resolves.toMatchObject({ enabled: false });
  });
});

describe("waiting for terminal backends", () => {
  it("settles once every plugin that can register a backend is done — not after everything installed", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "aaa-term", { caps: ["terminals"] });
    await writePlugin(base.configDir, "zzz-slow");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = await host(
      base,
      { "aaa-term": logged("aaa-term", []), "zzz-slow": logged("zzz-slow", [], { activate: () => gate }) },
      { activate: false },
    );
    const all = h.svc.activateAll();
    let settled = false;
    void h.svc.activationSettled().then(() => (settled = true));
    await sleep(30);
    expect(settled).toBe(true);
    release();
    await all;
  });
});

describe("shutdown hooks", () => {
  it("run a consumer's before what it uses — even through a plugin with no hook — and unrelated ones alongside", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "aaa-consumer", { dependencies: "  zzz-mid:\n    uses: [m@1]" });
    await writePlugin(base.configDir, "zzz-mid", { provides: "  m: [1]", dependencies: "  zzz-provider:\n    uses: [b@1]" });
    await writePlugin(base.configDir, "zzz-provider", { provides: "  b: [1]" });
    await writePlugin(base.configDir, "mmm-plain");
    const log: string[] = [];
    const h = await host(base, {
      "aaa-consumer": logged("aaa-consumer", log, {
        onShutdown: async () => {
          log.push("aaa-consumer:start");
          await sleep(60);
          log.push("aaa-consumer:end");
        },
      }),
      "zzz-mid": logged("zzz-mid", log, { onShutdown: undefined }),
      "zzz-provider": logged("zzz-provider", log, { onShutdown: () => void log.push("zzz-provider:start") }),
      "mmm-plain": logged("mmm-plain", log, { onShutdown: () => void log.push("mmm-plain:start") }),
    });
    log.length = 0;
    await h.svc.shutdown("stop");
    // The provider's hook waits for the consumer's, which still had it to call.
    expect(log.indexOf("zzz-provider:start")).toBeGreaterThan(log.indexOf("aaa-consumer:end"));
    // An unrelated plugin does not wait for anyone.
    expect(log.indexOf("mmm-plain:start")).toBeLessThan(log.indexOf("aaa-consumer:end"));
  });
});
