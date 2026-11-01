import { describe, it, expect, vi } from "vitest";
import type { ClientHost, PluginInfo, PluginInstance } from "@dispatch/shared";
import { createClientHost } from "./host.js";
import { clientModuleOf, loadClientPlugins, loadable, type LoadDeps } from "./loader.js";

function row(id: string, extra: Partial<PluginInfo> = {}): PluginInfo {
  return {
    id,
    name: id,
    dir: `/plugins/${id}`,
    status: "active",
    enabled: true,
    capabilities: ["ui"],
    hasServer: false,
    clientUrl: `/plugins/${id}/index.js`,
    settings: {},
    origin: "unknown",
    ...extra,
  };
}

function deps(rows: PluginInfo[], modules: Record<string, unknown>): LoadDeps & { toasts: string[]; installs: number; hosts: string[] } {
  const d = {
    toasts: [] as string[],
    installs: 0,
    hosts: [] as string[],
    list: async () => rows,
    importModule: async (url: string) => {
      const m = modules[url];
      if (m instanceof Error) throw m;
      return m;
    },
    installDeps: async () => {
      d.installs++;
    },
    toast: (text: string, detail?: string) => {
      d.toasts.push(`${text}: ${detail ?? ""}`);
    },
    makeHost: (id: string) => {
      d.hosts.push(id);
      return { pluginId: id } as unknown as ClientHost;
    },
  };
  return d;
}

describe("loadable", () => {
  it("takes only ACTIVE plugins with a client, in id order", () => {
    const rows = [
      row("zeta"),
      row("alpha"),
      row("broken", { status: "error" }),
      row("off", { status: "disabled" }),
      row("serverless", { clientUrl: undefined }),
    ];
    expect(loadable(rows).map((p) => p.id)).toEqual(["alpha", "zeta"]);
  });
});

describe("clientModuleOf", () => {
  it("finds activate on the namespace, a default export, or a `plugin` export", () => {
    const a = { activate() {} };
    expect(clientModuleOf(a)).toBe(a);
    expect(clientModuleOf({ default: a })).toBe(a);
    expect(clientModuleOf({ plugin: a })).toBe(a);
    expect(clientModuleOf({ activate: 1 })).toBeUndefined();
    expect(clientModuleOf(null)).toBeUndefined();
  });
});

describe("loadClientPlugins", () => {
  it("isolates a failing import and a throwing activate: a toast names the plugin, the next one still loads", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const activated: string[] = [];
    const d = deps([row("a"), row("b"), row("c"), row("d")], {
      "/plugins/a/index.js": new Error("404 Not Found"),
      "/plugins/b/index.js": { activate: (host: ClientHost) => activated.push(host.pluginId) },
      "/plugins/c/index.js": {
        activate: () => {
          throw new Error("slot taken");
        },
      },
      "/plugins/d/index.js": { nope: true },
    });
    const result = await loadClientPlugins(d);
    expect(result).toEqual({ loaded: ["b"], failed: ["a", "c", "d"] });
    expect(activated).toEqual(["b"]);
    expect(d.toasts).toEqual([
      'Plugin "a" failed to load: 404 Not Found',
      'Plugin "c" failed to load: slot taken',
      'Plugin "d" failed to load: the client entry does not export activate()',
    ]);
    // The shim is installed once, before the first import.
    expect(d.installs).toBe(1);
    err.mockRestore();
  });

  it("does nothing — not even install the shim — when no plugin has a client", async () => {
    const d = deps([row("x", { clientUrl: undefined })], {});
    expect(await loadClientPlugins(d)).toEqual({ loaded: [], failed: [] });
    expect(d.installs).toBe(0);
  });

  it("a failed list is quiet: no toast, nothing loaded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps([], {});
    d.list = async () => {
      throw new Error("401");
    };
    expect(await loadClientPlugins(d)).toEqual({ loaded: [], failed: [] });
    expect(d.toasts).toEqual([]);
    warn.mockRestore();
  });
});

describe("host.instance", () => {
  const me: PluginInstance = { id: "inst-1", role: "dev", dataDirFingerprint: "fp", previousId: "inst-0" };

  it("is read once, alongside the list, and every host carries it", async () => {
    const seen: Array<[string, PluginInstance | undefined]> = [];
    const activate = (h: ClientHost) => {
      seen.push([h.pluginId, h.instance]);
    };
    const d = deps([row("a"), row("b")], { "/plugins/a/index.js": { activate }, "/plugins/b/index.js": { activate } });
    d.makeHost = createClientHost;
    let reads = 0;
    d.instance = async () => {
      reads++;
      return me;
    };
    expect(await loadClientPlugins(d)).toEqual({ loaded: ["a", "b"], failed: [] });
    expect(seen).toEqual([
      ["a", me],
      ["b", me],
    ]);
    expect(reads).toBe(1);
  });

  it("a failed read leaves it absent and loads every plugin anyway", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hosts: ClientHost[] = [];
    const d = deps([row("a")], { "/plugins/a/index.js": { activate: (h: ClientHost) => hosts.push(h) } });
    d.makeHost = createClientHost;
    d.instance = async () => {
      throw new Error("500");
    };
    expect(await loadClientPlugins(d)).toEqual({ loaded: ["a"], failed: [] });
    expect("instance" in hosts[0]!).toBe(false);
    expect(d.toasts).toEqual([]);
    warn.mockRestore();
  });
});
