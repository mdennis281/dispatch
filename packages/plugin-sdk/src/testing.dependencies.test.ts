/**
 * `ctx.dependencies` / `ctx.provides` in the SDK's fakes, and `createTestHost`.
 *
 * The parity cases replay what the server's own suite asserts for the same
 * pair of modules (packages/server/src/plugins/dependencies.test.ts →
 * "ctx.provides / ctx.dependencies"): if the host's order changes, these
 * should change with it, or a plugin's tests pass against a host that no
 * longer exists.
 */
import { describe, expect, it } from "vitest";
import type { PluginCaller, PluginModule } from "./index.js";
import { isPluginCallError, isPluginRevokedError } from "./index.js";
import { createTestContext, createTestHost } from "./testing.js";

type Machines = { ping(): string; whoami(): string; subscribe(fn: () => void): void; boom(): never };

describe("createTestContext — a consumer's ctx.dependencies", () => {
  it("hands over the fake API through the host's membrane, once per export, refusing what is not declared", () => {
    const callers: PluginCaller[] = [];
    const t = createTestContext({
      id: "proxmox-terminal",
      capabilities: ["terminals"],
      dependencies: {
        "remote-host": {
          machines: {
            1: (caller: PluginCaller) => {
              callers.push(caller);
              return {
                ping: () => "pong",
                boom: () => {
                  throw Object.assign(new Error("no route"), { code: "unreachable" });
                },
              };
            },
          },
        },
      },
      optionalDependencies: ["remote-host"],
    });
    const deps = t.ctx.dependencies!;
    const api = deps.get<{ ping(): string; boom(): never }>("remote-host", "machines", 1)!;
    expect(api.ping()).toBe("pong");
    expect(deps.get("remote-host", "machines", 1)).toBe(api);
    expect(callers).toHaveLength(1);
    expect(callers[0]).toMatchObject({ id: "proxmox-terminal", capabilities: ["terminals"] });
    let thrown: unknown;
    try {
      api.boom();
    } catch (err) {
      thrown = err;
    }
    expect(isPluginCallError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ plugin: "remote-host", code: "unreachable", message: "remote-host: no route" });
    expect(() => deps.get("remote-host", "machines", 2)).toThrow(/does not list machines@2/);
    expect(() => deps.get("elsewhere", "machines", 1)).toThrow(/does not declare a dependency on "elsewhere"/);
    expect(deps.state("remote-host")).toEqual({ id: "remote-host", uses: ["machines@1"], optional: true, state: "ok", detail: "" });
    // Not declared: no member, as on the host.
    expect(t.ctx.provides).toBeUndefined();
    expect(createTestContext().ctx.dependencies).toBeUndefined();
  });

  it("an export declared but not served reads missing or not-served, and get hands out nothing", () => {
    const t = createTestContext({
      dependencies: { gone: { x: { 1: null } }, half: { a: { 1: {} }, b: { 2: null } } },
    });
    expect(t.ctx.dependencies!.get("gone", "x", 1)).toBeUndefined();
    expect(t.ctx.dependencies!.state("gone")?.state).toBe("missing");
    expect(t.ctx.dependencies!.state("half")).toMatchObject({ state: "not-served", detail: "half did not serve b@2" });
  });

  it("t.revoke: the API's methods throw revoked, callbacks and results go inert, get and state follow", async () => {
    let listener: (() => void) | undefined;
    let resolveLate!: (v: unknown) => void;
    const t = createTestContext({
      dependencies: {
        "remote-host": {
          machines: {
            1: {
              ping: () => "pong",
              subscribe: (fn: () => void) => void (listener = fn),
              handle: () => ({ kill: () => "killed" }),
              later: () => new Promise((r) => (resolveLate = r)),
            },
          },
        },
      },
    });
    const api = t.ctx.dependencies!.get<{
      ping(): string;
      subscribe(fn: () => void): void;
      handle(): { kill(): unknown };
      later(): Promise<unknown>;
    }>("remote-host", "machines", 1)!;
    const heard: string[] = [];
    api.subscribe(() => heard.push("event"));
    const h = api.handle();
    const inFlight = api.later();
    t.revoke("remote-host");
    let thrown: unknown;
    try {
      api.ping();
    } catch (err) {
      thrown = err;
    }
    expect(isPluginRevokedError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ message: "remote-host is no longer running" });
    expect(h.kill()).toBeUndefined();
    listener!();
    expect(heard).toEqual([]);
    resolveLate("late");
    await expect(inFlight).rejects.toMatchObject({ code: "revoked" });
    expect(t.ctx.dependencies!.get("remote-host", "machines", 1)).toBeUndefined();
    expect(t.ctx.dependencies!.state("remote-host")?.state).toBe("disabled");
  });

  it("t.lose: onLost runs while the API still works, then the link closes; a throwing listener fails the call", async () => {
    const t = createTestContext({ dependencies: { "remote-host": { machines: { 1: { ping: () => "pong" } } } } });
    const api = t.ctx.dependencies!.get<{ ping(): string }>("remote-host", "machines", 1)!;
    const seen: string[] = [];
    t.ctx.dependencies!.onLost("remote-host", () => {
      seen.push(`get=${typeof t.ctx.dependencies!.get("remote-host", "machines", 1)}`);
      seen.push(`ping=${api.ping()}`);
    });
    await t.lose("remote-host");
    expect(seen).toEqual(["get=undefined", "ping=pong"]);
    expect(() => api.ping()).toThrow(/no longer running/);

    const u = createTestContext({ dependencies: { p: { x: { 1: {} } } } });
    u.ctx.dependencies!.onLost("p", () => {
      throw new Error("listener bug");
    });
    await expect(u.lose("p")).rejects.toThrow("listener bug");
  });
});

describe("createTestContext — a provider's ctx.provides", () => {
  it("collects serve, checks it against the manifest, and t.callAs calls it as a given caller", () => {
    const t = createTestContext({
      id: "remote-host",
      provides: { machines: [1] },
      dependents: [{ id: "proxmox-terminal", installed: true, status: "active", uses: ["machines@1"] }],
    });
    const callers: PluginCaller[] = [];
    t.ctx.provides!.serve("machines", 1, (caller) => {
      callers.push(caller);
      return { whoami: () => caller.id };
    });
    expect(() => t.ctx.provides!.serve("machines", 1, () => ({}))).toThrow("machines@1 is already served");
    expect(() => t.ctx.provides!.serve("machines", 2, () => ({}))).toThrow(/does not declare provides.machines: \[2\]/);
    expect([...t.served.keys()]).toEqual(["machines@1"]);
    expect(t.ctx.provides!.dependents()).toEqual([{ id: "proxmox-terminal", installed: true, status: "active", uses: ["machines@1"] }]);

    const api = t.callAs<{ whoami(): string }>("proxmox-terminal", "machines", 1, { capabilities: ["terminals"] });
    expect(api.whoami()).toBe("proxmox-terminal");
    expect(t.callAs("proxmox-terminal", "machines", 1)).toBe(api);
    expect(callers[0]).toMatchObject({ id: "proxmox-terminal", capabilities: ["terminals"] });
    expect(Object.isFrozen(callers[0])).toBe(true);
    // The first callAs sealed the exports, as activate resolving does on the host.
    expect(() => t.ctx.provides!.serve("machines", 1, () => ({}))).toThrow(/only while activate\(\) runs/);
    expect(() => t.callAs("x", "machines", 9)).toThrow(/does not serve machines@9/);

    // That consumer going away: its signal aborts, its API is revoked.
    t.revoke("proxmox-terminal");
    expect(callers[0]!.signal.aborted).toBe(true);
    expect(() => api.whoami()).toThrow(/proxmox-terminal is no longer running, and its link to remote-host is closed/);
  });

  it("a factory that hands back a promise is refused, blamed on the provider", () => {
    const t = createTestContext({ id: "p", provides: { x: [1] } });
    t.ctx.provides!.serve("x", 1, (async () => ({})) as never);
    expect(() => t.callAs("c", "x", 1)).toThrow("p: the x@1 factory must return the API object, synchronously");
  });
});

/** The server suite's pair, module for module. */
function pair(log: string[]) {
  const callers: PluginCaller[] = [];
  let listener: (() => void) | undefined;
  const held: { api?: Machines } = {};
  const prov: PluginModule = {
    activate: (ctx) => {
      ctx.provides!.serve("machines", 1, (caller) => {
        callers.push(caller);
        caller.signal.addEventListener("abort", () => log.push(`prov:signal-aborted:${caller.id}`));
        return {
          ping: () => "pong",
          whoami: () => caller.id,
          subscribe: (fn: () => void) => void (listener = fn),
          boom: () => {
            throw new Error("boom");
          },
        };
      });
    },
    onShutdown: (e) => void log.push(`prov:onShutdown:${e.reason}`),
    deactivate: () => {
      log.push("prov:deactivate");
      listener?.();
    },
  };
  const cons: PluginModule = {
    activate: (ctx) => {
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
  return { callers, held, prov, cons };
}

describe("createTestHost — parity with the host", () => {
  const manifests = (optional: boolean) => ({
    prov: { id: "prov", provides: { machines: [1] } },
    cons: { id: "cons", dependencies: { prov: { uses: ["machines@1"], ...(optional ? { optional: true } : {}) } } },
  });

  it("switching a provider off: optional dependent hears first, link closes after the provider's teardown", async () => {
    const log: string[] = [];
    const p = pair(log);
    const m = manifests(true);
    // Listed consumer-first: the host's resolver, not the list, decides the order.
    const host = createTestHost([
      { manifest: m.cons, module: p.cons },
      { manifest: m.prov, module: p.prov },
    ]);
    expect(host.order).toEqual(["prov", "cons"]);
    await host.start();
    expect(host.status("cons")).toBe("active");
    const api = p.held.api!;
    await host.disable("prov");
    expect(log).toEqual([
      "cons:onLost",
      "cons:onLost:get=undefined",
      "cons:onLost:ping=pong",
      "prov:onShutdown:disable",
      "prov:deactivate",
      "cons:callback",
      "prov:signal-aborted:cons",
    ]);
    expect(host.status("cons")).toBe("active");
    expect(host.status("prov")).toBe("disabled");
    expect(() => api.ping()).toThrow("prov is no longer running");
    expect(host.context("cons").ctx.dependencies!.state("prov")?.state).toBe("disabled");
  });

  it("switching a REQUIRED provider off takes the consumer down first, as a disable, and leaves it blocked", async () => {
    const log: string[] = [];
    const p = pair(log);
    const m = manifests(false);
    const host = createTestHost([
      { manifest: m.prov, module: p.prov },
      { manifest: m.cons, module: p.cons },
    ]);
    await host.start();
    await host.disable("prov");
    expect(log).toEqual([
      "cons:onShutdown:disable",
      "cons:onShutdown:ping=pong",
      "cons:deactivate",
      "prov:signal-aborted:cons",
      "prov:onShutdown:disable",
      "prov:deactivate",
    ]);
    expect(host.status("cons")).toBe("blocked");
    expect(host.reason("cons")).toBe("needs prov, which was switched off");
  });

  it("stop: the consumer's hook runs with the link open, before the provider's; deactivation in reverse", async () => {
    const log: string[] = [];
    const p = pair(log);
    const m = manifests(false);
    const host = createTestHost([
      { manifest: m.prov, module: p.prov },
      { manifest: m.cons, module: p.cons },
    ]);
    await host.start();
    await host.stop();
    expect(log).toEqual([
      "cons:onShutdown:stop",
      "cons:onShutdown:ping=pong",
      "prov:onShutdown:stop",
      "cons:deactivate",
      "prov:signal-aborted:cons",
      "prov:deactivate",
    ]);
  });

  it("blocks what requires a missing, failed or unserving provider; starts what only likes it", async () => {
    const host = createTestHost([
      { manifest: { id: "needs-missing", dependencies: { nowhere: { uses: ["x@1"] } } }, module: { activate: () => {} } },
      { manifest: { id: "throws", provides: { t: [1] } }, module: { activate: () => Promise.reject(new Error("boom")) } },
      { manifest: { id: "needs-throws", dependencies: { throws: { uses: ["t@1"] } } }, module: { activate: () => {} } },
      { manifest: { id: "lazy", provides: { l: [1] } }, module: { activate: () => {} } },
      { manifest: { id: "needs-lazy", dependencies: { lazy: { uses: ["l@1"] } } }, module: { activate: () => {} } },
      { manifest: { id: "likes-lazy", dependencies: { lazy: { uses: ["l@1"], optional: true } } }, module: { activate: () => {} } },
    ]);
    await host.start();
    expect(host.reason("needs-missing")).toBe("needs nowhere (x@1): nowhere is not installed");
    expect(host.status("throws")).toBe("error");
    expect(host.reason("needs-throws")).toBe("needs throws (t@1): throws failed to start: boom");
    expect(host.reason("needs-lazy")).toBe("needs lazy (l@1): lazy did not serve l@1");
    expect(host.status("likes-lazy")).toBe("active");
    expect(host.context("likes-lazy").ctx.dependencies!.state("lazy")?.state).toBe("not-served");
  });
});
