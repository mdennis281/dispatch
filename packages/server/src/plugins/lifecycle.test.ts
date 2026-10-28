/**
 * The cleanup lifecycle through the real plugin host: `onShutdown` with the
 * right reason on every path and a budget that cannot be overrun, `reconcile`
 * after every activation, and a failed `onChatDeleted` that is persisted,
 * retried, and dropped on uninstall.
 *
 * Modules are injected through `importModule`, so each test's plugin is a
 * plain object it can inspect — the manifests on disk are real.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PluginLiveChat,
  PluginModule,
  PluginReconcileEvent,
  PluginShutdownEvent,
  TerminalBackend,
} from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { TerminalBackendRegistry } from "../services/terminal-backends.js";
import { PluginCleanupQueue } from "./cleanup.js";
import { PluginService } from "./service.js";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) s.close();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

async function writePlugin(configDir: string, id: string, caps: string[] = []): Promise<void> {
  const dir = join(configDir, "plugins", id);
  await mkdir(join(dir, "server"), { recursive: true });
  const capLines = caps.map((c) => `  - ${c}\n`).join("");
  await writeFile(
    join(dir, "plugin.yaml"),
    `id: ${id}\nname: ${id}\nversion: 1.0.0\ndispatch: '>=1'\nserver: ./server/index.js\ncapabilities:\n${capLines || "  []\n"}`,
  );
  await writeFile(join(dir, "server", "index.js"), "export function activate() {}\n");
}

/** A recording plugin. `make` customises the hooks; everything is logged to `calls`. */
function recorder(make: (calls: string[]) => Partial<PluginModule> = () => ({})) {
  const calls: string[] = [];
  const shutdowns: PluginShutdownEvent[] = [];
  const reconciles: PluginReconcileEvent[] = [];
  const extra = make(calls);
  const mod: PluginModule = {
    activate: () => {
      calls.push("activate");
    },
    deactivate: () => {
      calls.push("deactivate");
    },
    onShutdown: (e) => {
      calls.push(`onShutdown:${e.reason}`);
      shutdowns.push(e);
    },
    reconcile: (e) => {
      calls.push("reconcile");
      reconciles.push(e);
    },
    ...extra,
  };
  return { mod, calls, shutdowns, reconciles };
}

interface HostOpts {
  base?: { configDir: string; dataDir: string };
  modules: Record<string, PluginModule>;
  shutdownBudgetMs?: number;
  liveChats?: PluginLiveChat[];
  hookTimeoutMs?: number;
}

async function paths(): Promise<{ configDir: string; dataDir: string }> {
  const base = await mkdtemp(join(tmpdir(), "dispatch-lifecycle-"));
  dirs.push(base);
  const configDir = join(base, "config");
  const dataDir = join(base, "data");
  await mkdir(join(configDir, "plugins"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  return { configDir, dataDir };
}

/** One "process": a store, a registry, a cleanup queue and a plugin host, wired like the container. */
async function host(opts: HostOpts) {
  const p = opts.base ?? (await paths());
  const store = new Store(p.dataDir, p.configDir);
  await store.init();
  stores.push(store);
  const bus = new EventBus();
  const logs: string[] = [];
  const faults: string[] = [];
  // eslint-disable-next-line prefer-const
  let registry: TerminalBackendRegistry;
  const cleanups = new PluginCleanupQueue({
    db: store.stateDb,
    run: (row) => registry.runChatDeleted(row.target, { chatId: row.chatId, projectId: row.projectId }),
  });
  registry = new TerminalBackendRegistry({
    bus,
    chat: async () => null,
    projectDefault: () => undefined,
    cleanups,
    hookTimeoutMs: opts.hookTimeoutMs,
  });
  const never = () => {
    throw new Error("not in this test");
  };
  const svc = new PluginService({
    configDir: p.configDir,
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
      const id = Object.keys(opts.modules).find((k) => url.includes(`/plugins/${k}/`));
      if (!id) throw new Error(`no module for ${url}`);
      return opts.modules[id];
    },
    shutdownBudgetMs: opts.shutdownBudgetMs,
    cleanups,
    ...(opts.liveChats ? { liveChats: async () => opts.liveChats! } : {}),
    log: (line) => logs.push(line),
    fault: (kind) => faults.push(kind),
  });
  await svc.load();
  await svc.activateAll();
  return { ...p, store, svc, registry, cleanups, logs, faults };
}

describe("onShutdown", () => {
  it("runs every plugin's hook in parallel, aborts and names an overrun, and still deactivates both", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "fast");
    await writePlugin(base.configDir, "slow");
    const fast = recorder();
    let slowSignal: AbortSignal | undefined;
    const slow = recorder((calls) => ({
      onShutdown: (e) => {
        calls.push(`onShutdown:${e.reason}`);
        slowSignal = e.signal as AbortSignal;
        return new Promise<void>(() => {}); // never settles
      },
    }));
    const h = await host({ base, modules: { fast: fast.mod, slow: slow.mod }, shutdownBudgetMs: 150 });

    const started = Date.now();
    await h.svc.shutdown("restart");
    const elapsed = Date.now() - started;

    expect(fast.calls).toContain("onShutdown:restart");
    expect(slow.calls).toContain("onShutdown:restart");
    // One shared budget, not one per plugin in series.
    expect(elapsed).toBeLessThan(1_000);
    expect(slowSignal?.aborted).toBe(true);
    expect(fast.shutdowns[0]!.deadline).toBeGreaterThanOrEqual(started + 150);
    expect(h.logs.some((l) => l.includes(`"slow" onShutdown(restart) overran`))).toBe(true);
    expect(h.logs.some((l) => l.includes(`"fast"`) && l.includes("overran"))).toBe(false);

    await h.svc.dispose();
    // dispose joins the pass above — the hooks are not called a second time.
    expect(fast.calls.filter((c) => c.startsWith("onShutdown"))).toEqual(["onShutdown:restart"]);
    expect(fast.calls.at(-1)).toBe("deactivate");
    expect(slow.calls.at(-1)).toBe("deactivate");
  });

  it("is `stop` for a teardown that never said otherwise", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "one");
    const one = recorder();
    const h = await host({ base, modules: { one: one.mod } });
    await h.svc.whenReconciled("one");
    await h.svc.dispose();
    expect(one.calls).toEqual(["activate", "reconcile", "onShutdown:stop", "deactivate"]);
  });

  it("is `disable` on a toggle-off, and runs before deactivate", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "one");
    const one = recorder();
    const h = await host({ base, modules: { one: one.mod } });
    await h.svc.setEnabled("one", false);
    expect(one.calls.slice(-2)).toEqual(["onShutdown:disable", "deactivate"]);
    await h.svc.dispose();
    // Already down: a later server stop does not wake it to say `stop`.
    expect(one.calls.filter((c) => c.startsWith("onShutdown"))).toEqual(["onShutdown:disable"]);
  });

  it("is `uninstall` on an uninstall", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "one");
    const one = recorder();
    const h = await host({ base, modules: { one: one.mod } });
    await h.svc.uninstall("one");
    expect(one.calls.slice(-2)).toEqual(["onShutdown:uninstall", "deactivate"]);
    await h.svc.dispose();
  });

  it("reports a throwing hook as a fault and carries on", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "bad");
    const bad = recorder(() => ({
      onShutdown: () => {
        throw new Error("boom");
      },
    }));
    const h = await host({ base, modules: { bad: bad.mod } });
    await h.svc.shutdown("stop");
    expect(h.faults).toContain(`plugin "bad" onShutdown(stop) failed`);
    await h.svc.dispose();
    expect(bad.calls.at(-1)).toBe("deactivate");
  });
});

describe("reconcile", () => {
  it("runs after activation with every live chat, and again on the first boot after a re-enable", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "one");
    const chats: PluginLiveChat[] = [
      { id: "c1", projectId: "p1", terminalBackend: "box" },
      { id: "c2", projectId: "p1", archived: true },
    ];
    const first = recorder();
    const h1 = await host({ base, modules: { one: first.mod }, liveChats: chats });
    await h1.svc.whenReconciled("one");
    expect(first.reconciles).toHaveLength(1);
    expect(first.reconciles[0]!.chats).toEqual(chats);
    expect(first.reconciles[0]!.signal.aborted).toBe(false);

    // Off, then on: on is "restart to apply", so nothing reconciles yet…
    await h1.svc.setEnabled("one", false);
    await h1.svc.setEnabled("one", true);
    expect(h1.svc.get("one")).toMatchObject({ needsRestart: true });
    expect(first.reconciles).toHaveLength(1);
    await h1.svc.dispose();
    h1.store.close();
    stores.splice(stores.indexOf(h1.store), 1);

    // …and the next process, which activates it, does.
    const second = recorder();
    const h2 = await host({ base, modules: { one: second.mod }, liveChats: chats.slice(0, 1) });
    await h2.svc.whenReconciled("one");
    expect(second.reconciles.map((e) => e.chats.map((c) => c.id))).toEqual([["c1"]]);
    await h2.svc.dispose();
  });

  it("never starts a reconcile on a plugin that went down before it could", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "one");
    const one = recorder();
    const h = await host({ base, modules: { one: one.mod } });
    // Synchronously after activation: the reconcile is still reading the chat list.
    await h.svc.dispose();
    await h.svc.whenReconciled("one");
    expect(one.calls).toEqual(["activate", "onShutdown:stop", "deactivate"]);
  });

  it("aborts a reconcile still running when the plugin goes down", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "one");
    let signal: AbortSignal | undefined;
    const one = recorder(() => ({
      reconcile: (e) => {
        signal = e.signal as AbortSignal;
        return new Promise<void>(() => {});
      },
    }));
    const h = await host({ base, modules: { one: one.mod } });
    // The reconcile is detached and reads the chat list first: wait for it to start.
    for (let i = 0; i < 200 && !signal; i++) await tick(5);
    expect(signal?.aborted).toBe(false);
    await h.svc.setEnabled("one", false);
    expect(signal?.aborted).toBe(true);
    // Cut short by its own plugin going down is not a fault.
    expect(h.faults.filter((f) => f.includes("reconcile"))).toEqual([]);
    await h.svc.dispose();
  });
});

describe("durable onChatDeleted", () => {
  /** A plugin registering one terminal backend whose delete hook the test controls. */
  function boxPlugin(onChatDeleted: TerminalBackend["onChatDeleted"]) {
    const deleted: string[] = [];
    const mod: PluginModule = {
      activate: (ctx) => {
        ctx.terminals!.registerBackend({
          id: "box",
          label: "Box",
          shell: "bash",
          spawn: async () => {
            throw new Error("not in this test");
          },
          onChatDeleted: async (e) => {
            await onChatDeleted?.(e);
            deleted.push(e.chatId);
          },
        });
      },
    };
    return { mod, deleted };
  }

  it("persists a failed delete, shows it on the plugin's row, and retries it until it succeeds", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "boxy", ["terminals"]);
    let reachable = false;
    const box = boxPlugin(() => {
      if (!reachable) throw new Error("ECONNREFUSED 10.0.0.20:8006");
    });
    const h = await host({ base, modules: { boxy: box.mod } });

    await h.registry.chatDeleted({ chatId: "gone", projectId: "p1" });
    const rows = h.cleanups.list("boxy");
    expect(rows).toEqual([
      expect.objectContaining({ plugin: "boxy", target: "box", hook: "onChatDeleted", chatId: "gone", projectId: "p1", attempts: 1 }),
    ]);
    expect(rows[0]!.lastError).toMatch(/ECONNREFUSED/);
    expect(h.svc.get("boxy")!.pendingCleanups).toMatchObject({ count: 1, attempts: 1, chats: ["gone"] });

    // Still down: a retry counts an attempt and pushes the next one out.
    await h.svc.retryCleanups("boxy").retrying;
    expect(h.cleanups.list("boxy")[0]).toMatchObject({ attempts: 2 });

    reachable = true;
    // Answers before the retry has run: the hook may take its whole timeout.
    const { info: during, retrying } = h.svc.retryCleanups("boxy");
    expect(during.pendingCleanups).toMatchObject({ count: 1 });
    await retrying;
    expect(box.deleted).toEqual(["gone"]);
    expect(h.cleanups.list("boxy")).toEqual([]);
    expect(h.svc.get("boxy")!.pendingCleanups).toBeUndefined();
    await h.svc.dispose();
  });

  it("survives a restart: the row is retried after the plugin's next activation and reconcile", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "boxy", ["terminals"]);
    const down = boxPlugin(() => {
      throw new Error("hypervisor down");
    });
    const h1 = await host({ base, modules: { boxy: down.mod } });
    await h1.registry.chatDeleted({ chatId: "gone" });
    expect(h1.cleanups.list()).toHaveLength(1);
    await h1.svc.dispose();
    h1.store.close();
    stores.splice(stores.indexOf(h1.store), 1);

    const up = boxPlugin(undefined);
    const h2 = await host({ base, modules: { boxy: up.mod } });
    await h2.svc.whenReconciled("boxy");
    expect(up.deleted).toEqual(["gone"]);
    expect(h2.cleanups.list()).toEqual([]);
    await h2.svc.dispose();
  });

  it("records a timeout, and withdraws the retry when the slow hook lands after all", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "boxy", ["terminals"]);
    const box = boxPlugin(() => tick(80));
    const h = await host({ base, modules: { boxy: box.mod }, hookTimeoutMs: 20 });
    await h.registry.chatDeleted({ chatId: "slow" });
    expect(h.cleanups.list()[0]).toMatchObject({ chatId: "slow" });
    expect(h.cleanups.list()[0]!.lastError).toMatch(/did not settle/);
    await tick(120);
    expect(box.deleted).toEqual(["slow"]);
    expect(h.cleanups.list()).toEqual([]);
    await h.svc.dispose();
  });

  it("leaves a row alone without counting an attempt while the plugin is off", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "boxy", ["terminals"]);
    const box = boxPlugin(() => {
      throw new Error("down");
    });
    const h = await host({ base, modules: { boxy: box.mod } });
    await h.registry.chatDeleted({ chatId: "gone" });
    await h.svc.setEnabled("boxy", false);
    await tick();
    const r = await h.cleanups.retry({ plugin: "boxy" });
    expect(r).toEqual({ ok: 0, failed: 0, skipped: 1 });
    expect(h.cleanups.list()[0]).toMatchObject({ attempts: 1 });
    await h.svc.dispose();
  });

  it("drops the plugin's rows when it is uninstalled", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "boxy", ["terminals"]);
    const box = boxPlugin(() => {
      throw new Error("down");
    });
    const h = await host({ base, modules: { boxy: box.mod } });
    await h.registry.chatDeleted({ chatId: "a" });
    await h.registry.chatDeleted({ chatId: "b" });
    // Another plugin's row must survive the uninstall.
    h.cleanups.failed({ plugin: "other", target: "x", hook: "onChatDeleted", chatId: "c" }, "nope");
    expect(h.cleanups.list("boxy")).toHaveLength(2);
    await h.svc.uninstall("boxy");
    expect(h.cleanups.list("boxy")).toEqual([]);
    expect(h.cleanups.list("other")).toHaveLength(1);
    await h.svc.dispose();
  });

  it("forgets rows on request without running them", async () => {
    const base = await paths();
    await writePlugin(base.configDir, "boxy", ["terminals"]);
    let calls = 0;
    const box = boxPlugin(() => {
      calls++;
      throw new Error("down");
    });
    const h = await host({ base, modules: { boxy: box.mod } });
    await h.registry.chatDeleted({ chatId: "a" });
    const info = await h.svc.discardCleanups("boxy");
    expect(info.pendingCleanups).toBeUndefined();
    expect(calls).toBe(1);
    await h.svc.dispose();
  });
});

describe("the cleanup summary", () => {
  it("shows the error of the most recently FAILED row, not the most backed-off one", async () => {
    const base = await paths();
    const h = await host({ base, modules: {} });
    let clock = 1_000_000;
    const q = new PluginCleanupQueue({ db: h.store.stateDb, run: async () => ({ ok: true }), now: () => clock });
    const key = (chatId: string) => ({ plugin: "p", target: "box", hook: "onChatDeleted" as const, chatId });
    // A: failing for hours, backed off furthest.
    for (let i = 0; i < 5; i++) q.failed(key("old"), "hypervisor timeout");
    // B: deleted a minute ago, one fresh and different failure.
    clock += 60_000;
    q.failed(key("new"), "401 unauthorized");
    expect(q.summary("p")).toMatchObject({ count: 2, attempts: 5, lastError: "401 unauthorized", chats: ["old", "new"] });
    await h.svc.dispose();
  });
});
