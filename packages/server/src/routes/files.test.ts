/**
 * Integration tests for the file-path picker route. Real Fastify app + Store,
 * with the FileIndexService's git call replaced by a stub — the point under test
 * is the routing and root resolution, not git itself (file-index.test.ts covers
 * the listing and ranking).
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
import { FileIndexService } from "../services/file-index.js";
import { chatRoot } from "./files.js";
import type { ExecFn } from "../services/worktree.js";

let app: FastifyInstance;
let dir: string;
/** cwd of the most recent `git ls-files` — proves which root was searched. */
let lastCwd: string | null;

const FILES = ["src/auth.ts", "src/main.ts", "docs/auth.md"];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-files-"));
  lastCwd = null;
  const exec: ExecFn = async (_file, _args, opts) => {
    lastCwd = opts.cwd;
    return { stdout: FILES.join("\0"), stderr: "", exitCode: 0 };
  };
  const store = new Store(dir);
  await store.init();
  const bus = new EventBus();
  app = await buildApp({
    config: { ...loadConfig(), dataDir: dir },
    store,
    bus,
    serviceOverrides: { fileIndex: new FileIndexService({ exec }) },
  });
});

afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

async function makeChat(): Promise<{ chatId: string; projectId: string }> {
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Widget", repoPath: dir, worktreeRoot: "wt" },
  });
  const projectId = project.json().id as string;
  const chat = await app.inject({
    method: "POST",
    url: "/api/chats",
    payload: { projectId, title: "First" },
  });
  return { chatId: chat.json().id as string, projectId };
}

describe("chatRoot", () => {
  it("prefers the chat's worktree — that's where its agent actually runs", () => {
    expect(chatRoot({ worktrees: ["/wt/feature"] }, { repoPath: "/repo" })).toBe("/wt/feature");
  });

  it("falls back to the project checkout when the chat has no worktree", () => {
    expect(chatRoot({ worktrees: [] }, { repoPath: "/repo" })).toBe("/repo");
  });
});

describe("GET /api/files", () => {
  it("returns ranked matches with both path forms plus the root", async () => {
    const { chatId } = await makeChat();
    const res = await app.inject({ method: "GET", url: `/api/files?chatId=${chatId}&q=auth` });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { root: string; files: { rel: string; abs: string }[] };
    expect(body.root).toBe(dir);
    expect(body.files.map((f) => f.rel)).toEqual(["src/auth.ts", "docs/auth.md"]);
    // Absolute is what gets inserted; it has to be rooted at the chat's cwd.
    expect(body.files[0]!.abs).toBe(join(dir, "src/auth.ts"));
  });

  it("searches the chat's own working directory", async () => {
    const { chatId } = await makeChat();
    await app.inject({ method: "GET", url: `/api/files?chatId=${chatId}` });
    expect(lastCwd).toBe(dir);
  });

  it("returns the whole listing for an empty query", async () => {
    const { chatId } = await makeChat();
    const res = await app.inject({ method: "GET", url: `/api/files?chatId=${chatId}` });
    expect(res.json().files).toHaveLength(FILES.length);
  });

  it("honors an explicit limit", async () => {
    const { chatId } = await makeChat();
    const res = await app.inject({
      method: "GET",
      url: `/api/files?chatId=${chatId}&q=auth&limit=1`,
    });
    expect(res.json().files).toHaveLength(1);
  });

  it("400s without a chatId, 404s for an unknown one", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/files" });
    expect(missing.statusCode).toBe(400);
    const unknown = await app.inject({ method: "GET", url: "/api/files?chatId=nope" });
    expect(unknown.statusCode).toBe(404);
  });
});
