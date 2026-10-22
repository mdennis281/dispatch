/**
 * Plugin contributions, end to end over `examples/plugins/contributions`:
 * reading each kind, the rules the reader is the chokepoint for (reserved
 * names, capability gating, the plugin-dir cwd, the secrets allowlist), the
 * session selector the broker's two merge sites share, and processes through
 * a RunnerService with a fake spawn — autostart, owner, env quarantine, stop
 * on deactivate, and singleton adoption.
 */
import { describe, it, expect, afterEach } from "vitest";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { PluginManifestSchema, type PluginContext } from "@dispatch/shared";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import { RunnerService, type ChildLike, type SpawnFn } from "../services/runner.js";
import { PluginService } from "./service.js";
import { PluginProcessHost, toSubApp, type PluginProcessRunner } from "./processes.js";
import {
  expandPluginSecrets,
  mergeDeclaredMcpServers,
  readPluginContributions,
  selectPluginMcpServers,
  type PluginMcpDeclaration,
} from "./contributions.js";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = resolve(here, "../../../../examples/plugins/contributions");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(prefix = "dispatch-contrib-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A synthetic plugin dir: manifest + whatever files the case needs. */
async function writePlugin(
  root: string,
  id: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
): Promise<string> {
  const dir = join(root, "plugins", id);
  await mkdir(dir, { recursive: true });
  const yaml = Object.entries({ id, name: id, version: "1.0.0", dispatch: ">=1", ...manifest })
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  await writeFile(join(dir, "plugin.yaml"), `${yaml}\n`);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

const manifestOf = (m: Record<string, unknown>) => PluginManifestSchema.parse(m);

/* ------------------------------------------------------------------ reader */

describe("readPluginContributions — the example plugin", () => {
  it("reads one of every kind, with the plugin dir as the server cwd and no warnings", async () => {
    const manifest = manifestOf({
      id: "contributions",
      name: "x",
      version: "0.1.0",
      dispatch: ">=1",
      capabilities: ["mcp", "process"],
      secrets: ["CONTRIB_ECHO_TOKEN"],
      contributes: {
        modes: "./modes",
        skills: "./skills",
        instructions: "./instructions",
        personas: "./personas",
        mcpServers: "./mcp.yaml",
        processes: "./processes.yaml",
      },
    });
    const c = await readPluginContributions("contributions", EXAMPLE, manifest);
    expect(c.warnings).toEqual([]);
    expect(c.skills.map((s) => s.dir)).toEqual(["plugin-hello"]);
    expect(c.instructions.map((i) => i.name)).toEqual(["contributions-plugin"]);
    expect(c.personas.map((p) => p.name)).toEqual(["plugin-reviewer"]);
    expect(c.modes).toEqual([
      expect.objectContaining({ id: "careful", scope: "plugin", pluginId: "contributions", permissionMode: "plan" }),
    ]);
    expect(c.mcpServers).toHaveLength(1);
    const echo = c.mcpServers[0]!;
    expect(echo.name).toBe("contrib-echo");
    expect(echo.pluginId).toBe("contributions");
    // The plugin-dir default, not the chat's tree.
    expect(echo.config.cwd).toBe(EXAMPLE);
    // Secrets stay PLACEHOLDERS until the hand-off.
    expect(echo.config.env?.ECHO_TOKEN).toBe("${secret:CONTRIB_ECHO_TOKEN}");
    expect(echo.secrets).toEqual(["CONTRIB_ECHO_TOKEN"]);
    expect(c.processes).toEqual([
      expect.objectContaining({ id: "hello-http", autostart: true, singleton: true, ports: [47311] }),
    ]);
  });
});

describe("readPluginContributions — rules", () => {
  it("refuses a dispatch-* server name through the project chokepoint, and keeps the rest", async () => {
    const root = await scratch();
    const dir = await writePlugin(
      root,
      "p",
      { capabilities: ["mcp"], contributes: { mcpServers: "./mcp.yaml" } },
      {
        "mcp.yaml":
          "mcpServers:\n" +
          "  - name: dispatch-github\n    transport: { type: stdio, command: node }\n" +
          "  - name: fine\n    transport: { type: stdio, command: node }\n",
      },
    );
    const c = await readPluginContributions("p", dir, manifestOf({ id: "p", name: "p", version: "1.0.0", dispatch: ">=1", capabilities: ["mcp"], contributes: { mcpServers: "./mcp.yaml" } }));
    expect(c.mcpServers.map((s) => s.name)).toEqual(["fine"]);
    expect(c.warnings).toEqual([expect.stringMatching(/dispatch-github.*reserved/)]);
  });

  it("ignores mcpServers and processes when the matching capability is not declared", async () => {
    const root = await scratch();
    const manifest = {
      contributes: { mcpServers: "./mcp.yaml", processes: "./processes.yaml" },
    };
    const dir = await writePlugin(root, "nocap", manifest, {
      "mcp.yaml": "- name: a\n  transport: { type: stdio, command: node }\n",
      "processes.yaml": "- id: a\n  command: node\n",
    });
    const c = await readPluginContributions("nocap", dir, manifestOf({ id: "nocap", name: "n", version: "1.0.0", dispatch: ">=1", ...manifest }));
    expect(c.mcpServers).toEqual([]);
    expect(c.processes).toEqual([]);
    expect(c.warnings).toEqual([
      expect.stringMatching(/mcpServers.*"mcp" capability/),
      expect.stringMatching(/processes.*"process" capability/),
    ]);
  });

  it("resolves an explicit relative cwd against the plugin dir, never the session", async () => {
    const root = await scratch();
    const manifest = { capabilities: ["mcp"], contributes: { mcpServers: "./mcp.yaml" } };
    const dir = await writePlugin(root, "cwd", manifest, {
      "mcp.yaml": "- name: a\n  transport: { type: stdio, command: node, cwd: ./srv }\n",
    });
    const c = await readPluginContributions("cwd", dir, manifestOf({ id: "cwd", name: "c", version: "1.0.0", dispatch: ">=1", ...manifest }));
    expect(c.mcpServers[0]!.config.cwd).toBe(join(dir, "srv"));
  });

  it("warns about a secret the manifest does not list, and about a malformed file, without failing the rest", async () => {
    const root = await scratch();
    const manifest = { capabilities: ["mcp", "process"], contributes: { mcpServers: "./mcp.yaml", processes: "./processes.yaml", skills: "./skills" } };
    const dir = await writePlugin(root, "warn", manifest, {
      "mcp.yaml": "- name: a\n  transport: { type: http, url: 'https://x', headers: { Authorization: '${secret:NOT_LISTED}' } }\n",
      "processes.yaml": "processes: [ { id: 'Bad Id', command: node } ]\n",
      "skills/s/SKILL.md": "---\nname: s\ndescription: d\n---\nbody\n",
    });
    const c = await readPluginContributions("warn", dir, manifestOf({ id: "warn", name: "w", version: "1.0.0", dispatch: ">=1", ...manifest }));
    expect(c.skills.map((s) => s.dir)).toEqual(["s"]);
    expect(c.mcpServers).toHaveLength(1);
    expect(c.processes).toEqual([]);
    expect(c.warnings).toEqual([
      expect.stringMatching(/NOT_LISTED/),
      expect.stringMatching(/processes.*id/),
    ]);
  });

  it("a singleton without ports is a schema error, not a process that silently never adopts", async () => {
    const root = await scratch();
    const manifest = { capabilities: ["process"], contributes: { processes: "./processes.yaml" } };
    const dir = await writePlugin(root, "single", manifest, {
      "processes.yaml": "- id: a\n  command: node\n  singleton: true\n",
    });
    const c = await readPluginContributions("single", dir, manifestOf({ id: "single", name: "s", version: "1.0.0", dispatch: ">=1", ...manifest }));
    expect(c.processes).toEqual([]);
    expect(c.warnings[0]).toMatch(/singleton.*port/);
  });
});

/* --------------------------------------------------------------- selectors */

const decl = (over: Partial<PluginMcpDeclaration> & { name: string }): PluginMcpDeclaration => ({
  pluginId: "p",
  config: { type: "stdio", command: "node", env: { T: "${secret:LISTED}", U: "${secret:UNLISTED}" } },
  byDefault: true,
  defaultReason: "declared",
  secrets: ["LISTED"],
  ...over,
});

describe("selectPluginMcpServers", () => {
  it("expands only listed secrets; an unlisted one is blanked and reported, never left for the project resolver", () => {
    const refused: string[] = [];
    const out = selectPluginMcpServers([decl({ name: "a" })], undefined, (n) => (n === "LISTED" ? "tok" : "LEAK"), (_p, _s, n) =>
      refused.push(n),
    );
    expect(out.a!.env).toEqual({ T: "tok", U: "" });
    expect(refused).toEqual(["UNLISTED"]);
  });

  it("uses the plugin's toggle as the default layer and lets an mcpEnabled pin override it either way", () => {
    const on = decl({ name: "on", byDefault: true });
    const off = decl({ name: "off", byDefault: false });
    expect(Object.keys(selectPluginMcpServers([on, off], undefined))).toEqual(["on"]);
    // A project pin switches the disabled plugin's server back on, and the
    // enabled one off — the pin outranks the default, as for the browser gate.
    expect(Object.keys(selectPluginMcpServers([on, off], { project: { on: false, off: true } }))).toEqual(["off"]);
    // The runtime layers apply too — a model pin is the narrowest claim.
    expect(Object.keys(selectPluginMcpServers([on], { model: { on: false } }))).toEqual([]);
  });

  it("gives a name two plugins both declare to the first one", () => {
    const out = selectPluginMcpServers(
      [decl({ name: "dup", pluginId: "a", config: { type: "stdio", command: "first" } }), decl({ name: "dup", pluginId: "b", config: { type: "stdio", command: "second" } })],
      undefined,
    );
    expect(out.dup!.command).toBe("first");
  });

  it("expandPluginSecrets leaves non-secret text and ${VAR} alone", () => {
    expect(expandPluginSecrets("a ${VAR} ${secret:X} b", ["X"], () => "v")).toBe("a ${VAR} v b");
  });
});

describe("mergeDeclaredMcpServers", () => {
  it("layers bundled < plugin < project < config, by name", () => {
    const out = mergeDeclaredMcpServers({
      bundled: { shared: "bundled", pw: "bundled" },
      plugin: { shared: "plugin", pl: "plugin" },
      project: { shared: "project", pr: "project" },
      config: { shared: "config" },
    });
    expect(out).toEqual({ shared: "config", pw: "bundled", pl: "plugin", pr: "project" });
  });
});

/* ------------------------------------------------------------- the service */

function stubContext(): ConstructorParameters<typeof PluginService>[0]["context"] {
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

class MockChild extends EventEmitter implements ChildLike {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(): boolean {
    this.emit("exit", 0, null);
    return true;
  }
}

async function harness(opts: { enabled?: boolean; portFree?: () => Promise<boolean>; withRunner?: boolean } = {}) {
  const base = await scratch();
  const configDir = join(base, "config");
  const dataDir = join(base, "data");
  await mkdir(join(configDir, "plugins"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await cp(EXAMPLE, join(configDir, "plugins", "contributions"), { recursive: true });
  if (opts.enabled === false) {
    await writeFile(join(configDir, "config.json"), JSON.stringify({ plugins: { contributions: { enabled: false } } }));
  }
  const store = new Store(dataDir, configDir);
  await store.init();
  const bus = new EventBus();
  const spawns: Array<{ command: string; cwd: string; env: Record<string, string> }> = [];
  const children: MockChild[] = [];
  const killed: number[] = [];
  const spawn: SpawnFn = (command, o) => {
    spawns.push({ command, cwd: o.cwd, env: o.env });
    const child = new MockChild();
    children.push(child);
    return child;
  };
  const runner = new RunnerService({
    store,
    bus,
    spawn,
    getPort: async (preferred) => preferred ?? 9999,
    killTree: async (pid) => {
      killed.push(pid);
      for (const c of children) c.kill();
    },
    // The one var the quarantine exists for, planted so the test can watch it vanish.
    parentEnv: { PATH: "x", DISPATCH_DATA_DIR: "C:/elsewhere/data" },
  });
  const svc = new PluginService({
    configDir,
    store,
    context: stubContext(),
    runner: opts.withRunner === false ? undefined : runner,
    portFree: opts.portFree ?? (async () => true),
    log: () => {},
    fault: () => {},
  });
  await svc.load();
  return { svc, store, runner, spawns, children, killed, configDir };
}

describe("PluginService — contributions", () => {
  it("surfaces every kind for an enabled plugin, tagged with its id", async () => {
    const { svc, store } = await harness();
    expect(svc.skills()).toEqual([{ pluginId: "contributions", skill: expect.objectContaining({ dir: "plugin-hello" }) }]);
    expect(svc.instructions().map((i) => i.file.name)).toEqual(["contributions-plugin"]);
    expect(svc.personas().map((p) => p.file.name)).toEqual(["plugin-reviewer"]);
    expect(svc.modes()).toEqual([expect.objectContaining({ id: "careful", scope: "plugin", pluginId: "contributions" })]);
    expect(svc.mcpServers()).toEqual([
      expect.objectContaining({ name: "contrib-echo", byDefault: true, defaultReason: expect.stringContaining("contributions") }),
    ]);
    expect(svc.get("contributions")!.warnings).toBeUndefined();
    await svc.dispose();
    store.close();
  });

  it("a disabled plugin contributes nothing — except its MCP row, listed with the toggle as its default", async () => {
    const { svc, store } = await harness({ enabled: false });
    expect(svc.skills()).toEqual([]);
    expect(svc.instructions()).toEqual([]);
    expect(svc.personas()).toEqual([]);
    expect(svc.modes()).toEqual([]);
    expect(svc.mcpServers()).toEqual([
      expect.objectContaining({ name: "contrib-echo", byDefault: false, defaultReason: expect.stringMatching(/switched off/) }),
    ]);
    await svc.dispose();
    store.close();
  });

  it("reports contribution problems on the plugin row without failing activation", async () => {
    const { svc, store, configDir } = await harness();
    await writePlugin(
      configDir,
      "broken-contrib",
      { capabilities: ["mcp"], contributes: { mcpServers: "./missing.yaml" } },
    );
    await svc.load();
    await svc.activateAll();
    expect(svc.get("broken-contrib")).toMatchObject({
      status: "active",
      warnings: [expect.stringMatching(/missing\.yaml does not exist/)],
    });
    await svc.dispose();
    store.close();
  });
});

describe("PluginService — processes", () => {
  it("autostarts on activate with owner plugin:<id>, PORT injected, the manager env scrubbed, and stops on dispose", async () => {
    const { svc, store, runner, spawns, killed } = await harness();
    await svc.activateAll();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.command).toBe("node ./process/server.mjs");
    expect(spawns[0]!.env.PORT).toBe("47311");
    expect(spawns[0]!.env.DISPATCH_DATA_DIR).toBeUndefined();
    expect(spawns[0]!.env.PATH).toBe("x");
    const rows = await runner.list();
    expect(rows).toEqual([
      expect.objectContaining({ owner: "plugin:contributions", subAppId: "hello-http", status: "running", port: 47311, url: "http://localhost:47311" }),
    ]);
    // A second activation of the same plugin does not double it.
    expect((await svc.get("contributions"))!.status).toBe("active");

    await svc.dispose();
    expect(killed).toEqual([4242]);
    await new Promise((r) => setTimeout(r, 30));
    expect((await runner.list())[0]!.status).toBe("stopped");
    store.close();
  });

  it("toggling the plugin off stops its process; without a runner nothing is declared started", async () => {
    const { svc, store, runner, killed } = await harness();
    await svc.activateAll();
    await svc.setEnabled("contributions", false);
    expect(killed).toEqual([4242]);
    await new Promise((r) => setTimeout(r, 30));
    expect((await runner.list())[0]!.status).toBe("stopped");
    store.close();

    const bare = await harness({ withRunner: false });
    await bare.svc.activateAll();
    expect(bare.spawns).toEqual([]);
    expect(bare.svc.get("contributions")!.status).toBe("active");
    await bare.svc.dispose();
    bare.store.close();
  });

  it("a singleton whose port is already taken is ADOPTED, not spawned, and stop() kills nothing", async () => {
    const { svc, store, runner, spawns, killed } = await harness({ portFree: async () => false });
    await svc.activateAll();
    expect(spawns).toEqual([]);
    const [row] = await runner.list();
    expect(row).toMatchObject({ adopted: true, status: "running", port: 47311, owner: "plugin:contributions" });
    expect(row!.pid).toBeUndefined();
    await svc.dispose();
    expect(killed).toEqual([]);
    expect((await runner.list())[0]!.status).toBe("stopped");
    store.close();
  });

  it("hands ctx.processes to a module only with the process capability, and list() reflects the runner", async () => {
    const { svc, store, configDir } = await harness();
    const seen: Record<string, unknown> = {};
    const module = {
      activate: async (ctx: PluginContext) => {
        seen.processes = ctx.processes ? await ctx.processes.list() : undefined;
      },
    };
    await writePlugin(
      configDir,
      "with-cap",
      { server: "./server/index.js", capabilities: ["process"], contributes: { processes: "./processes.yaml" } },
      { "processes.yaml": "- id: idle\n  command: node\n", "server/index.js": "" },
    );
    await writePlugin(
      configDir,
      "without-cap",
      { server: "./server/index.js" },
      { "server/index.js": "" },
    );
    const svc2 = new PluginService({
      configDir,
      store,
      context: stubContext(),
      runner: svc["processHost"] ? (svc as unknown as { processHost: { runner: PluginProcessRunner } }).processHost.runner : undefined,
      importModule: async () => module,
      log: () => {},
      fault: () => {},
    });
    await svc.dispose();
    await svc2.load();
    await svc2.activateAll();
    // `with-cap` activated last alphabetically? No — ids sort: contributions, with-cap, without-cap.
    // `seen` holds the LAST module's answer, which is without-cap's: undefined.
    expect(seen.processes).toBeUndefined();
    // Drive with-cap's binding directly through the host to prove the shape.
    const host = (svc2 as unknown as { processHost: PluginProcessHost }).processHost;
    expect(await host.list("with-cap")).toEqual([{ id: "idle", status: "stopped" }]);
    await svc2.dispose();
    store.close();
  });
});

describe("PluginProcessHost", () => {
  it("start() is idempotent against a running instance and stop() is a no-op when nothing runs", async () => {
    const rows: Array<{ id: string; owner?: string; subAppId: string; status: string }> = [];
    const stopped: string[] = [];
    const runner: PluginProcessRunner = {
      start: async (_wt, subApp, ctx) => {
        const row = { id: `r${rows.length}`, owner: ctx.owner, subAppId: subApp.id, status: "running" };
        rows.push(row);
        return row as never;
      },
      adopt: async () => {
        throw new Error("not a singleton");
      },
      stop: async (id) => {
        stopped.push(id);
        rows.find((r) => r.id === id)!.status = "stopped";
      },
      list: async () => rows as never,
    };
    const host = new PluginProcessHost({ runner });
    host.register("p", "C:/p", [{ id: "a", command: "node", args: ["x.js"] }]);
    await host.start("p", "a");
    await host.start("p", "a");
    expect(rows).toHaveLength(1);
    await host.stop("p", "a");
    await host.stop("p", "a");
    expect(stopped).toEqual(["r0"]);
    await expect(host.start("p", "nope")).rejects.toThrow(/declares no process "nope"/);
  });

  it("toSubApp joins command and args verbatim — the author quotes, as in a sub-app's dev line", () => {
    expect(toSubApp({ id: "a", command: "node", args: ["./s.mjs", "--name", '"hello world"', "{port}"] }).dev).toBe(
      'node ./s.mjs --name "hello world" {port}',
    );
    // A Windows path is left exactly as written: no escaping pass can be right
    // for both cmd.exe and sh, so none is attempted.
    expect(toSubApp({ id: "b", command: "C:\\tools\\run.exe", args: ["--dir", "C:\\data"] }).dev).toBe(
      "C:\\tools\\run.exe --dir C:\\data",
    );
  });
});
