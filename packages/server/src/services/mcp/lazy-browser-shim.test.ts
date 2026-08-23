/**
 * The lazy shim, driven as a real subprocess over real stdio.
 *
 * NOT unit-tested against an injected transport, deliberately: everything that
 * can go wrong here is framing and process lifecycle — a response written before
 * the handshake, an id collision between our replay and the client's own
 * requests, a server spawned when the whole point was that it wasn't. A fake
 * transport would assert the parts that were never in doubt.
 *
 * The fixture server touches a MARKER FILE when it starts, so "did not spawn"
 * is checkable rather than inferred.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "lazy-browser-shim.mjs");
const FAKE = join(HERE, "fixtures", "fake-mcp-server.mjs");

/** A client for the shim: writes JSON-RPC lines, resolves responses by id. */
class Client {
  private buffer = "";
  private readonly waiting = new Map<string | number, (msg: Record<string, unknown>) => void>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const nl = this.buffer.indexOf("\n");
        if (nl === -1) break;
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: string | number };
        if (msg.id === undefined) continue;
        this.waiting.get(msg.id)?.(msg as Record<string, unknown>);
        this.waiting.delete(msg.id);
      }
    });
  }

  request(id: number, method: string, params?: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out: ${method}`)), 10_000);
      this.waiting.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }
}

let dir: string;
let manifest: string;
let marker: string;
const running: ChildProcessWithoutNullStreams[] = [];

function startShim(): Client {
  const child = spawn(
    process.execPath,
    [SHIM, "--manifest", manifest, "--", process.execPath, FAKE, "--marker", marker],
    { stdio: ["pipe", "pipe", "pipe"] },
  ) as ChildProcessWithoutNullStreams;
  running.push(child);
  return new Client(child);
}

/** Whether the fixture server ever started. */
async function spawned(): Promise<boolean> {
  return access(marker).then(
    () => true,
    () => false,
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lazy-shim-"));
  manifest = join(dir, "manifest.json");
  marker = join(dir, "started.log");
});

afterEach(async () => {
  for (const child of running.splice(0)) child.kill();
  await rm(dir, { recursive: true, force: true });
});

describe("lazy-browser-shim", () => {
  it("proxies transparently on a COLD start, and records the manifest on the way", async () => {
    const client = startShim();

    const init = await client.request(1, "initialize", { protocolVersion: "2024-11-05" });
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe("fake");
    client.notify("notifications/initialized");

    const tools = await client.request(2, "tools/list");
    expect((tools.result as { tools: { name: string }[] }).tools[0]!.name).toBe("look");

    // Nothing was cached, so the only way to answer was to run it.
    expect(await spawned()).toBe(true);

    const cached = JSON.parse(await readFile(manifest, "utf8")) as Record<string, unknown>;
    expect(cached.initialize).toBeTruthy();
    expect(cached.tools).toBeTruthy();
  });

  it("answers a WARM initialize and tools/list without starting the server at all", async () => {
    // Warm the manifest, then throw that shim away.
    const cold = startShim();
    await cold.request(1, "initialize", { protocolVersion: "2024-11-05" });
    cold.notify("notifications/initialized");
    await cold.request(2, "tools/list");
    for (const child of running.splice(0)) child.kill();
    await rm(marker, { force: true });

    const warm = startShim();
    const init = await warm.request(1, "initialize", { protocolVersion: "2024-11-05" });
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe("fake");
    warm.notify("notifications/initialized");
    const tools = await warm.request(2, "tools/list");
    expect((tools.result as { tools: { name: string }[] }).tools[0]!.name).toBe("look");

    // THE ASSERTION THIS FILE EXISTS FOR: the tools are listed and the process
    // behind them has never run.
    expect(await spawned()).toBe(false);
  });

  it("starts the server on the first tools/call, and answers it", async () => {
    const cold = startShim();
    await cold.request(1, "initialize", { protocolVersion: "2024-11-05" });
    cold.notify("notifications/initialized");
    await cold.request(2, "tools/list");
    for (const child of running.splice(0)) child.kill();
    await rm(marker, { force: true });

    const warm = startShim();
    await warm.request(1, "initialize", { protocolVersion: "2024-11-05" });
    warm.notify("notifications/initialized");
    expect(await spawned()).toBe(false);

    const called = await warm.request(3, "tools/call", { name: "look" });
    expect((called.result as { content: { text: string }[] }).content[0]!.text).toBe("called look");
    // …and only NOW is there a process.
    expect(await spawned()).toBe(true);
  });

  it("shuts the real server down by CLOSING ITS STDIN, not by killing it", async () => {
    // Why it matters: `kill()` is `TerminateProcess` on Windows — no handler
    // runs — and Windows does not cascade a kill to children. `@playwright/mcp`
    // runs Chrome as a child, so a kill here strands the browser holding its
    // `--isolated` profile dir and its debugging port. Stdin EOF is the shutdown
    // an MCP stdio server is built around, and the fixture records which one it
    // got.
    const graceful = join(dir, "graceful.log");
    const child = spawn(
      process.execPath,
      [SHIM, "--manifest", manifest, "--", process.execPath, FAKE, "--marker", marker, "--graceful", graceful],
      { stdio: ["pipe", "pipe", "pipe"] },
    ) as ChildProcessWithoutNullStreams;
    running.push(child);
    const client = new Client(child);

    await client.request(1, "initialize", { protocolVersion: "2024-11-05" });
    client.notify("notifications/initialized");
    await client.request(2, "tools/call", { name: "look" }); // forces the spawn

    // The client goes away, exactly as the SDK's teardown does it.
    child.stdin.end();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    expect(await readFile(graceful, "utf8")).toContain("stdin-eof");
  });

  it("does not leak its own handshake reply to the client", async () => {
    const cold = startShim();
    await cold.request(1, "initialize", { protocolVersion: "2024-11-05" });
    cold.notify("notifications/initialized");
    await cold.request(2, "tools/list");
    for (const child of running.splice(0)) child.kill();
    await rm(marker, { force: true });

    const warm = startShim();
    await warm.request(1, "initialize", { protocolVersion: "2024-11-05" });
    warm.notify("notifications/initialized");

    // The spawn replays `initialize` against the real server using a string id.
    // If that reply reached the client it would arrive as a second answer to
    // request 1 — so ask for something else and check the answer is that, not a
    // stale handshake result that happens to be waiting in the pipe.
    const called = await warm.request(4, "tools/call", { name: "look" });
    expect(called.id).toBe(4);
    expect(called.result).toBeTruthy();
    expect((called.result as Record<string, unknown>).serverInfo).toBeUndefined();
  });
});
