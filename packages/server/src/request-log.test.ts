/**
 * The API request log — what it records, what it stays quiet about, and what it
 * refuses to write down.
 *
 * Driven through a real Fastify instance with routes that fail and stall on
 * purpose, because the thing under test is the HOOKS: which Fastify lifecycle
 * events a thrown 500, a replied 500 and a slow 200 each reach. Asserting
 * against a hand-called writer would pass while the hooks were wired to the
 * wrong events.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import {
  registerRequestLog,
  REQUEST_LOG_NAME,
  REQUEST_LOG_MAX_BYTES,
  SLOW_REQUEST_MS,
} from "./request-log.js";

let dir: string;
let app: FastifyInstance;

/** The log's contents, or "" when nothing was ever written. */
async function logText(): Promise<string> {
  try {
    return await readFile(join(dir, REQUEST_LOG_NAME), "utf8");
  } catch {
    return "";
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-reqlog-"));
  app = Fastify({ logger: false });
  registerRequestLog(app, { dataDir: dir });

  app.get("/api/ok", async () => ({ ok: true }));
  app.get("/api/chats/:id/messages", async () => {
    throw Object.assign(new Error("messages.jsonl is held open"), { code: "EBUSY" });
  });
  app.get("/api/replied", async (_req, reply) => reply.code(503).send({ error: "nope" }));
  app.get("/api/slow", async () => {
    await new Promise((r) => setTimeout(r, SLOW_REQUEST_MS + 50));
    return { ok: true };
  });
  app.get("/api/metrics/growth", async () => {
    await new Promise((r) => setTimeout(r, SLOW_REQUEST_MS + 50));
    return { ok: true };
  });
});

afterEach(async () => {
  // Also the assertion that `onClose` flushes: if it did not, this `rm` would
  // race the appends and fail ENOTEMPTY on Windows — which is exactly how the
  // module-global first draft was caught.
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("requests.log", () => {
  it("writes nothing at all while the server is healthy", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "GET", url: "/api/ok" })).statusCode).toBe(200);
    }
    await app.close();
    // The whole bargain: a diagnostic that costs disk on an idle server is one
    // that gets turned off before the day it would have helped.
    expect(await logText()).toBe("");
  });

  it("records a THROWN failure ONCE, with its errno, status, duration and stack", async () => {
    const res = await app.inject({ method: "GET", url: "/api/chats/c1/messages?limit&beforeId" });
    expect(res.statusCode).toBe(500);
    await app.close();

    const text = await logText();
    // ONE line, not two. Fastify runs `onError` AND `onResponse` for a single
    // thrown request (verified against this repo's fastify), so writing in both
    // doubled the volume for exactly the failures this file exists to record.
    // Counted by timestamp, since the stack below is itself multi-line.
    expect(text.match(/^\[\d{4}-/gm) ?? []).toHaveLength(1);
    // And the one line is the COMPLETE one: `onError` cannot supply these two —
    // measured there, `elapsedTime` is 0 and `statusCode` is still 200.
    expect(text).toMatch(/failed 500 \d+ms GET \/api\/chats\/:id\/messages/);
    // The errno is the point. "500" alone does not distinguish a locked file
    // from a bug, and that distinction is the whole reason this file exists.
    expect(text).toContain("EBUSY: messages.jsonl is held open");
    // Once, not twice. Node errno messages already start with the code.
    expect(text).not.toContain("EBUSY: EBUSY");
    // ASCII only — this file is read with whatever the operator's console
    // defaults to, which on Windows PowerShell is not UTF-8.
    expect(text).not.toMatch(/[^\x00-\x7F]/);
    expect(text).toMatch(/at .+request-log\.test/); // a real stack, not just the message
    // The ROUTE pattern, so these lines group — never the interpolated id.
    expect(text).toContain("GET /api/chats/:id/messages");
  });

  it("records a REPLIED 5xx, which never reaches onError", async () => {
    expect((await app.inject({ method: "GET", url: "/api/replied" })).statusCode).toBe(503);
    await app.close();

    const text = await logText();
    expect(text).toMatch(/failed 503 \d+ms GET \/api\/replied/);
    // Also exactly one line, and no stack: nothing was thrown, so there is no
    // call path to report and the line stays a single row.
    expect(text.trimEnd().split("\n")).toHaveLength(1);
  });

  it("records a slow SUCCESS — a 200 that never came back in time looks the same from the app", async () => {
    expect((await app.inject({ method: "GET", url: "/api/slow" })).statusCode).toBe(200);
    await app.close();
    expect(await logText()).toMatch(/slow 200 \d+ms GET \/api\/slow/);
  });

  it("exempts the growth stream, which is slow by design", async () => {
    expect((await app.inject({ method: "GET", url: "/api/metrics/growth" })).statusCode).toBe(200);
    await app.close();
    // Logging this one would file the feature working correctly as a fault, and
    // train whoever reads the file to skim past the lines that matter.
    expect(await logText()).toBe("");
  });

  it("keeps query KEYS and discards their values", async () => {
    await app.inject({
      method: "GET",
      url: "/api/chats/c1/messages?limit=150&beforeId=msg-secret-id",
    });
    await app.close();

    const text = await logText();
    // Which paging call failed is diagnosis; the id it carried is user content.
    expect(text).toContain("?limit&beforeId");
    expect(text).not.toContain("msg-secret-id");
    // And the route pattern, not the interpolated id — so the lines group.
    expect(text).not.toContain("/api/chats/c1/messages");
  });

  it("rotates rather than growing without bound", async () => {
    const file = join(dir, REQUEST_LOG_NAME);
    await writeFile(file, "x".repeat(REQUEST_LOG_MAX_BYTES + 1), "utf8");

    await app.inject({ method: "GET", url: "/api/replied" });
    await app.close();

    // The oversized generation moved aside and the new line landed in a fresh
    // file — one generation kept, which is what bounds the disk cost.
    expect((await stat(`${file}.1`)).size).toBeGreaterThan(REQUEST_LOG_MAX_BYTES);
    expect(await logText()).toMatch(/^\[.+\] failed 503 /);
  });

  it("never writes when there is no data dir (the test seam)", async () => {
    const bare = Fastify({ logger: false });
    registerRequestLog(bare);
    bare.get("/api/boom", async () => {
      throw new Error("kaboom");
    });
    expect((await bare.inject({ method: "GET", url: "/api/boom" })).statusCode).toBe(500);
    await expect(bare.close()).resolves.toBeUndefined();
  });
});
