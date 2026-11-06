/**
 * The REAL shim, in relay mode, against the real relay and a fake backend.
 *
 * What is pinned here is what the runtimes measured on 2026-11-06 make
 * load-bearing (memory `stdio-mcp-exit-behaviour-by-provider`): the shim must
 * never exit because the far side went away — under Codex that would cost the
 * agent these tools for the rest of its thread — and a re-attach must not
 * initialize the far-side process a second time.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TerminalProcessHandle } from "@dispatch/shared";
import { McpPlacementService, RELAY_TOKEN_ENV } from "./placement.js";

const SHIM = join(dirname(fileURLToPath(import.meta.url)), "lazy-browser-shim.mjs");

type Msg = Record<string, unknown> & { id?: string | number; method?: string };

class FakeProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly received: Msg[] = [];
  readonly held: Msg[] = [];
  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n")) if (line.trim()) this.onFrame(JSON.parse(line) as Msg);
      return true;
    },
    end: () => {},
  };
  kill(): void {}
  send(m: unknown): void {
    this.stdout.emit("data", JSON.stringify(m) + "\n");
  }
  private onFrame(m: Msg): void {
    this.received.push(m);
    if (m.method === "initialize") this.send({ jsonrpc: "2.0", id: m.id, result: INIT_RESULT });
    else if (m.method === "tools/list") this.send({ jsonrpc: "2.0", id: m.id, result: TOOLS });
    else if (m.method === "tools/call") {
      if ((m.params as { name?: string }).name === "hang") this.held.push(m);
      else this.send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "pong" }] } });
    }
  }
}

const INIT_RESULT = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "far-side", version: "1" } };
const TOOLS = { tools: [{ name: "ping", inputSchema: { type: "object" } }] };
const INIT_PARAMS = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } };

/** The runtime's side of the shim: stdio, responses by id. */
class Client {
  private buf = "";
  private readonly waiting = new Map<string | number, (m: Msg) => void>();
  readonly exited: Promise<number | null>;
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      for (;;) {
        const nl = this.buf.indexOf("\n");
        if (nl === -1) break;
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        const m = JSON.parse(line) as Msg;
        if (m.id !== undefined && this.waiting.has(m.id)) {
          this.waiting.get(m.id)!(m);
          this.waiting.delete(m.id);
        }
      }
    });
    this.exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  }
  request(id: number, method: string, params?: unknown): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out: ${method} #${id}`)), 10_000);
      this.waiting.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
    });
  }
  notify(method: string): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }
}

let dir: string;
const children: ChildProcessWithoutNullStreams[] = [];
const services: McpPlacementService[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "relay-shim-"));
});
afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  for (const s of services.splice(0)) await s.dispose();
  await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const procs: FakeProcess[] = [];
  const svc = new McpPlacementService({
    host: {
      spawnProcess: async () => {
        const p = new FakeProcess();
        procs.push(p);
        return p as unknown as TerminalProcessHandle;
      },
      labelOf: () => "CVX Mac",
    },
  });
  services.push(svc);
  await svc.start();
  const { token } = svc.place("remote-host/cvx-mac", { chatId: "c1", name: "playwright", cwd: dir });
  const manifest = join(dir, "manifest.json");
  const shim = (opts: { manifest?: boolean } = {}) => {
    const child = spawn(
      process.execPath,
      [SHIM, "--owner-dir", join(dir, "owner"), ...(opts.manifest === false ? [] : ["--manifest", manifest]), "--relay", svc.socketPath],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, [RELAY_TOKEN_ENV]: token } },
    ) as ChildProcessWithoutNullStreams;
    children.push(child);
    return new Client(child);
  };
  return { svc, procs, shim, manifest };
}

const errorOf = (m: Msg) => (m.error as { message?: string } | undefined)?.message ?? "";
const initializes = (p: FakeProcess) => p.received.filter((m) => m.method === "initialize").length;

describe("lazy shim in relay mode", () => {
  it("answers initialize and tools/list from the manifest, and starts the far side only when a tool is called", async () => {
    const { procs, shim, manifest } = await setup();
    await writeFile(manifest, JSON.stringify({ initialize: INIT_RESULT, tools: TOOLS }));
    const c = shim();
    expect((await c.request(0, "initialize", INIT_PARAMS)).result).toEqual(INIT_RESULT);
    c.notify("notifications/initialized");
    expect((await c.request(1, "tools/list")).result).toEqual(TOOLS);
    expect(procs).toHaveLength(0);

    const r = await c.request(2, "tools/call", { name: "ping" });
    expect(r.result).toMatchObject({ content: [{ text: "pong" }] });
    expect(procs).toHaveLength(1);
    expect(initializes(procs[0]!)).toBe(1);
  });

  it("cold, with no manifest: handshakes through the relay and writes the manifest for next time", async () => {
    const { procs, shim, manifest } = await setup();
    const c = shim();
    expect((await c.request(0, "initialize", INIT_PARAMS)).result).toEqual(INIT_RESULT);
    c.notify("notifications/initialized");
    expect((await c.request(1, "tools/list")).result).toEqual(TOOLS);
    expect(procs).toHaveLength(1);
    expect(JSON.parse(await readFile(manifest, "utf8"))).toEqual({ initialize: INIT_RESULT, tools: TOOLS });
  });

  it("survives a stall: the call in flight fails with the reason, the shim stays up, and the next call works", async () => {
    const { procs, shim, manifest } = await setup();
    await writeFile(manifest, JSON.stringify({ initialize: INIT_RESULT, tools: TOOLS }));
    const c = shim();
    await c.request(0, "initialize", INIT_PARAMS);
    await c.request(1, "tools/call", { name: "ping" });
    const inFlight = c.request(2, "tools/call", { name: "hang" });
    await new Promise((r) => setTimeout(r, 50));
    procs[0]!.emit("stalled", { detail: "wifi" });
    expect(errorOf(await inFlight)).toMatch(/Lost the connection to CVX Mac \(wifi\)/);
    procs[0]!.emit("resumed");
    expect((await c.request(3, "tools/call", { name: "ping" })).result).toBeTruthy();
    expect(c.child.exitCode).toBeNull();
    expect(initializes(procs[0]!)).toBe(1);
  });

  it("a shim displaced from the relay fails its own call, stays up, and re-attaches on the next call WITHOUT re-initializing the far side", async () => {
    const { procs, shim, manifest } = await setup();
    await writeFile(manifest, JSON.stringify({ initialize: INIT_RESULT, tools: TOOLS }));
    const a = shim();
    await a.request(0, "initialize", INIT_PARAMS);
    const inFlight = a.request(1, "tools/call", { name: "hang" });
    await new Promise((r) => setTimeout(r, 50));

    // What Claude Code does after a shim exit, or a session restart: a second
    // shim for the same server attaches and takes over.
    const b = shim();
    await b.request(0, "initialize", INIT_PARAMS);
    expect((await b.request(1, "tools/call", { name: "ping" })).result).toBeTruthy();

    expect(errorOf(await inFlight)).toMatch(/Lost the connection to Dispatch/);
    expect(a.child.exitCode).toBeNull();
    expect((await a.request(2, "tools/call", { name: "ping" })).result).toBeTruthy();
    expect(procs).toHaveLength(1);
    expect(initializes(procs[0]!)).toBe(1);
  });

  it("with Dispatch gone, answers every call with an error and never exits", async () => {
    const { svc, shim, manifest } = await setup();
    await writeFile(manifest, JSON.stringify({ initialize: INIT_RESULT, tools: TOOLS }));
    const c = shim();
    await c.request(0, "initialize", INIT_PARAMS);
    await c.request(1, "tools/call", { name: "ping" });
    await svc.dispose();
    services.length = 0;
    const r = await c.request(2, "tools/call", { name: "ping" });
    expect(r.error).toBeTruthy();
    const again = await c.request(3, "tools/call", { name: "ping" });
    expect(errorOf(again)).toMatch(/Lost the connection to Dispatch/);
    // tools/list still answers from the manifest: the tools stay visible.
    expect((await c.request(4, "tools/list")).result).toEqual(TOOLS);
    expect(c.child.exitCode).toBeNull();
  });
});
