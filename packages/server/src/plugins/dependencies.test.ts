/**
 * Plugin dependencies through the real plugin host: activation in dependency
 * order (not id order), blocking on a required dependency that is missing,
 * off, failed, unserved or on a cycle, the cascade when a provider is switched
 * off, the refusals that keep an uninstall from destroying what a dependent
 * made — and `ctx.provides` / `ctx.dependencies`, the links between them.
 *
 * Modules are injected through `importModule`; the manifests on disk are real.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PluginCallError,
  PluginRevokedError,
  type PluginCaller,
  type PluginContext,
  type PluginModule,
  type TerminalBackend,
} from "@dispatch/shared";
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

/**
 * A module that writes every lifecycle call to a shared log as `<id>:<call>`,
 * and serves `serves` (`name@major`) with an empty API — a declared export
 * nobody serves reads `not-served` and blocks what requires it.
 */
function logged(id: string, log: string[], extra: Partial<PluginModule> = {}, serves: string[] = []): PluginModule {
  return {
    activate: (ctx) => {
      log.push(`${id}:activate`);
      serveAll(ctx, serves);
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

function serveAll(ctx: PluginContext, uses: string[]): void {
  for (const use of uses) {
    const [name, major] = use.split("@");
    ctx.provides!.serve(name!, Number(major), () => ({}));
  }
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
      "zzz-provider": logged("zzz-provider", log, {}, ["machines@1"]),
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
      base: logged("base", log, {}, ["b@1"]),
      mid: logged("mid", log, {
        activate: (ctx) => {
          log.push("mid:activate");
          ctx.provides!.serve("m", 1, () => ({}));
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
      "zzz-mid": logged("zzz-mid", log, { onShutdown: undefined }, ["m@1"]),
      "zzz-provider": logged("zzz-provider", log, { onShutdown: () => void log.push("zzz-provider:start") }, ["b@1"]),
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

/** A provider + consumer pair whose ctx members the test keeps, to drive the links from outside. */
function pair(log: string[], opts: { optional?: boolean; consumerCaps?: string[] } = {}) {
  const ctxs: Record<string, PluginContext> = {};
  const callers: PluginCaller[] = [];
  let listener: (() => void) | undefined;
  const provider: PluginModule = {
    activate: (ctx) => {
      ctxs.prov = ctx;
      ctx.provides!.serve("machines", 1, (caller) => {
        callers.push(caller);
        caller.signal.addEventListener("abort", () => log.push(`prov:signal-aborted:${caller.id}`));
        return {
          ping: () => "pong",
          whoami: () => caller.id,
          subscribe: (fn: () => void) => {
            listener = fn;
          },
          boom: () => {
            throw Object.assign(new Error("no route to host"), { code: "unreachable" });
          },
        };
      });
    },
    onShutdown: (e) => void log.push(`prov:onShutdown:${e.reason}`),
    deactivate: () => {
      log.push("prov:deactivate");
      // Its teardown still talks to the consumer: the link must be open.
      listener?.();
    },
  };
  type Machines = { ping(): string; whoami(): string; subscribe(fn: () => void): void; boom(): never };
  const held: { api?: Machines } = {};
  const consumer: PluginModule = {
    activate: (ctx) => {
      ctxs.cons = ctx;
      held.api = ctx.dependencies!.get<Machines>("prov", "machines", 1);
      held.api?.subscribe(() => log.push("cons:callback"));
      ctx.dependencies!.onLost("prov", () => {
        log.push("cons:onLost");
        log.push(`cons:onLost:get=${typeof ctx.dependencies!.get("prov", "machines", 1)}`);
        log.push(`cons:onLost:ping=${held.api!.ping()}`);
      });
    },
    onShutdown: (e) => {
      log.push(`cons:onShutdown:${e.reason}`);
      log.push(`cons:onShutdown:ping=${held.api!.ping()}`);
    },
    deactivate: () => void log.push("cons:deactivate"),
  };
  return {
    ctxs,
    callers,
    held,
    modules: { prov: provider, cons: consumer },
    write: async (configDir: string) => {
      await writePlugin(configDir, "prov", { provides: "  machines: [1]" });
      await writePlugin(configDir, "cons", {
        caps: opts.consumerCaps ?? [],
        dependencies: `  prov:\n    uses: [machines@1]${opts.optional ? "\n    optional: true" : ""}`,
      });
    },
  };
}

describe("ctx.provides / ctx.dependencies", () => {
  it("hands a consumer the provider's API, built once for it with its identity, through the membrane", async () => {
    const base = await paths();
    const log: string[] = [];
    const p = pair(log, { consumerCaps: ["events"] });
    await p.write(base.configDir);
    await writePlugin(base.configDir, "plain");
    let plainCtx: PluginContext | undefined;
    await host(base, { ...p.modules, plain: { activate: (ctx) => void (plainCtx = ctx) } });

    const api = p.held.api!;
    expect(api.ping()).toBe("pong");
    expect(api.whoami()).toBe("cons");
    // The same object every time, and the factory ran once.
    expect(p.ctxs.cons!.dependencies!.get("prov", "machines", 1)).toBe(api);
    expect(p.callers).toHaveLength(1);
    const caller = p.callers[0]!;
    expect(caller).toMatchObject({ id: "cons", name: "cons", version: "1.0.0", capabilities: ["events"] });
    expect(Object.isFrozen(caller)).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    // Errors arrive tagged with the plugin whose code threw.
    expect(() => api.boom()).toThrow(PluginCallError);
    expect(() => api.boom()).toThrow("prov: no route to host");

    expect(p.ctxs.cons!.dependencies!.state("prov")).toMatchObject({ state: "ok", uses: ["machines@1"] });
    // Only what the manifest declared, and only for a manifest that declares it.
    expect(() => p.ctxs.cons!.dependencies!.get("prov", "machines", 2)).toThrow(/does not list machines@2/);
    expect(() => p.ctxs.cons!.dependencies!.get("other", "machines", 1)).toThrow(/does not declare a dependency on "other"/);
    expect(p.ctxs.cons!.provides).toBeUndefined();
    expect(p.ctxs.prov!.dependencies).toBeUndefined();
    expect(plainCtx!.dependencies).toBeUndefined();
    expect(plainCtx!.provides).toBeUndefined();
    expect(p.ctxs.prov!.provides!.dependents()).toEqual([{ id: "cons", installed: true, status: "active", uses: ["machines@1"] }]);
  });

  it("accepts serve() only while activate runs, only for declared exports, once each", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "prov", { provides: "  machines: [1, 2]" });
    await writePlugin(base.configDir, "needs-v2", { dependencies: "  prov:\n    uses: [machines@2]" });
    await writePlugin(base.configDir, "likes-v2", { dependencies: "  prov:\n    uses: [machines@2]\n    optional: true" });
    const errors: string[] = [];
    let provCtx: PluginContext | undefined;
    let likesCtx: PluginContext | undefined;
    const log: string[] = [];
    const h = await host(base, {
      prov: {
        activate: (ctx) => {
          provCtx = ctx;
          ctx.provides!.serve("machines", 1, () => ({}));
          for (const attempt of [
            () => ctx.provides!.serve("machines", 1, () => ({})),
            () => ctx.provides!.serve("other", 1, () => ({})),
            () => ctx.provides!.serve("machines", 3, () => ({})),
          ]) {
            try {
              attempt();
            } catch (err) {
              errors.push((err as Error).message);
            }
          }
        },
      },
      "needs-v2": logged("needs-v2", log),
      "likes-v2": { activate: (ctx) => void (likesCtx = ctx) },
    });
    expect(errors).toEqual([
      "machines@1 is already served",
      `"prov" does not declare provides.other: [1] in its plugin.yaml`,
      `"prov" does not declare provides.machines: [3] in its plugin.yaml`,
    ]);
    expect(() => provCtx!.provides!.serve("machines", 2, () => ({}))).toThrow(/only while activate\(\) runs/);
    // A declared export it never served: what requires it is blocked, saying so…
    expect(status(h.svc, "needs-v2")).toBe("blocked");
    expect(h.svc.get("needs-v2")?.error).toBe("needs prov (machines@2): prov did not serve machines@2");
    expect(log).toEqual([]);
    // …and what only likes it starts without it.
    expect(status(h.svc, "likes-v2")).toBe("active");
    expect(likesCtx!.dependencies!.get("prov", "machines", 2)).toBeUndefined();
    expect(likesCtx!.dependencies!.state("prov")?.state).toBe("not-served");
  });

  it("a provider whose activate throws serves nothing, even what it served before throwing", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "prov", { provides: "  machines: [1]" });
    await writePlugin(base.configDir, "likes", { dependencies: "  prov:\n    uses: [machines@1]\n    optional: true" });
    let likesCtx: PluginContext | undefined;
    await host(base, {
      prov: {
        activate: (ctx) => {
          ctx.provides!.serve("machines", 1, () => ({ ping: () => "half-built" }));
          throw new Error("boom");
        },
      },
      likes: { activate: (ctx) => void (likesCtx = ctx) },
    });
    expect(likesCtx!.dependencies!.get("prov", "machines", 1)).toBeUndefined();
    expect(likesCtx!.dependencies!.state("prov")?.state).toBe("failed");
  });

  it("switching a provider off: an optional dependent hears first, and the link closes only after the provider's teardown", async () => {
    const base = await paths();
    const log: string[] = [];
    const p = pair(log, { optional: true });
    await p.write(base.configDir);
    const h = await host(base, p.modules);
    const api = p.held.api!;
    log.length = 0;

    await h.svc.setEnabled("prov", false);
    expect(log).toEqual([
      "cons:onLost",
      // Withdrawn from `get` the moment its dependents are told…
      "cons:onLost:get=undefined",
      // …but what they already hold works until the provider is down.
      "cons:onLost:ping=pong",
      "prov:onShutdown:disable",
      "prov:deactivate",
      // The provider's teardown calling back into the consumer still lands.
      "cons:callback",
      "prov:signal-aborted:cons",
    ]);
    expect(status(h.svc, "cons")).toBe("active");
    let caught: unknown;
    try {
      api.ping();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PluginRevokedError);
    expect(caught).toMatchObject({ code: "revoked", plugin: "prov", message: "prov is no longer running" });
    expect(p.ctxs.cons!.dependencies!.get("prov", "machines", 1)).toBeUndefined();
    expect(p.ctxs.cons!.dependencies!.state("prov")?.state).toBe("disabled");
  });

  it("a consumer going down keeps its link through its own shutdown, then closes it and aborts caller.signal", async () => {
    const base = await paths();
    const log: string[] = [];
    const p = pair(log);
    await p.write(base.configDir);
    const h = await host(base, p.modules);
    const api = p.held.api!;
    const consCtx = p.ctxs.cons!;
    log.length = 0;

    await h.svc.setEnabled("cons", false);
    expect(log).toEqual(["cons:onShutdown:disable", "cons:onShutdown:ping=pong", "cons:deactivate", "prov:signal-aborted:cons"]);
    expect(p.callers[0]!.signal.aborted).toBe(true);
    expect(() => api.ping()).toThrow(PluginRevokedError);
    // A context kept past its plugin's teardown opens nothing new.
    expect(consCtx.dependencies!.get("prov", "machines", 1)).toBeUndefined();
    expect(status(h.svc, "prov")).toBe("active");
    // The provider's onLost never fired: it was the consumer that went.
    expect(log).not.toContain("cons:onLost");
  });

  it("on shutdown the consumer goes first, with its link open, and the provider sees its caller go", async () => {
    const base = await paths();
    const log: string[] = [];
    const p = pair(log);
    await p.write(base.configDir);
    const h = await host(base, p.modules);
    log.length = 0;
    await h.svc.dispose();
    // The SDK's createTestHost asserts this same sequence (testing.dependencies.test.ts).
    expect(log).toEqual([
      "cons:onShutdown:stop",
      "cons:onShutdown:ping=pong",
      "prov:onShutdown:stop",
      "cons:deactivate",
      "prov:signal-aborted:cons",
      "prov:deactivate",
    ]);
  });

  it("switching a REQUIRED provider off takes the consumer down first, its link open until its teardown is done", async () => {
    const base = await paths();
    const log: string[] = [];
    const p = pair(log);
    await p.write(base.configDir);
    const h = await host(base, p.modules);
    log.length = 0;
    await h.svc.setEnabled("prov", false);
    // The SDK's createTestHost asserts this same sequence (testing.dependencies.test.ts).
    expect(log).toEqual([
      "cons:onShutdown:disable",
      "cons:onShutdown:ping=pong",
      "cons:deactivate",
      "prov:signal-aborted:cons",
      "prov:onShutdown:disable",
      "prov:deactivate",
    ]);
    expect(h.svc.get("cons")).toMatchObject({ status: "blocked", error: "needs prov, which was switched off" });
  });

  it("dependents() lists every installed dependent in any state — an unreadable manifest too, with no uses", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "prov", { provides: "  machines: [1]" });
    await writePlugin(base.configDir, "aaa-likes", { dependencies: "  prov:\n    uses: [machines@1]\n    optional: true" });
    await writePlugin(base.configDir, "bbb-stuck", {
      dependencies: "  prov:\n    uses: [machines@1]\n  missing-one:\n    uses: [x@1]",
    });
    await writePlugin(base.configDir, "ccc-unrelated");
    await mkdir(join(base.configDir, "plugins", "ddd-broken"), { recursive: true });
    await writeFile(join(base.configDir, "plugins", "ddd-broken", "plugin.yaml"), "id: [unclosed\n");
    let provCtx: PluginContext | undefined;
    await host(base, {
      prov: {
        activate: (ctx) => {
          provCtx = ctx;
          ctx.provides!.serve("machines", 1, () => ({}));
        },
      },
      "aaa-likes": { activate: () => {} },
      "bbb-stuck": { activate: () => {} },
      "ccc-unrelated": { activate: () => {} },
    });
    expect(provCtx!.provides!.dependents()).toEqual([
      { id: "aaa-likes", installed: true, status: "active", uses: ["machines@1"] },
      { id: "bbb-stuck", installed: true, status: "blocked", uses: ["machines@1"] },
      // Maybe a dependent in the middle of an update: never read as "gone".
      { id: "ddd-broken", installed: true, status: "invalid", uses: [] },
    ]);
  });
});
