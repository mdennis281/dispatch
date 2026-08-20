/**
 * Path traversal through entity ids — the attack this guard exists to stop.
 *
 * Real Fastify app on a real Store in a temp dir, driven through `app.inject`
 * so the ids travel the actual router (which is half the point: the escape only
 * works because a SINGLE-SEGMENT percent-encoded traversal survives routing).
 *
 * Every test here puts a real file or directory OUTSIDE the store root and
 * asserts it is untouched afterwards. Asserting the status code alone would
 * pass against a server that returns 400 and does the damage anyway.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { SessionBroker } from "../services/session-broker.js";

/** Root holding BOTH the store and the bystander files a traversal would reach. */
let sandbox: string;
let dir: string;
let store: Store;
let app: FastifyInstance;
/** A file and a directory one level above the store — the traversal's targets. */
let victimFile: string;
let victimDir: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "cm-trav-"));
  dir = join(sandbox, "state");
  await mkdir(dir, { recursive: true });

  victimFile = join(sandbox, "chat.json");
  await writeFile(victimFile, JSON.stringify({ secret: "do not read me" }), "utf8");
  victimDir = join(sandbox, "precious");
  await mkdir(victimDir, { recursive: true });
  await writeFile(join(victimDir, "keep.txt"), "irreplaceable", "utf8");

  store = new Store(dir);
  await store.init();
  const bus = new EventBus();
  // The broker never runs a turn in these tests; a query that is never called
  // keeps the app buildable without a scripted SDK.
  const broker = new SessionBroker({
    store,
    bus,
    deps: { query: (() => { throw new Error("not used"); }) as never },
  });
  app = await buildApp({
    config: { ...loadConfig(), dataDir: dir },
    store,
    bus,
    serviceOverrides: { broker },
  });
});

afterEach(async () => {
  await app?.close();
  store?.close();
  await rm(sandbox, { recursive: true, force: true });
});

/** Every spelling that reaches `../../<name>` through the router, plus friends. */
const ESCAPES = [
  "..%2f..%2fchat",             // encoded slash — the one that gets through
  "%2e%2e%2f%2e%2e%2fchat",     // encoded dots AND slashes
  "..%5c..%5cchat",             // encoded backslash (Windows separator)
  "%2e%2e",                     // just ".."
  "a%2fb",                      // a nested path where a flat id was meant
];

describe("entity ids cannot escape the store root", () => {
  it("GET /api/chats/:id refuses a traversal and reads nothing outside", async () => {
    for (const id of ESCAPES) {
      const res = await app.inject({ method: "GET", url: `/api/chats/${id}` });
      expect([400, 404]).toContain(res.statusCode);
      // The decisive part: the bystander's contents never appear in a response.
      expect(res.body).not.toContain("do not read me");
    }
  });

  it("GET /api/chats/:id/messages refuses a traversal", async () => {
    for (const id of ESCAPES) {
      const res = await app.inject({ method: "GET", url: `/api/chats/${id}/messages` });
      expect([400, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain("do not read me");
    }
  });

  it("DELETE /api/chats/:id does not remove a directory outside the store", async () => {
    // The worst of the lot: deleteChat is `rm(chatDir(id), { recursive: true,
    // force: true })`, so an unguarded id is authenticated arbitrary rmdir.
    for (const id of ["..%2fprecious", "%2e%2e%2fprecious", "..%5cprecious"]) {
      const res = await app.inject({ method: "DELETE", url: `/api/chats/${id}` });
      expect(res.statusCode).not.toBe(204);
      expect(existsSync(victimDir)).toBe(true);
      expect(existsSync(join(victimDir, "keep.txt"))).toBe(true);
    }
  });

  it("POST /api/projects refuses a client-supplied id that escapes", async () => {
    // The WRITE side, and it needed no traversal trick at all: the route took
    // `body.id` verbatim, so the attacker simply names the destination.
    const before = await readdir(sandbox);
    for (const id of ["../../pwned", "..\\..\\pwned", "a/b", "sub/../../pwned"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { id, name: "Evil", repoPath: dir, worktreeRoot: "wt" },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(await readdir(sandbox)).toEqual(before);
    expect(existsSync(join(dirname(sandbox), "pwned.json"))).toBe(false);
  });

  it("POST /api/agents and /api/modes refuse one too", async () => {
    for (const url of ["/api/agents", "/api/modes"]) {
      const res = await app.inject({
        method: "POST",
        url,
        payload: { id: "../../pwned", name: "Evil" },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(existsSync(join(sandbox, "pwned.json"))).toBe(false);
  });

  it("still serves ordinary ids — the guard must not cost a real workflow", async () => {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Widget", repoPath: dir, worktreeRoot: "wt" },
    });
    expect(project.statusCode).toBe(201);
    const projectId = project.json().id as string;

    const chat = await app.inject({
      method: "POST",
      url: "/api/chats",
      payload: { projectId, title: "First" },
    });
    expect(chat.statusCode).toBe(201);
    const chatId = chat.json().id as string;

    expect((await app.inject({ method: "GET", url: `/api/chats/${chatId}` })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: `/api/chats/${chatId}/messages` })).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/chats/${chatId}` })).statusCode).toBe(
      204,
    );

    // A hand-written slug id is legitimate and must keep working — `hivebreak`
    // and `auto` are seeded exactly that way.
    const slug = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { id: "hand-written_id2", name: "Slug", repoPath: dir, worktreeRoot: "wt" },
    });
    expect(slug.statusCode).toBe(201);
    expect(slug.json().id).toBe("hand-written_id2");
  });
});
