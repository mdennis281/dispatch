/**
 * Integration tests for the 2b Wire-data endpoints: chat image upload + serve,
 * the Monaco worktree file read (working tree + path guard), and the checkpoints
 * snapshot. Real Fastify app on a temp dataDir; no SDK / git / network needed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";

/** A 1×1 transparent PNG. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-assets-"));
  const store = new Store(dir);
  await store.init();
  const config = { ...loadConfig(), dataDir: dir };
  app = await buildApp({ config, store, bus: new EventBus() });
});

afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

async function makeChat(): Promise<string> {
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Widget", repoPath: dir, worktreeRoot: "wt" },
  });
  const projectId = project.json().id as string;
  const chat = await app.inject({
    method: "POST",
    url: "/api/chats",
    payload: { projectId, title: "Images" },
  });
  return chat.json().id as string;
}

describe("chat assets", () => {
  it("uploads a base64 image → ImageRef and serves the bytes back", async () => {
    const chatId = await makeChat();
    const up = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/assets`,
      payload: { data: PNG_B64, mimeType: "image/png", alt: "dot", width: 1, height: 1 },
    });
    expect(up.statusCode).toBe(201);
    const ref = up.json() as { id: string; path: string; mimeType: string; width?: number };
    expect(ref.path).toMatch(/^assets\/.+\.png$/);
    expect(ref.mimeType).toBe("image/png");
    expect(ref.width).toBe(1);

    const name = ref.path.split("/").pop()!;
    const got = await app.inject({ method: "GET", url: `/api/chats/${chatId}/assets/${name}` });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toContain("image/png");
    expect(got.rawPayload.length).toBe(Buffer.from(PNG_B64, "base64").length);
  });

  it("accepts an upload larger than Fastify's 1 MiB JSON default (bodyLimit raised)", async () => {
    const chatId = await makeChat();
    // ~2 MiB of bytes → base64 ~2.7 MiB, so the JSON body blows past Fastify's
    // 1 MiB default. Regresses the annotator "Payload Too Large" on Apply.
    const big = Buffer.alloc(2 * 1024 * 1024, 7).toString("base64");
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const up = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/assets`,
      payload: { data: big, mimeType: "image/png" },
    });
    expect(up.statusCode).toBe(201);
    expect((up.json() as { path: string }).path).toMatch(/^assets\/.+\.png$/);
  });

  it("accepts a data: URL and drops a bad width", async () => {
    const chatId = await makeChat();
    const up = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/assets`,
      payload: { data: `data:image/png;base64,${PNG_B64}`, width: 1.5 },
    });
    expect(up.statusCode).toBe(201);
    const ref = up.json() as { path: string; mimeType: string; width?: number };
    expect(ref.mimeType).toBe("image/png");
    expect(ref.width).toBeUndefined();
  });

  it("rejects an empty body and a missing chat", async () => {
    const chatId = await makeChat();
    const bad = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/assets`,
      payload: {},
    });
    expect(bad.statusCode).toBe(400);

    const noChat = await app.inject({
      method: "POST",
      url: `/api/chats/nope/assets`,
      payload: { data: PNG_B64 },
    });
    expect(noChat.statusCode).toBe(404);

    const miss = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/assets/does-not-exist.png`,
    });
    expect(miss.statusCode).toBe(404);
  });
});

describe("worktree file read (Monaco)", () => {
  it("reads a working-tree file and guards traversal", async () => {
    const wt = await mkdtemp(join(tmpdir(), "cm-wt-"));
    try {
      await mkdir(join(wt, "src"), { recursive: true });
      await writeFile(join(wt, "src", "a.ts"), "export const a = 1;\n", "utf8");

      const ok = await app.inject({
        method: "GET",
        url: `/api/worktrees/file?worktreePath=${encodeURIComponent(wt)}&relPath=${encodeURIComponent("src/a.ts")}`,
      });
      expect(ok.statusCode).toBe(200);
      const file = ok.json() as { content: string; exists: boolean; binary: boolean; encoding: string };
      expect(file.exists).toBe(true);
      expect(file.binary).toBe(false);
      expect(file.encoding).toBe("utf8");
      expect(file.content).toContain("export const a = 1;");

      const missing = await app.inject({
        method: "GET",
        url: `/api/worktrees/file?worktreePath=${encodeURIComponent(wt)}&relPath=nope.ts`,
      });
      expect(missing.statusCode).toBe(200);
      expect((missing.json() as { exists: boolean }).exists).toBe(false);

      const traversal = await app.inject({
        method: "GET",
        url: `/api/worktrees/file?worktreePath=${encodeURIComponent(wt)}&relPath=${encodeURIComponent("../escape.txt")}`,
      });
      expect(traversal.statusCode).toBe(400);
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });
});

describe("chat checkpoints snapshot", () => {
  it("returns [] for a chat with no checkpoints", async () => {
    const chatId = await makeChat();
    const res = await app.inject({ method: "GET", url: `/api/chats/${chatId}/checkpoints` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe("asset range requests", () => {
  /**
   * `<video>` refuses to expose a seek bar unless the server answers 206, so
   * these are the difference between "a recording plays" and "a recording is
   * watchable".
   */
  const BODY = Buffer.from("0123456789");
  const B64 = BODY.toString("base64");

  async function upload(): Promise<{ chatId: string; name: string }> {
    const chatId = await makeChat();
    const up = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/assets`,
      payload: { data: B64, mimeType: "video/mp4", filename: "clip.mp4" },
    });
    expect(up.statusCode).toBe(201);
    const ref = up.json() as { path: string };
    return { chatId, name: ref.path.split("/").pop()! };
  }

  it("stores a video under its own extension and media type", async () => {
    const { chatId, name } = await upload();
    expect(name.endsWith(".mp4")).toBe(true);
    const got = await app.inject({ method: "GET", url: `/api/chats/${chatId}/assets/${name}` });
    expect(got.headers["content-type"]).toContain("video/mp4");
  });

  it("advertises accept-ranges on the FIRST, rangeless response", async () => {
    // A browser decides whether to seek by looking for this header here; omit
    // it and it never asks for a range at all.
    const { chatId, name } = await upload();
    const got = await app.inject({ method: "GET", url: `/api/chats/${chatId}/assets/${name}` });
    expect(got.statusCode).toBe(200);
    expect(got.headers["accept-ranges"]).toBe("bytes");
  });

  it("answers a closed range with 206 and just those bytes", async () => {
    const { chatId, name } = await upload();
    const got = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/assets/${name}`,
      headers: { range: "bytes=2-5" },
    });
    expect(got.statusCode).toBe(206);
    expect(got.headers["content-range"]).toBe("bytes 2-5/10");
    expect(got.rawPayload.toString()).toBe("2345");
  });

  it("answers an open-ended range to the end of the file", async () => {
    const { chatId, name } = await upload();
    const got = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/assets/${name}`,
      headers: { range: "bytes=7-" },
    });
    expect(got.statusCode).toBe(206);
    expect(got.headers["content-range"]).toBe("bytes 7-9/10");
    expect(got.rawPayload.toString()).toBe("789");
  });

  it("reads a suffix range as the LAST n bytes, not the first", async () => {
    const { chatId, name } = await upload();
    const got = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/assets/${name}`,
      headers: { range: "bytes=-3" },
    });
    expect(got.statusCode).toBe(206);
    expect(got.rawPayload.toString()).toBe("789");
  });

  it("clamps an end past EOF instead of failing", async () => {
    const { chatId, name } = await upload();
    const got = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/assets/${name}`,
      headers: { range: "bytes=8-99" },
    });
    expect(got.statusCode).toBe(206);
    expect(got.headers["content-range"]).toBe("bytes 8-9/10");
  });

  it("416s a start past EOF", async () => {
    const { chatId, name } = await upload();
    const got = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/assets/${name}`,
      headers: { range: "bytes=50-60" },
    });
    expect(got.statusCode).toBe(416);
    expect(got.headers["content-range"]).toBe("bytes */10");
  });

  it("falls back to the whole file for a malformed or multi-range header", async () => {
    const { chatId, name } = await upload();
    for (const range of ["rows=1-2", "bytes=abc", "bytes=0-1,4-5"]) {
      const got = await app.inject({
        method: "GET",
        url: `/api/chats/${chatId}/assets/${name}`,
        headers: { range },
      });
      expect(got.statusCode).toBe(200);
      expect(got.rawPayload.length).toBe(BODY.length);
    }
  });
});
