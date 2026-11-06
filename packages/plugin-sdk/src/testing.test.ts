/**
 * The fake context against the plugins that ship as examples: hello-server
 * (plain JS, every basic seam) through `createTestContext` end to end, plus
 * the members no example exercises. If the host's `PluginContext` grows a
 * member the fake lacks, `ctx: PluginContext` stops compiling — which is the
 * point of typing the fake against the real interface.
 */
import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_INSTANCE, createTestContext } from "./testing.js";
import { definePlugin } from "./index.js";
import { PLUGIN_RECONCILE_BUDGET_MS, PLUGIN_SHUTDOWN_BUDGET_MS } from "./manifest.js";
import type { Harness, ProviderDescriptor } from "./index.js";
import type { PluginModule } from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const HELLO = resolve(here, "../../../examples/plugins/hello-server/server/index.js");

async function helloServer(): Promise<PluginModule> {
  return (await import(pathToFileURL(HELLO).href)) as PluginModule;
}

describe("createTestContext with examples/plugins/hello-server", () => {
  it("activates, serves its routes with :params and bodies, counts bus events into kv, and emits", async () => {
    const t = createTestContext({ id: "hello-server", version: "0.1.0", capabilities: ["events", "routes", "kv"] });
    const mod = await helloServer();
    await mod.activate(t.ctx);

    expect(t.emitted).toEqual([{ payload: { hello: true, version: "0.1.0" } }]);
    expect(t.routes.list()).toEqual(["GET /hello", "GET /chats/:chatId", "POST /echo"]);

    const hello = await t.routes.call("GET", "/hello");
    expect(hello.status).toBe(200);
    expect(hello.body).toMatchObject({ greeting: "hello", tone: "friendly", seen: 0 });

    expect((await t.routes.call("GET", "/chats/abc")).body).toEqual({ chatId: "abc" });
    expect((await t.routes.call("POST", "/echo", { body: { x: 1 } })).body).toEqual({ echoed: { x: 1 } });

    t.publish({ type: "chat-message", chatId: "c1", message: { kind: "user", id: "m1", chatId: "c1", ts: 1, text: "hi" } });
    expect((await t.routes.call("GET", "/hello")).body).toMatchObject({ seen: 1 });
    // Written through to kv, so a restart would resume the count.
    expect(t.kv.get("seen")).toBe(1);

    t.settings.set({ greeting: "yo", shout: true, repeat: 2 });
    expect((await t.routes.call("GET", "/hello")).body).toMatchObject({ greeting: "YO YO" });
    expect(t.log.at(-1)).toMatchObject({ level: "info", message: expect.stringContaining("settings changed") });

    await mod.deactivate?.();
    expect(t.listenerCount()).toBe(0);
  });

  it("lets a plugin write its own settings with the host's patch and schema rules", async () => {
    const t = createTestContext({
      settings: { label: "x", port: "eighty" },
      settingsSchema: { type: "object", properties: { label: { type: "string" }, port: { type: "integer" }, hosts: { type: "array" } } },
    });
    const heard: unknown[] = [];
    t.ctx.settings.onChange((next) => heard.push(next));

    // A key stored before the schema said otherwise does not block a write that leaves it alone.
    await expect(t.ctx.settings.set!({ hosts: [{ id: "cvx-mac" }] })).resolves.toEqual({ label: "x", port: "eighty", hosts: [{ id: "cvx-mac" }] });
    // Changing it into something else the schema refuses does — and stores nothing.
    await expect(t.ctx.settings.set!({ port: "ninety", label: "y" })).rejects.toThrow(/port/);
    await t.ctx.settings.set!({ label: null });
    // An unchanged write is not a change.
    await t.ctx.settings.set!({ hosts: [{ id: "cvx-mac" }] });

    expect(t.settings.get()).toEqual({ port: "eighty", hosts: [{ id: "cvx-mac" }] });
    expect(heard).toHaveLength(2);
  });

  it("hands a plugin exactly the members its capabilities name", async () => {
    const t = createTestContext({ capabilities: ["routes"] });
    expect(t.ctx.routes).toBeDefined();
    expect(t.ctx.bus).toBeUndefined();
    expect(t.ctx.kv).toBeUndefined();
    expect(t.ctx.chats).toBeUndefined();
    // So hello-server, which declares `events`, throws the same way it would on the host.
    const mod = await helloServer();
    await expect(mod.activate(t.ctx)).rejects.toThrow();
  });

  it("throws for an unregistered route, naming what exists", async () => {
    const t = createTestContext();
    t.ctx.routes!((r) => r.get("/a", () => "a"));
    await expect(t.routes.call("GET", "/b")).rejects.toThrow(/have: GET \/a/);
  });
});

describe("the members no example reaches", () => {
  it("records sends, asks and replies, and answers only question items", async () => {
    const t = createTestContext({
      chats: [{ id: "c1", title: "Fix the build", projectId: "p1", createdAt: 1, updatedAt: 2 }],
      answerAsk: (_chat, q) => (q.includes("ship") ? "yes" : undefined),
    });
    const chats = t.ctx.chats!;
    expect(await chats.list!()).toHaveLength(1);
    expect(await chats.find!({ query: "build" })).toHaveLength(1);
    expect(await chats.find!({ query: "nope" })).toHaveLength(0);
    expect((await chats.state!("c1"))?.status).toBe("idle");
    expect(await chats.state!("missing")).toBeNull();

    expect(await chats.send!("c1", "hello", { delivery: "interrupt" })).toEqual({ ok: true });
    expect(t.sent).toEqual([{ chatId: "c1", text: "hello", delivery: "interrupt" }]);
    expect(await chats.ask!("c1", "ship it?")).toMatchObject({ answered: true, answer: "yes" });
    expect(await chats.ask!("c1", "why?", { timeoutSeconds: 5 })).toMatchObject({ answered: false, reason: "timeout" });
    expect(t.asked[1]).toMatchObject({ timeoutSeconds: 5 });
    expect(await chats.reply!("ask-1", "ok")).toEqual({ ok: true });

    t.attention.push({ id: "q1", kind: "question", chatId: "c1", projectId: "p1", createdAt: 1, title: "Which?" } as never);
    t.attention.push({ id: "perm", kind: "permission", chatId: "c1", projectId: "p1", createdAt: 1, title: "Run?" } as never);
    expect(await t.ctx.attention!.answer!("q1", { optionId: "a" })).toEqual({ ok: true });
    expect(await t.ctx.attention!.answer!("perm", { decline: true })).toMatchObject({ ok: false });
    expect(t.answered).toEqual([{ itemId: "q1", answer: { optionId: "a" } }]);
  });

  it("keeps memory per project, secrets to the listed names, and kv as JSON", async () => {
    const t = createTestContext({ secrets: { TOKEN: "t0k" }, kv: { a: 1 } });
    await t.ctx.memory!.remember("p1", { name: "n", description: "d", type: "project", body: "the fact" });
    expect(await t.ctx.memory!.recall("p1", "fact")).toContain("the fact");
    expect(await t.ctx.memory!.recall("p2")).toBe("");
    await t.ctx.memory!.forget("p1", "n");
    expect(await t.ctx.memory!.recall("p1")).toBe("");

    expect(await t.ctx.secrets!.get("TOKEN")).toBe("t0k");
    expect(await t.ctx.secrets!.get("OTHER")).toBeUndefined();
    expect(await t.ctx.secrets!.list()).toEqual(["TOKEN"]);

    expect(await t.ctx.kv!.get("a")).toBe(1);
    await t.ctx.kv!.set("b", { when: new Date(0) });
    // Stored as JSON, like the host's table: a Date comes back as its string.
    expect(await t.ctx.kv!.get("b")).toEqual({ when: "1970-01-01T00:00:00.000Z" });
    await t.ctx.kv!.set("a", undefined);
    expect(await t.ctx.kv!.list()).toEqual(["b"]);
  });

  it("writes secrets with secrets:write, enforcing the manifest's list as the host does", async () => {
    const t = createTestContext({
      capabilities: ["secrets", "secrets:write"],
      secrets: { GITHUB_TOKEN: "ghp" },
      manifestSecrets: ["HOST_KEY_*"],
    });
    await t.ctx.secrets!.set!("HOST_KEY_mac", "pem");
    expect(t.secrets.get("HOST_KEY_mac")).toBe("pem");
    expect(await t.ctx.secrets!.list()).toEqual(["HOST_KEY_mac"]);
    // Uncovered: invisible to read, refused on write — as on the host.
    expect(await t.ctx.secrets!.get("GITHUB_TOKEN")).toBeUndefined();
    await expect(t.ctx.secrets!.set!("GITHUB_TOKEN", "x")).rejects.toThrow(/not listed under secrets:/);
    await expect(t.ctx.secrets!.set!("HOST_KEY_a-b", "x")).rejects.toThrow(/not a valid secret name/);
    await expect(t.ctx.secrets!.set!("HOST_KEY_mac", "")).rejects.toThrow(/non-empty/);
    expect(await t.ctx.secrets!.delete!("HOST_KEY_mac")).toBe(true);
    expect(await t.ctx.secrets!.delete!("HOST_KEY_mac")).toBe(false);
    expect([...t.secrets.keys()]).toEqual(["GITHUB_TOKEN"]);

    const readOnly = createTestContext({ capabilities: ["secrets"] });
    expect(readOnly.ctx.secrets!.set).toBeUndefined();
  });

  it("flips process status and answers oauth tokens from the map", async () => {
    const t = createTestContext();
    t.processes.set("whisper", { id: "whisper", status: "stopped", ports: [9000] });
    await t.ctx.processes!.start("whisper");
    expect(await t.ctx.processes!.list()).toEqual([{ id: "whisper", status: "running", ports: [9000] }]);
    await expect(t.ctx.processes!.start("nope")).rejects.toThrow(/no process/);

    expect(await t.ctx.oauth!.token("xai")).toBeUndefined();
    t.oauthTokens.set("xai", "access-1");
    expect(await t.ctx.oauth!.token("xai")).toBe("access-1");
    await t.ctx.oauth!.disconnect("xai");
    expect(await t.ctx.oauth!.token("xai")).toBeUndefined();
  });

  it("hands every plugin an instance, a copied one on request, or none as an older host does", () => {
    expect(createTestContext({ capabilities: [] }).ctx.instance).toEqual(TEST_INSTANCE);
    const copied = createTestContext({
      instance: { id: "dev-2", role: "dev", previousId: "stable-1", reminted: { at: "2026-11-01T00:00:00.000Z", reason: "copied" } },
    }).ctx.instance;
    expect(copied).toEqual({
      id: "dev-2",
      role: "dev",
      dataDirFingerprint: TEST_INSTANCE.dataDirFingerprint,
      previousId: "stable-1",
      reminted: { at: "2026-11-01T00:00:00.000Z", reason: "copied" },
    });
    expect("instance" in createTestContext({ instance: null }).ctx).toBe(false);
  });

  it("lets a handler set status and headers through the reply", async () => {
    const t = createTestContext();
    t.ctx.routes!((r) => {
      r.get("/created", (_req, reply) => reply.code(201).header("x-a", "1").send({ ok: true }));
      r.get("/q", (req) => ({ q: req.query, h: req.headers.authorization }));
    });
    expect(await t.routes.call("GET", "/created")).toEqual({ status: 201, headers: { "x-a": "1" }, body: { ok: true } });
    expect((await t.routes.call("GET", "/q?x=1", { headers: { Authorization: "Bearer t" } })).body).toEqual({
      q: { x: "1" },
      h: "Bearer t",
    });
  });
});

describe("createTestContext providers", () => {
  const harness = (kind: string) => ({ kind }) as unknown as Harness;
  const descriptor = (id: string) => ({ id }) as unknown as ProviderDescriptor;

  it("records registrations and refuses what the host would", () => {
    const t = createTestContext();
    t.ctx.providers!.register(harness("opencode"), descriptor("opencode"));
    expect(t.providers.map((p) => p.descriptor.id)).toEqual(["opencode"]);
    expect(() => t.ctx.providers!.register(harness("opencode"), descriptor("opencode"))).toThrow(/already registered/);
    expect(() => t.ctx.providers!.register(harness("claude"), descriptor("claude"))).toThrow(/already registered/);
    expect(() => t.ctx.providers!.register(harness("a"), descriptor("b"))).toThrow(/does not match/);
  });
});

describe("createTestContext terminals", () => {
  it("accepts a backend id qualified by the plugin's own id, as the host does, and refuses another plugin's (E12)", () => {
    const t = createTestContext({ id: "remote-host", capabilities: ["terminals"] });
    const spawn = async () => ({ stdin: { write: () => {} }, stdout: { on: () => {} }, stderr: { on: () => {} }, kill: () => {}, on: () => {} });
    t.ctx.terminals!.registerBackend({ id: "remote-host/cvx-mac", label: "cvx-mac", shell: "bash", spawn, fallback: "refuse" });
    expect([...t.terminalBackends.keys()]).toEqual(["remote-host/cvx-mac"]);
    expect(() =>
      t.ctx.terminals!.registerBackend({ id: "proxmox-terminal/box", label: "Box", shell: "bash", spawn }),
    ).toThrow(/must start with the registering plugin's id \("remote-host\/…"\)/);
    t.ctx.terminals!.setStatus("remote-host/cvx-mac", { state: "offline" });
    expect(t.terminalStatus.get("remote-host/cvx-mac")).toEqual({ state: "offline" });
  });

  it("records a backend, plays the host's spawn and hooks, and scopes ports", async () => {
    const t = createTestContext();
    const calls: string[] = [];
    t.ctx.terminals!.registerBackend({
      id: "box",
      label: "Box",
      shell: "bash",
      spawn: async (info) => {
        calls.push(`spawn:${info.chatId}:${info.name}`);
        return { stdin: { write: () => {} }, stdout: { on: () => {} }, stderr: { on: () => {} }, kill: () => {}, on: () => {} };
      },
      onChatIdle: (e) => void calls.push(`idle:${e.chatId}`),
      onChatDeleted: (e) => void calls.push(`deleted:${e.chatId}`),
    });
    expect([...t.terminalBackends.keys()]).toEqual(["box"]);
    expect(() => t.ctx.terminals!.registerBackend({ ...t.terminalBackends.get("box")! })).toThrow(/already registered/);
    expect(() => t.ctx.terminals!.registerBackend({ ...t.terminalBackends.get("box")!, id: "local" })).toThrow(/reserved/);
    expect(() =>
      t.ctx.terminals!.registerBackend({ ...t.terminalBackends.get("box")!, id: "mac", fallback: "never" as never }),
    ).toThrow(/fallback must be "local" or "refuse"/);
    t.ctx.terminals!.registerBackend({ id: "mac", label: "Mac", shell: "bash", spawn: t.terminalBackends.get("box")!.spawn, fallback: "refuse" });
    expect(t.terminalBackends.get("mac")?.fallback).toBe("refuse");

    await t.terminals.spawn("box", { chatId: "c1" });
    const withdraw = t.ctx.terminals!.publishPort("box", { chatId: "c1", remotePort: 5173, url: "http://127.0.0.1:1" });
    expect(t.ctx.terminals!.ports("c1")).toEqual([{ chatId: "c1", remotePort: 5173, url: "http://127.0.0.1:1", backend: "box" }]);
    expect(() => t.ctx.terminals!.publishPort("other", { chatId: "c1", remotePort: 1, url: "http://x" })).toThrow(/not registered/);
    withdraw();
    expect(t.terminalPorts).toEqual([]);
    await t.terminals.chatIdle("c1");
    await t.terminals.chatDeleted("c1");
    expect(calls).toEqual(["spawn:c1:main", "idle:c1", "deleted:c1"]);
  });

  it("records setStatus / updateBackend and tears one backend down with unregisterBackend", async () => {
    const t = createTestContext({ capabilities: ["terminals"] });
    let disposed = 0;
    const spawn = async () => ({ stdin: { write: () => {} }, stdout: { on: () => {} }, stderr: { on: () => {} }, kill: () => {}, on: () => {} });
    t.ctx.terminals!.registerBackend({ id: "mac", label: "Mac", shell: "bash", spawn, dispose: () => void disposed++ });
    t.ctx.terminals!.publishPort("mac", { chatId: "c1", remotePort: 3000, url: "http://127.0.0.1:1" });

    t.ctx.terminals!.setStatus("mac", { state: "offline", detail: "asleep" });
    expect(t.terminalStatus.get("mac")).toEqual({ state: "offline", detail: "asleep" });
    expect(() => t.ctx.terminals!.setStatus("mac", { state: "napping" as never })).toThrow(/state must be/);
    t.ctx.terminals!.updateBackend("mac", { label: "Garage Mac" });
    expect(t.terminalUpdates.get("mac")).toEqual({ label: "Garage Mac" });
    // The registered object is left as it was, as the host leaves it.
    expect(t.terminalBackends.get("mac")?.label).toBe("Mac");
    for (const call of [
      () => t.ctx.terminals!.setStatus("other", { state: "online" }),
      () => t.ctx.terminals!.updateBackend("other", { label: "x" }),
      () => t.ctx.terminals!.unregisterBackend("other"),
    ]) {
      expect(call).toThrow(/not registered by plugin/);
    }

    await t.ctx.terminals!.unregisterBackend("mac");
    expect(disposed).toBe(1);
    expect(t.terminalBackends.has("mac")).toBe(false);
    expect(t.terminalStatus.has("mac")).toBe(false);
    expect(t.terminalPorts).toEqual([]);
    // Free to register again.
    t.ctx.terminals!.registerBackend({ id: "mac", label: "Mac", shell: "bash", spawn });
  });

  it("plays beforeRun / afterRun as core would: a refusal or a throw means not run", async () => {
    const t = createTestContext();
    const seen: string[] = [];
    const handle = { stdin: { write: () => {} }, stdout: { on: () => {} }, stderr: { on: () => {} }, kill: () => {}, on: () => {} };
    t.ctx.terminals!.registerBackend({
      id: "box",
      label: "Box",
      shell: "bash",
      spawn: async () => handle,
      beforeRun: (info) => {
        seen.push(`before:${info.terminal}:${info.cwd}:${info.command}`);
        if (info.command === "conflict") return { refuse: "a.txt changed on both sides", notices: ["a.txt"] };
        if (info.command === "offline") throw new Error("host unreachable");
        return { notices: ["synced"] };
      },
      afterRun: (info) => {
        seen.push(`after:${info.outcome}:${info.exitCode}`);
        return { notices: ["brought back b.txt"] };
      },
    });
    t.ctx.terminals!.registerBackend({ id: "plain", label: "Plain", shell: "bash", spawn: async () => handle });

    expect(await t.terminals.beforeRun("box", { chatId: "c1", command: "make" })).toEqual({ ran: true, notices: ["synced"] });
    expect(await t.terminals.beforeRun("box", { chatId: "c1", command: "conflict" })).toEqual({
      ran: false,
      refusal: "a.txt changed on both sides",
      notices: ["a.txt"],
    });
    expect(await t.terminals.beforeRun("box", { chatId: "c1", command: "offline" })).toEqual({
      ran: false,
      refusal: "host unreachable",
      notices: [],
    });
    expect(await t.terminals.afterRun("box", { chatId: "c1", command: "make", exitCode: 2 })).toEqual({
      notices: ["brought back b.txt"],
    });
    expect(seen).toEqual([
      "before:main:/repo:make",
      "before:main:/repo:conflict",
      "before:main:/repo:offline",
      "after:finished:2",
    ]);
    // A backend with no hooks: the command simply runs.
    expect(await t.terminals.beforeRun("plain", { chatId: "c1", command: "make" })).toEqual({ ran: true, notices: [] });
    expect(await t.terminals.afterRun("plain", { chatId: "c1", command: "make" })).toEqual({ notices: [] });
  });

  it("gives each call a fresh runId unless the test pairs two by passing one", async () => {
    const t = createTestContext();
    const ids: string[] = [];
    const handle = { stdin: { write: () => {} }, stdout: { on: () => {} }, stderr: { on: () => {} }, kill: () => {}, on: () => {} };
    t.ctx.terminals!.registerBackend({
      id: "box",
      label: "Box",
      shell: "bash",
      spawn: async () => handle,
      beforeRun: (info) => void ids.push(`before:${info.runId}`),
      afterRun: (info) => void ids.push(`after:${info.runId}`),
    });
    await t.terminals.beforeRun("box", { chatId: "c1", command: "a" });
    await t.terminals.beforeRun("box", { chatId: "c1", command: "b" });
    await t.terminals.beforeRun("box", { chatId: "c1", command: "c", runId: "mine" });
    await t.terminals.afterRun("box", { chatId: "c1", command: "c", runId: "mine" });
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toMatch(/^before:\S+$/);
    expect(ids.slice(2)).toEqual(["before:mine", "after:mine"]);
  });
});

describe("lifecycle", () => {
  it("plays onShutdown then deactivate, and reports an overrun with the signal aborted", async () => {
    const t = createTestContext();
    const calls: string[] = [];
    let signal: AbortSignal | undefined;
    const mod = definePlugin({
      activate: () => {},
      deactivate: () => void calls.push("deactivate"),
      onShutdown: (e) => {
        calls.push(`shutdown:${e.reason}`);
        signal = e.signal as AbortSignal;
        if (e.reason === "uninstall") return new Promise<void>(() => {});
      },
    });

    expect(await t.lifecycle.shutdown(mod, "restart")).toMatchObject({ overran: false });
    const slow = await t.lifecycle.shutdown(mod, "uninstall", { budgetMs: 20 });
    expect(slow.overran).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(calls).toEqual(["shutdown:restart", "deactivate", "shutdown:uninstall", "deactivate"]);
  });

  it("hands reconcile the live chats", async () => {
    const t = createTestContext();
    const seen: string[][] = [];
    const mod = definePlugin({
      activate: () => {},
      reconcile: (e) => void seen.push(e.chats.map((c) => c.id)),
    });
    await t.lifecycle.reconcile(mod, [{ id: "c1", projectId: "p" }]);
    expect(seen).toEqual([["c1"]]);
  });

  it("surfaces a failing onChatDeleted as a rejection — what the host records for retry", async () => {
    const t = createTestContext({ capabilities: ["terminals"] });
    t.ctx.terminals!.registerBackend({
      id: "box",
      label: "Box",
      shell: "bash",
      spawn: async () => {
        throw new Error("unused");
      },
      onChatDeleted: async () => {
        throw new Error("hypervisor down");
      },
    });
    await expect(t.terminals.chatDeleted("c1")).rejects.toThrow(/hypervisor down/);
  });

  it("uses the host's budgets", () => {
    expect(PLUGIN_SHUTDOWN_BUDGET_MS).toBe(5_000);
    expect(PLUGIN_RECONCILE_BUDGET_MS).toBe(120_000);
  });
});

describe("createTestContext terminals.spawnProcess (E7, hosting an MCP server)", () => {
  /**
   * The shape a remote-host backend has: one process per chat + server, kept
   * alive across a dropped link and re-attached. Here the "link" is a flag.
   */
  async function fakeRemoteHost() {
    const { EventEmitter } = await import("node:events");
    const t = createTestContext({ id: "remote-host", capabilities: ["terminals"] });
    const handles: Array<InstanceType<typeof EventEmitter> & { initializes: number }> = [];
    t.ctx.terminals!.registerBackend({
      id: "remote-host/cvx-mac",
      label: "CVX Mac",
      shell: "bash",
      fallback: "refuse",
      spawn: () => Promise.reject(new Error("unused")),
      spawnProcess: async (info) => {
        const h = Object.assign(new EventEmitter(), { initializes: 0 }) as InstanceType<typeof EventEmitter> & {
          initializes: number;
          stdout: InstanceType<typeof EventEmitter>;
          stdin: { write(c: string): boolean };
          kill(): void;
        };
        h.stdout = new EventEmitter();
        const reply = (m: unknown) => h.stdout.emit("data", JSON.stringify(m) + "\n");
        h.stdin = {
          write: (chunk: string) => {
            for (const line of chunk.split("\n").filter(Boolean)) {
              const m = JSON.parse(line) as { id?: string; method?: string };
              if (m.method === "initialize") {
                h.initializes++;
                reply({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: info.bundled?.server ?? info.name } } });
              } else if (m.method === "tools/call") reply({ jsonrpc: "2.0", id: m.id, result: { content: [] } });
            }
            return true;
          },
        };
        h.kill = () => h.emit("exit", null, { kind: "killed" });
        handles.push(h);
        return h as never;
      },
    });
    return { t, handles };
  }

  it("starts the process with core's defaults and speaks JSON-RPC lines to it", async () => {
    const { t, handles } = await fakeRemoteHost();
    const p = await t.terminals.spawnProcess("remote-host/cvx-mac", {
      chatId: "c1",
      name: "playwright",
      bundled: { server: "playwright", package: "@playwright/mcp", version: "0.0.79", bin: "cli.js", args: ["--headless"] },
    });
    expect((await p.request("initialize", {})).result).toEqual({ serverInfo: { name: "playwright" } });
    expect((await p.request("tools/call", { name: "x" })).result).toEqual({ content: [] });
    expect(p.garbage).toEqual([]);
    expect(handles[0]!.initializes).toBe(1);
  });

  it("records stalled / resumed / exit, and fails a pending request when the process exits", async () => {
    const { t, handles } = await fakeRemoteHost();
    const p = await t.terminals.spawnProcess("remote-host/cvx-mac", { chatId: "c1" });
    await p.request("initialize", {});
    handles[0]!.emit("stalled", { detail: "wifi" });
    handles[0]!.emit("resumed");
    expect(await p.next("stalled")).toEqual([{ detail: "wifi" }]);
    await p.next("resumed");
    // Re-attached to the same process: it answers without another initialize.
    expect((await p.request("tools/call", { name: "x" })).result).toEqual({ content: [] });
    expect(handles[0]!.initializes).toBe(1);

    const hung = p.request("tools/list", undefined, { timeoutMs: 1_000 });
    p.handle.kill();
    await expect(hung).rejects.toThrow(/exited before replying/);
    expect(await p.next("exit")).toEqual([null, { kind: "killed" }]);
    expect(p.events.map((e) => e.event)).toEqual(["stalled", "resumed", "exit"]);
  });

  it("refuses a backend that has no spawnProcess, as core never places a process there", async () => {
    const t = createTestContext({ id: "proxmox-terminal", capabilities: ["terminals"] });
    t.ctx.terminals!.registerBackend({ id: "proxmox", label: "Proxmox", shell: "bash", spawn: () => Promise.reject(new Error("unused")) });
    await expect(t.terminals.spawnProcess("proxmox", { chatId: "c1" })).rejects.toThrow(/has no spawnProcess/);
  });
});
