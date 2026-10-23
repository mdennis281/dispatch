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
import { createTestContext } from "./testing.js";
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
});
