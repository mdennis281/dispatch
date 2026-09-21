/**
 * /api/debug/trace — the phone's interaction recordings.
 *
 * Two things a careless version gets wrong: the read path must not take a
 * caller-supplied name to the filesystem (the directory is under the data
 * root), and the save must actually be readable back, or "send" on the phone
 * succeeds while the desktop viewer lists nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";

let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-trace-"));
  const store = new Store(dir);
  await store.init();
  app = await buildApp({ config: { ...loadConfig(), dataDir: dir }, store, bus: new EventBus() });
});

afterEach(async () => {
  await app.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

describe("/api/debug/trace", () => {
  it("saves a recording and lists and returns it", async () => {
    const body = { meta: { startedAt: "x" }, entries: [{ t: 0, k: "note", text: "hi" }] };
    const saved = await app.inject({ method: "POST", url: "/api/debug/trace", payload: body });
    expect(saved.statusCode).toBe(200);
    const { name } = saved.json() as { name: string };
    expect(name).toMatch(/\.json$/);

    const list = await app.inject({ method: "GET", url: "/api/debug/trace" });
    expect((list.json() as Array<{ name: string }>).map((f) => f.name)).toEqual([name]);

    const got = await app.inject({ method: "GET", url: `/api/debug/trace/${name}` });
    expect(got.statusCode).toBe(200);
    const record = got.json() as typeof body & { savedAt: string };
    expect(record.entries).toEqual(body.entries);
    expect(record.savedAt).toBeTruthy();
  });

  it("refuses a body without entries", async () => {
    const res = await app.inject({ method: "POST", url: "/api/debug/trace", payload: { meta: {} } });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a name that is not one it minted", async () => {
    for (const name of ["..%2F..%2Fstate.db", "state.db", "x.json"]) {
      const res = await app.inject({ method: "GET", url: `/api/debug/trace/${name}` });
      expect(res.statusCode, name).toBe(400);
    }
    const missing = await app.inject({
      method: "GET",
      url: "/api/debug/trace/2026-01-01T00-00-00-000Z.json",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("lists an empty directory as empty", async () => {
    const list = await app.inject({ method: "GET", url: "/api/debug/trace" });
    expect(list.json()).toEqual([]);
  });
});
