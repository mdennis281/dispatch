/**
 * The backwards windowed transcript read, the chat-record cache it sits beside,
 * and the unvalidated scan the WorktreeDetector rebuilds history with — the three
 * pieces that took `listChats` + opening a chat from ~400ms of mostly-blocking
 * work down to ~45ms.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./index.js";
import { readJsonlLines, readJsonlTail, writeJsonAtomic } from "./fsq.js";
import type { Project, Chat } from "@dispatch/shared";

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-tail-"));
  store = new Store(dir);
  await store.init();
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function project(id: string): Project {
  return {
    id,
    name: `Project ${id}`,
    repoPath: "C:/repo",
    worktreeRoot: "C:/repo-worktrees",
    subApps: [],
    createdAt: Date.now(),
  };
}

function chat(id: string, projectId: string): Chat {
  return {
    id,
    projectId,
    title: "Untitled",
    modeId: "auto",
    effort: "medium",
    worktrees: [],
    prs: [],
    createdAt: Date.now(),
  };
}

/**
 * The tail reader backs every cursorless `readMessages({ limit })` — what opening
 * a chat, resuming a session and titling one all ask for. It reads backwards in
 * chunks, so every interesting case is about what a chunk boundary cuts through.
 */
describe("readJsonlTail — backwards windowed read", () => {
  /** `TAIL_CHUNK_BYTES` in fsq.ts. Crossing it is what puts a second read in play. */
  const CHUNK = 1024 * 1024;
  let file: string;

  beforeEach(async () => {
    await mkdir(join(dir, "tail"), { recursive: true });
    file = join(dir, "tail", "rows.jsonl");
  });

  /** Write `rows` as JSONL; return what a whole-file read sees, as the oracle. */
  async function put(rows: unknown[]): Promise<string[]> {
    await writeFile(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
    return readJsonlLines(file);
  }

  it("returns the same rows a whole-file read would, for every window size", async () => {
    const all = await put(Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, v: i })));
    for (const n of [1, 2, 7, 39, 40, 41, 1000]) {
      expect(await readJsonlTail(file, n)).toEqual(all.slice(-n));
    }
  });

  it("agrees with the whole-file read across a MULTI-CHUNK file", async () => {
    // ~2.5 chunks, so the window is assembled from more than one backwards read.
    const pad = "x".repeat(2048);
    const all = await put(
      Array.from({ length: Math.ceil((CHUNK * 2.5) / 2100) }, (_, i) => ({ id: `r${i}`, pad })),
    );
    expect(all.length).toBeGreaterThan(1200);
    for (const n of [1, 200, 700, all.length, all.length + 5]) {
      expect(await readJsonlTail(file, n)).toEqual(all.slice(-n));
    }
  });

  it("does not mangle a multi-byte character sitting ON a chunk boundary", async () => {
    // THE regression this test exists for. Decoding each chunk to a string as it
    // is read and joining the strings turns a UTF-8 sequence split by the
    // boundary into two U+FFFD halves that concatenation cannot repair — the row
    // COUNT stays right and one character silently rots, which is why only a
    // byte-for-byte oracle catches it. Found by a differential run of this
    // function against readJsonlLines over a real 353-chat store (2 bad cases in
    // 4,236); reproduced deterministically here by shimming the head one byte at
    // a time until a 3-byte character straddles the seam.
    const em = "\u2014"; // U+2014 EM DASH — 3 bytes in UTF-8
    let all: string[] = [];
    let straddled = false;
    for (let shim = 0; shim < 4 && !straddled; shim++) {
      all = await put([
        { id: "head", pad: "h".repeat(shim) + em.repeat(120_000) },
        ...Array.from({ length: 400 }, (_, i) => ({ id: `r${i}`, pad: em.repeat(1500) })),
      ]);
      const bytes = await readFile(file);
      expect(bytes.length).toBeGreaterThan(CHUNK);
      const seam = bytes[bytes.length - CHUNK]!;
      straddled = seam >= 0x80 && seam < 0xc0; // a UTF-8 continuation byte
    }
    expect(straddled).toBe(true);
    for (const n of [1, 50, 200, all.length]) {
      expect(await readJsonlTail(file, n)).toEqual(all.slice(-n));
    }
  });

  it("tolerates blank lines, a missing file and a zero window", async () => {
    await writeFile(file, '{"id":"a"}\n\n\n{"id":"b"}\n\n', "utf8");
    expect(await readJsonlTail(file, 2)).toEqual(['{"id":"a"}', '{"id":"b"}']);
    expect(await readJsonlTail(file, 1)).toEqual(['{"id":"b"}']);
    expect(await readJsonlTail(file, 0)).toEqual([]);
    expect(await readJsonlTail(join(dir, "tail", "nope.jsonl"), 10)).toEqual([]);
    await writeFile(file, "", "utf8");
    expect(await readJsonlTail(file, 5)).toEqual([]);
  });

  it("keeps a torn final line, exactly as the whole-file read does", async () => {
    // A row caught mid-append. `parseMessageLines` drops it downstream; this
    // reader's only job is to hand back the same lines either path would.
    await writeFile(file, '{"id":"a"}\n{"id":"b"}\n{"id":"c","hal', "utf8");
    expect(await readJsonlTail(file, 3)).toEqual(await readJsonlLines(file));
    expect(await readJsonlTail(file, 2)).toEqual(['{"id":"b"}', '{"id":"c","hal']);
  });
});

describe("Store chat record cache", () => {
  it("serves a saved chat without re-reading, and writes through on every mutation", async () => {
    await store.saveProject(project("p1"));
    await store.saveChat(chat("c1", "p1"));

    // A record edited on disk BEHIND the store is not picked up — that is the
    // documented deal (this process is the only writer of dataDir), and asserting
    // it means the cache is provably in play rather than accidentally cold.
    await writeJsonAtomic(join(dir, "chats", "c1", "chat.json"), {
      ...chat("c1", "p1"),
      title: "edited behind us",
    });
    expect((await store.getChat("c1"))?.title).toBe("Untitled");

    // Every mutation path refreshes it.
    await store.patchChat("c1", { title: "patched" });
    expect((await store.getChat("c1"))?.title).toBe("patched");
    await store.saveChat({ ...chat("c1", "p1"), title: "saved" });
    expect((await store.getChat("c1"))?.title).toBe("saved");
    await store.deleteChat("c1");
    expect(await store.getChat("c1")).toBeNull();
  });

  it("sees a chat directory that appears underneath it, and forgets one that leaves", async () => {
    // `backsync.mjs` copies whole chat dirs into a state root, so `listChats`
    // re-reads the directory every call and must notice both directions.
    await store.saveProject(project("p1"));
    await store.saveChat(chat("c1", "p1"));
    expect((await store.listChats("p1")).map((c) => c.id)).toEqual(["c1"]);

    await mkdir(join(dir, "chats", "c2"), { recursive: true });
    await writeJsonAtomic(join(dir, "chats", "c2", "chat.json"), chat("c2", "p1"));
    expect((await store.listChats("p1")).map((c) => c.id).sort()).toEqual(["c1", "c2"]);

    await rm(join(dir, "chats", "c2"), { recursive: true, force: true });
    expect((await store.listChats("p1")).map((c) => c.id)).toEqual(["c1"]);
  });

  it("keeps updatedAt tracking the transcript, which the cache deliberately skips", async () => {
    await store.saveProject(project("p1"));
    const saved = await store.saveChat(chat("c1", "p1"));
    await new Promise((r) => setTimeout(r, 12));
    await store.appendMessage({ kind: "user", id: "m1", chatId: "c1", ts: 1, text: "hi" });
    const after = await store.getChat("c1");
    expect(after!.updatedAt!).toBeGreaterThan(saved.updatedAt ?? saved.createdAt);
  });
});

describe("Store.scanMessages — unvalidated transcript walk", () => {
  it("yields every row as plain JSON, including ones zod would reject", async () => {
    await store.appendMessage({ kind: "user", id: "m1", chatId: "c9", ts: 1, text: "hi" });
    await store.appendMessage({
      kind: "tool_use",
      id: "m2",
      chatId: "c9",
      ts: 2,
      toolUseId: "t1",
      name: "Bash",
      input: { command: "echo hi" },
    });
    const rows: Record<string, unknown>[] = [];
    await store.scanMessages("c9", (r) => rows.push(r));
    expect(rows.map((r) => r.id)).toEqual(["m1", "m2"]);
    expect((rows[1]!.input as { command: string }).command).toBe("echo hi");

    // An unknown `kind` still comes through — callers narrow what they read — and
    // a torn trailing line is skipped rather than thrown on.
    await writeFile(store.chatTranscriptPath("c9"), '{"id":"x","kind":"nonsense"}\n{"tor', {
      flag: "a",
      encoding: "utf8",
    });
    const rows2: Record<string, unknown>[] = [];
    await store.scanMessages("c9", (r) => rows2.push(r));
    expect(rows2.map((r) => r.id)).toEqual(["m1", "m2", "x"]);
  });

  it("is silent on a chat with no transcript", async () => {
    const rows: unknown[] = [];
    await store.scanMessages("never-existed", (r) => rows.push(r));
    expect(rows).toEqual([]);
  });
});
