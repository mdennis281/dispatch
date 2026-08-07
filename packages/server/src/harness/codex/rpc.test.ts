import { describe, it, expect, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import {
  CodexConnection,
  acquireCodexConnection,
  disposeSharedCodexConnection,
  type CodexProcess,
} from "./rpc.js";

/**
 * A scripted stand-in for `codex app-server`: we read what the connection
 * writes and push frames back on our own schedule, so transport behaviour is
 * testable without spawning anything.
 */
function fakeProcess() {
  const stdout = new PassThrough();
  const written: Record<string, unknown>[] = [];
  let exitCb: ((code: number | null) => void) | undefined;
  let ended = false;

  const proc: CodexProcess = {
    stdin: {
      write: (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (line.trim()) written.push(JSON.parse(line) as Record<string, unknown>);
        }
      },
      end: () => {
        ended = true;
      },
    },
    stdout,
    kill: () => stdout.end(),
    on: (_e, cb) => {
      exitCb = cb;
    },
  };

  return {
    proc,
    written,
    get ended() {
      return ended;
    },
    /** Push a frame from the "server". */
    push: (frame: unknown) => stdout.write(JSON.stringify(frame) + "\n"),
    pushRaw: (line: string) => stdout.write(line + "\n"),
    exit: (code: number | null) => exitCb?.(code),
    /** Wait for the connection to have written `n` frames. */
    async settle(n = 1) {
      for (let i = 0; i < 200 && written.length < n; i++) {
        await new Promise((r) => setImmediate(r));
      }
      return written;
    },
  };
}

/** A connection whose handshake has already completed. */
async function connected() {
  const fake = fakeProcess();
  const conn = new CodexConnection({ exePath: "codex", spawnProcess: () => fake.proc });
  const ready = conn.ready();
  await fake.settle(1);
  // Answer the initialize request the connection just sent.
  const init = fake.written[0]!;
  fake.push({ jsonrpc: "2.0", id: init.id, result: { userAgent: "fake" } });
  await ready;
  return { fake, conn };
}

afterEach(() => disposeSharedCodexConnection());

describe("CodexConnection handshake", () => {
  it("sends initialize with the experimental API opted in, then notifies initialized", async () => {
    const { fake } = await connected();
    expect(fake.written[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: { capabilities: { experimentalApi: true } },
    });
    await fake.settle(2);
    expect(fake.written[1]).toMatchObject({ method: "initialized" });
  });

  it("only performs the handshake once no matter how many callers await it", async () => {
    const { fake, conn } = await connected();
    await Promise.all([conn.ready(), conn.ready()]);
    expect(fake.written.filter((f) => f.method === "initialize")).toHaveLength(1);
  });
});

describe("CodexConnection request correlation", () => {
  it("resolves a response to the request that asked for it", async () => {
    const { fake, conn } = await connected();
    const a = conn.request("model/list", {});
    const b = conn.request("account/rateLimits/read", undefined);
    await fake.settle(4);
    const [, , reqA, reqB] = fake.written;
    // Answer out of order — correlation must be by id, not arrival.
    fake.push({ jsonrpc: "2.0", id: reqB!.id, result: { rateLimits: { planType: "pro" } } });
    fake.push({ jsonrpc: "2.0", id: reqA!.id, result: { data: [{ id: "gpt-5.6-sol" }] } });
    await expect(a).resolves.toEqual({ data: [{ id: "gpt-5.6-sol" }] });
    await expect(b).resolves.toEqual({ rateLimits: { planType: "pro" } });
  });

  it("rejects when the server answers with an error", async () => {
    const { fake, conn } = await connected();
    const p = conn.request("turn/start", {});
    await fake.settle(3);
    fake.push({ jsonrpc: "2.0", id: fake.written[2]!.id, error: { message: "no such thread" } });
    await expect(p).rejects.toThrow("no such thread");
  });

  it("survives a non-JSON diagnostic line without killing the reader", async () => {
    const { fake, conn } = await connected();
    fake.pushRaw("warning: something happened");
    const p = conn.request("model/list", {});
    await fake.settle(3);
    fake.push({ jsonrpc: "2.0", id: fake.written[2]!.id, result: { data: [] } });
    await expect(p).resolves.toEqual({ data: [] });
  });
});

describe("CodexConnection routing", () => {
  it("delivers a notification to the listener for its thread only", async () => {
    const { fake, conn } = await connected();
    const mine: string[] = [];
    const theirs: string[] = [];
    conn.onThread("t-1", (f) => mine.push(f.method!));
    conn.onThread("t-2", (f) => theirs.push(f.method!));

    fake.push({ jsonrpc: "2.0", method: "item/started", params: { threadId: "t-1" } });
    await new Promise((r) => setImmediate(r));
    expect(mine).toEqual(["item/started"]);
    expect(theirs).toEqual([]);
  });

  it("finds the thread id nested under `thread` on thread/started", async () => {
    const { fake, conn } = await connected();
    const seen: string[] = [];
    conn.onThread("t-1", (f) => seen.push(f.method!));
    fake.push({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "t-1" } } });
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(["thread/started"]);
  });

  it("sends account-level notifications to global listeners", async () => {
    const { fake, conn } = await connected();
    const seen: unknown[] = [];
    conn.onGlobal((f) => seen.push(f.method));
    fake.push({ jsonrpc: "2.0", method: "account/rateLimits/updated", params: { rateLimits: {} } });
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(["account/rateLimits/updated"]);
  });

  it("stops delivering after unsubscribe", async () => {
    const { fake, conn } = await connected();
    const seen: string[] = [];
    const off = conn.onThread("t-1", (f) => seen.push(f.method!));
    off();
    fake.push({ jsonrpc: "2.0", method: "item/started", params: { threadId: "t-1" } });
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([]);
  });

  it("routes a server request to its thread's handler", async () => {
    const { fake, conn } = await connected();
    const got: string[] = [];
    conn.onRequest("t-1", (req) => got.push(req.method));
    fake.push({
      jsonrpc: "2.0",
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t-1", command: "ls" },
    });
    await new Promise((r) => setImmediate(r));
    expect(got).toEqual(["item/commandExecution/requestApproval"]);
  });

  it("auto-answers an unroutable server request so the agent cannot wedge", async () => {
    const { fake, conn } = await connected();
    void conn;
    fake.push({ jsonrpc: "2.0", id: 42, method: "item/tool/requestUserInput", params: { threadId: "ghost" } });
    const written = await fake.settle(3);
    expect(written.at(-1)).toMatchObject({ id: 42, result: {} });
  });
});

describe("CodexConnection death", () => {
  it("rejects everything in flight when the process exits", async () => {
    const { fake, conn } = await connected();
    const p = conn.request("turn/start", {});
    await fake.settle(3);
    fake.exit(1);
    await expect(p).rejects.toThrow(/exited/);
    expect(conn.isClosed()).toBe(true);
  });

  it("refuses new requests once closed", async () => {
    const { fake, conn } = await connected();
    fake.exit(0);
    await expect(conn.request("model/list", {})).rejects.toThrow();
  });
});

describe("acquireCodexConnection", () => {
  it("shares one process across sessions and only tears down on the last release", async () => {
    const made: number[] = [];
    const spawnProcess = () => {
      made.push(1);
      return fakeProcess().proc;
    };
    const a = acquireCodexConnection({ exePath: "codex", spawnProcess });
    const b = acquireCodexConnection({ exePath: "codex", spawnProcess });
    expect(a.conn).toBe(b.conn);

    a.release();
    expect(a.conn.isClosed()).toBe(false);
    b.release();
    expect(a.conn.isClosed()).toBe(true);
  });

  it("is idempotent per holder, so a double release cannot kill a live process", async () => {
    const spawnProcess = () => fakeProcess().proc;
    const a = acquireCodexConnection({ exePath: "codex", spawnProcess });
    const b = acquireCodexConnection({ exePath: "codex", spawnProcess });
    a.release();
    a.release();
    expect(b.conn.isClosed()).toBe(false);
    b.release();
  });

  it("does not hand out a dead connection", async () => {
    const spawnProcess = () => fakeProcess().proc;
    const first = acquireCodexConnection({ exePath: "codex", spawnProcess });
    first.conn.dispose();
    const second = acquireCodexConnection({ exePath: "codex", spawnProcess });
    expect(second.conn).not.toBe(first.conn);
    second.release();
  });
});
