/**
 * The relay's reconnect contract, driven over its REAL socket against a fake
 * backend whose "process" is an in-memory MCP server. Every rule in the
 * `placement.ts` docblock has a test here, because each is a failure a
 * runtime would otherwise show the agent: a call that hangs forever, a second
 * `initialize` to a server that already has one, a stale reply answering a
 * new request, a restart nobody mentions.
 */
import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import type { TerminalProcessHandle, TerminalProcessSpawnInfo } from "@dispatch/shared";
import { McpPlacementService, RELAY_ATTACH, RELAY_ATTACHED, RELAY_REFUSED, type PlacedServerSpec } from "./placement.js";

type Msg = Record<string, unknown> & { id?: string | number; method?: string };

/** An MCP server living in memory, as a backend's process handle. */
class FakeProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly received: Msg[] = [];
  readonly held: Msg[] = [];
  ended = false;
  killed = false;
  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n")) if (line.trim()) this.onFrame(JSON.parse(line) as Msg);
      return true;
    },
    end: () => {
      this.ended = true;
    },
  };
  constructor(readonly gen: number) {
    super();
  }
  kill(): void {
    this.killed = true;
  }
  send(msg: unknown): void {
    this.stdout.emit("data", JSON.stringify(msg) + "\n");
  }
  get initializes(): Msg[] {
    return this.received.filter((m) => m.method === "initialize");
  }
  private onFrame(msg: Msg): void {
    this.received.push(msg);
    if (msg.method === "initialize") {
      this.send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: `${this.gen}` } } });
    } else if (msg.method === "tools/list") {
      this.send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping" }, { name: "hang" }] } });
    } else if (msg.method === "tools/call") {
      const name = (msg.params as { name?: string })?.name;
      if (name === "hang") this.held.push(msg);
      else this.send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `pong from life ${this.gen}` }] } });
    }
  }
}

/** One shim's worth of socket: attach, then JSON-RPC lines. */
class RelayClient {
  private buf = "";
  readonly lines: Msg[] = [];
  private readonly waiters = new Map<string | number, (m: Msg) => void>();
  private readonly listeners: Array<(m: Msg) => void> = [];
  readonly closed: Promise<void>;
  constructor(readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buf += chunk;
      for (;;) {
        const nl = this.buf.indexOf("\n");
        if (nl === -1) break;
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        const m = JSON.parse(line) as Msg;
        this.lines.push(m);
        for (const l of this.listeners) l(m);
        if (m.method === undefined && m.id !== undefined && this.waiters.has(m.id)) {
          this.waiters.get(m.id)!(m);
          this.waiters.delete(m.id);
        }
      }
    });
    this.closed = new Promise((resolve) => socket.on("close", () => resolve()));
  }
  write(m: unknown): void {
    this.socket.write(JSON.stringify(m) + "\n");
  }
  request(id: string | number, method: string, params?: unknown): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out: ${method} #${id}`)), 5_000);
      this.waiters.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }
  next(pred: (m: Msg) => boolean): Promise<Msg> {
    const hit = this.lines.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => this.listeners.push((m) => pred(m) && resolve(m)));
  }
  /** Destroy, not end: a Windows named pipe never delivers a half-close as EOF (the real shim exits). */
  close(): void {
    this.socket.destroy();
  }
}

const INIT_PARAMS = { protocolVersion: "2025-06-18", capabilities: { roots: {} }, clientInfo: { name: "test-client", version: "1" } };

const services: McpPlacementService[] = [];
const clients: RelayClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.socket.destroy();
  for (const s of services.splice(0)) await s.dispose();
});

function setup(opts: { graceMs?: number; offline?: () => boolean } = {}) {
  const procs: FakeProcess[] = [];
  const spawns: TerminalProcessSpawnInfo[] = [];
  const svc = new McpPlacementService({
    host: {
      spawnProcess: async (_id, info) => {
        spawns.push(info);
        if (opts.offline?.()) throw new Error("CVX Mac is offline (asleep)");
        const p = new FakeProcess(procs.length + 1);
        procs.push(p);
        return p as unknown as TerminalProcessHandle;
      },
      labelOf: () => "CVX Mac",
    },
    graceMs: opts.graceMs ?? 60_000,
    killAfterEndMs: 20,
  });
  services.push(svc);
  const spec: PlacedServerSpec = { chatId: "c1", name: "playwright", cwd: "C:/work/repo" };
  return { svc, procs, spawns, spec };
}

async function attach(svc: McpPlacementService, token: string): Promise<RelayClient> {
  const socket = connect(svc.socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const c = new RelayClient(socket);
  clients.push(c);
  c.write({ dispatchRelay: RELAY_ATTACH, token });
  await c.next((m) => m.dispatchRelay !== undefined);
  return c;
}

const textOf = (m: Msg) =>
  ((m.result as { content?: Array<{ text?: string }> })?.content ?? []).map((b) => b.text).join("\n");
const errorOf = (m: Msg) => (m.error as { message?: string } | undefined)?.message ?? "";
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("McpPlacementService", () => {
  it("refuses a socket that does not present a known token", async () => {
    const { svc } = setup();
    await svc.start();
    const c = await attach(svc, "nope");
    expect(c.lines[0]).toMatchObject({ dispatchRelay: RELAY_REFUSED });
    await c.closed;
  });

  it("starts nothing until a request needs the process, then initializes it ONCE with the client's params", async () => {
    const { svc, procs, spawns, spec } = setup();
    await svc.start();
    const { token } = svc.place("remote-host/cvx-mac", spec);
    const c = await attach(svc, token);
    expect(c.lines[0]).toMatchObject({ dispatchRelay: RELAY_ATTACHED });
    expect(spawns).toHaveLength(0);

    const init = await c.request("dispatch-lazy-init", "initialize", INIT_PARAMS);
    expect(init.result).toMatchObject({ serverInfo: { name: "fake" } });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ purpose: "mcp", name: "playwright", chatId: "c1" });
    expect(procs[0]!.initializes).toHaveLength(1);
    expect(procs[0]!.initializes[0]!.params).toEqual(INIT_PARAMS);
    // The relay sends its own `initialized`; the client's is swallowed.
    c.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    await tick();
    expect(procs[0]!.received.filter((m) => m.method === "notifications/initialized")).toHaveLength(1);
  });

  it("answers a SECOND initialize (a reconnected or respawned shim) from cache, never re-initializing the process", async () => {
    const { svc, procs, spec } = setup();
    await svc.start();
    const { token } = svc.place("remote-host/cvx-mac", spec);
    const a = await attach(svc, token);
    await a.request(0, "initialize", INIT_PARAMS);
    a.close();
    const b = await attach(svc, token);
    const again = await b.request(0, "initialize", INIT_PARAMS);
    expect(again.result).toMatchObject({ serverInfo: { version: "1" } });
    expect(procs).toHaveLength(1);
    expect(procs[0]!.initializes).toHaveLength(1);
  });

  it("remaps request ids, so a reconnected client restarting at id 0 is never answered by a stale reply", async () => {
    const { svc, procs, spec } = setup();
    await svc.start();
    const { token } = svc.place("remote-host/cvx-mac", spec);
    const a = await attach(svc, token);
    await a.request(0, "initialize", INIT_PARAMS);
    void a.request(1, "tools/call", { name: "hang" }).catch(() => {});
    await tick();
    const upstreamId = procs[0]!.held[0]!.id;
    expect(upstreamId).not.toBe(1);

    const b = await attach(svc, token); // newest wins; `a` is closed
    await b.request(0, "initialize", INIT_PARAMS);
    const fresh = b.request(1, "tools/call", { name: "ping" });
    // The old request's reply finally arrives: it must not answer b's #1.
    procs[0]!.send({ jsonrpc: "2.0", id: upstreamId, result: { content: [{ type: "text", text: "STALE" }] } });
    expect(textOf(await fresh)).toBe("pong from life 1");
    await tick();
    expect(b.lines.some((m) => textOf(m) === "STALE")).toBe(false);
  });

  it("on `stalled`: fails the call in flight, fails new calls AT ONCE, and resumes on `resumed` without a new initialize", async () => {
    const { svc, procs, spec } = setup();
    await svc.start();
    const { token } = svc.place("remote-host/cvx-mac", spec);
    const c = await attach(svc, token);
    await c.request(0, "initialize", INIT_PARAMS);
    const inFlight = c.request(1, "tools/call", { name: "hang" });
    await tick();
    const held = procs[0]!.held[0]!;

    procs[0]!.emit("stalled", { detail: "no keepalive answer for 15 s" });
    const failed = await inFlight;
    expect(errorOf(failed)).toMatch(/Lost the connection to CVX Mac \(no keepalive answer for 15 s\)/);
    expect(errorOf(failed)).toMatch(/still running there/);

    const during = await c.request(2, "tools/call", { name: "ping" });
    expect(errorOf(during)).toMatch(/Nothing was sent/);
    expect(procs[0]!.received.filter((m) => m.method === "tools/call")).toHaveLength(1);

    procs[0]!.emit("resumed");
    // The late reply to the call that was already failed is dropped.
    procs[0]!.send({ jsonrpc: "2.0", id: held.id, result: { content: [{ type: "text", text: "LATE" }] } });
    const after = await c.request(3, "tools/call", { name: "ping" });
    expect(textOf(after)).toBe("pong from life 1");
    expect(c.lines.some((m) => textOf(m) === "LATE")).toBe(false);
    expect(procs).toHaveLength(1);
    expect(procs[0]!.initializes).toHaveLength(1);
  });

  it("answers a respawned shim's initialize from cache DURING a stall, so its calls fail fast instead of hanging", async () => {
    const { svc, procs, spec } = setup();
    await svc.start();
    const { token } = svc.place("remote-host/cvx-mac", spec);
    const a = await attach(svc, token);
    await a.request(0, "initialize", INIT_PARAMS);
    procs[0]!.emit("stalled", { detail: "wifi" });

    const b = await attach(svc, token);
    expect((await b.request("dispatch-lazy-init", "initialize", INIT_PARAMS)).result).toMatchObject({
      serverInfo: { name: "fake" },
    });
    expect(errorOf(await b.request(1, "tools/call", { name: "ping" }))).toMatch(/Nothing was sent/);
    procs[0]!.emit("resumed");
    expect(textOf(await b.request(2, "tools/call", { name: "ping" }))).toBe("pong from life 1");
    expect(procs[0]!.initializes).toHaveLength(1);
  });

  it("drops a half line held when the stall began", async () => {
    const { svc, procs, spec } = setup();
    await svc.start();
    const { token } = svc.place("remote-host/cvx-mac", spec);
    const c = await attach(svc, token);
    await c.request(0, "initialize", INIT_PARAMS);
    procs[0]!.stdout.emit("data", '{"jsonrpc":"2.0","id":"dispatch-relay-9","res');
    procs[0]!.emit("stalled");
    procs[0]!.emit("resumed");
    expect(textOf(await c.request(1, "tools/call", { name: "ping" }))).toBe("pong from life 1");
  });

  it("on `exit`: fails the call in flight, starts a NEW process on the next call with the client's params, and says it restarted", async () => {
    const { svc, procs, spec } = setup();
    await svc.start();
    const { token } = svc.place("remote-host/cvx-mac", spec);
    const c = await attach(svc, token);
    await c.request(0, "initialize", INIT_PARAMS);
    const inFlight = c.request(1, "tools/call", { name: "hang" });
    await tick();
    procs[0]!.emit("exit", null, { kind: "transport-lost", detail: "ssh: connection reset" });
    const failed = await inFlight;
    expect(errorOf(failed)).toMatch(/playwright on CVX Mac stopped — the connection to CVX Mac was lost: ssh: connection reset/);

    const next = await c.request(2, "tools/call", { name: "ping" });
    expect(procs).toHaveLength(2);
    expect(procs[1]!.initializes[0]!.params).toEqual(INIT_PARAMS);
    expect(textOf(next)).toMatch(/pong from life 2/);
    expect(textOf(next)).toMatch(/\[dispatch\] playwright was restarted on CVX Mac/);
    // Said once, not on every result after.
    expect(textOf(await c.request(3, "tools/call", { name: "ping" }))).toBe("pong from life 2");
  });

  it("fails a call when the backend cannot start the process, and tries again on the next call", async () => {
    let offline = true;
    const { svc, procs, spawns, spec } = setup({ offline: () => offline });
    await svc.start();
    const { token } = svc.place("remote-host/cvx-mac", spec);
    const c = await attach(svc, token);
    const init = await c.request(0, "initialize", INIT_PARAMS);
    expect(errorOf(init)).toBe("Could not start playwright on CVX Mac: CVX Mac is offline (asleep)");
    offline = false;
    expect((await c.request(1, "initialize", INIT_PARAMS)).result).toBeTruthy();
    expect(spawns).toHaveLength(2);
    expect(procs).toHaveLength(1);
  });

  it("answers ping without starting anything", async () => {
    const { svc, spawns, spec } = setup();
    await svc.start();
    const { token } = svc.place("remote-host/cvx-mac", spec);
    const c = await attach(svc, token);
    c.write({ jsonrpc: "2.0", id: 0, method: "initialize", params: INIT_PARAMS });
    await c.next((m) => m.id === 0);
    // (initialize started it; a fresh placement shows ping alone does not)
    const other = svc.place("remote-host/cvx-mac", { ...spec, name: "chrome-devtools" });
    const d = await attach(svc, other.token);
    expect((await d.request(5, "ping")).result).toEqual({});
    expect(spawns).toHaveLength(1);
  });

  it("relays a request the PROCESS makes of the client (roots/list) and routes the answer back", async () => {
    const { svc, procs, spec } = setup();
    await svc.start();
    const { token } = svc.place("remote-host/cvx-mac", spec);
    const c = await attach(svc, token);
    await c.request(0, "initialize", INIT_PARAMS);
    procs[0]!.send({ jsonrpc: "2.0", id: 7, method: "roots/list" });
    const asked = await c.next((m) => m.method === "roots/list");
    c.write({ jsonrpc: "2.0", id: asked.id, result: { roots: [] } });
    await tick();
    expect(procs[0]!.received.find((m) => m.id === 7 && m.method === undefined)).toMatchObject({ result: { roots: [] } });
  });

  it("ends the process gracefully once nothing has been attached for the grace period, and a re-attach inside it keeps it", async () => {
    // Generous real-timer margins: the first cut (80 ms grace) flaked once
    // when this file ran alongside thirty other suites.
    const { svc, procs, spec } = setup({ graceMs: 400 });
    await svc.start();
    const { token } = svc.place("remote-host/cvx-mac", spec);
    const a = await attach(svc, token);
    await a.request(0, "initialize", INIT_PARAMS);
    a.close();
    const b = await attach(svc, token);
    await tick(600);
    expect(procs[0]!.ended).toBe(false);
    b.close();
    for (let i = 0; i < 100 && !procs[0]!.killed; i++) await tick(50);
    expect(procs[0]!.ended).toBe(true);
    expect(procs[0]!.killed).toBe(true); // the bound after stdin EOF
  });

  it("keeps the process and token for the same placement, and retires it for a changed one", async () => {
    const { svc, procs, spec } = setup();
    await svc.start();
    const first = svc.place("remote-host/cvx-mac", spec);
    expect(svc.place("remote-host/cvx-mac", { ...spec }).token).toBe(first.token);
    const c = await attach(svc, first.token);
    await c.request(0, "initialize", INIT_PARAMS);
    const moved = svc.place("remote-host/other", spec);
    expect(moved.token).not.toBe(first.token);
    expect(procs[0]!.ended).toBe(true);
    const stale = await attach(svc, first.token);
    expect(stale.lines[0]).toMatchObject({ dispatchRelay: RELAY_REFUSED });
  });

  it("kills a deleted chat's processes, and a detached backend's", async () => {
    const { svc, procs, spec } = setup();
    await svc.start();
    const a = svc.place("remote-host/cvx-mac", spec);
    const b = svc.place("remote-host/other", { ...spec, chatId: "c2" });
    for (const t of [a.token, b.token]) await (await attach(svc, t)).request(0, "initialize", INIT_PARAMS);
    svc.chatDeleted("c1");
    expect(procs[0]!.killed).toBe(true);
    expect(procs[1]!.killed).toBe(false);
    svc.backendDetached("remote-host/other");
    expect(procs[1]!.killed).toBe(true);
    expect(svc.list()).toEqual([]);
  });

  it("refuses to place anything before it is listening", () => {
    const { svc, spec } = setup();
    expect(() => svc.place("remote-host/cvx-mac", spec)).toThrow(/not listening/);
  });
});
