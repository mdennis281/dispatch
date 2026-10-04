/**
 * The backwards windowed transcript read, the chat-record cache it sits beside,
 * and the unvalidated scan the WorktreeDetector rebuilds history with — the three
 * pieces that took `listChats` + opening a chat from ~400ms of mostly-blocking
 * work down to ~45ms.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./index.js";
import { readFull, readJsonlLines, readJsonlTail, writeJsonAtomic } from "./fsq.js";
import type { Project, Chat } from "@dispatch/shared";

/**
 * An opt-in seam over `readdir`. `vi.spyOn` cannot reach it — the Store binds the
 * named ESM import at load — so the module is mocked, but the mock passes
 * straight through to the real implementation unless a test sets the override.
 */
const hoisted = vi.hoisted(() => ({
  readdirOverride: null as null | (() => Promise<never>),
  /**
   * Fail the next N `open`/`readFile` calls with this code, then pass through.
   * Models the scanner that holds a transcript open for a few hundred ms — the
   * contention the read path now retries. Counted so a test can assert the
   * retry actually happened rather than that the read merely succeeded.
   */
  failReads: null as null | { code: string; remaining: number; attempts: number },
}));
function maybeFailRead(): Error | null {
  const f = hoisted.failReads;
  if (!f) return null;
  f.attempts++;
  if (f.remaining <= 0) return null;
  f.remaining--;
  return Object.assign(new Error(f.code), { code: f.code });
}
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) =>
      hoisted.readdirOverride ? hoisted.readdirOverride() : actual.readdir(...args),
    open: (...args: Parameters<typeof actual.open>) => {
      const err = maybeFailRead();
      return err ? Promise.reject(err) : actual.open(...args);
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      const err = maybeFailRead();
      return err ? Promise.reject(err) : actual.readFile(...args);
    },
  };
});

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-tail-"));
  store = new Store(dir);
  await store.init();
});
afterEach(async () => {
  hoisted.readdirOverride = null;
  hoisted.failReads = null;
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

describe("readFull — short reads", () => {
  /** A reader that hands back at most `perCall` bytes, like a real short read. */
  function dribbler(content: Buffer, perCall: number) {
    return {
      calls: 0,
      async read(buf: Buffer, offset: number, length: number, position: number) {
        this.calls++;
        const n = Math.min(perCall, length, Math.max(0, content.length - position));
        content.copy(buf, offset, position, position + n);
        return { bytesRead: n };
      },
    };
  }

  it("keeps reading until the buffer is full", async () => {
    const content = Buffer.from("abcdefghij");
    const fh = dribbler(content, 3);
    const buf = Buffer.alloc(10);
    expect(await readFull(fh, buf, 0)).toBe(10);
    expect(buf.toString()).toBe("abcdefghij");
    expect(fh.calls).toBeGreaterThan(1); // it really did take several reads
  });

  it("stops at EOF and reports only what it got, never the uninitialised tail", async () => {
    // The buffer is 8 long but only 5 bytes exist. Anything past 5 is whatever
    // was on the heap, so readFull must report 5 and let the caller slice.
    const fh = dribbler(Buffer.from("abcde"), 3);
    const buf = Buffer.alloc(8, 0x7a); // 'z' filler stands in for heap garbage
    expect(await readFull(fh, buf, 0)).toBe(5);
    expect(buf.subarray(0, 5).toString()).toBe("abcde");
  });

  it("reads from an offset", async () => {
    const fh = dribbler(Buffer.from("0123456789"), 2);
    const buf = Buffer.alloc(4);
    expect(await readFull(fh, buf, 6)).toBe(4);
    expect(buf.toString()).toBe("6789");
  });
});

describe("Store.listChats — error handling", () => {
  // `init()` creates `chats/`, so these use an UN-INITIALISED Store: its
  // constructor touches no disk (StateDb only mkdirs in `open()`), which is what
  // lets the directory genuinely be absent or be the wrong kind of thing.
  it("reports no chats when the dir is simply absent (ENOENT)", async () => {
    const bare = await mkdtemp(join(tmpdir(), "cm-bare-"));
    expect(await new Store(bare).listChats()).toEqual([]);
    await rm(bare, { recursive: true, force: true });
  });

  it("reports no chats when the path is not a directory (ENOTDIR)", async () => {
    const bare = await mkdtemp(join(tmpdir(), "cm-bare-"));
    await writeFile(join(bare, "chats"), "not a directory", "utf8");
    expect(await new Store(bare).listChats()).toEqual([]);
    await rm(bare, { recursive: true, force: true });
  });

  it("does NOT swallow a real failure like EACCES", async () => {
    // Returning [] on an unreadable dir would tell the sidebar the store is
    // empty and let the WorktreeDetector conclude no chat owns any worktree —
    // a wrong answer dressed up as a normal one. `readdir` is faked rather than
    // provoked because there is no portable way to make a real one fail EACCES
    // across the Linux and Windows CI jobs.
    hoisted.readdirOverride = () =>
      Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await expect(store.listChats()).rejects.toThrow("permission denied");
  });
});

/* ------------------------------------------- read-side contention (Windows) */

/**
 * The read half of the lesson `renameWithRetry` taught the write half.
 *
 * A scanner holding `messages.jsonl` open without FILE_SHARE_READ makes the
 * reader's `open` fail EBUSY/EPERM/EACCES for as long as it holds on. Writes
 * have ridden that out since the EPERM-on-rename fix; reads caught only ENOENT
 * and threw everything else, so one transient lock became a 500 on
 * `GET /api/chats/:id/messages` — which the client rendered as the chat having
 * no messages in it. These pin the policy; the real handle was verified by hand
 * (a PowerShell holder with share mode None), since provoking it costs a second
 * process and asserts nothing off Windows.
 */
describe("transcript reads ride out transient file-sharing contention", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => JSON.stringify({ id: `m${i}`, v: i })).join("\n") + "\n";

  it("readJsonlTail retries a locked open and returns the real rows", async () => {
    const file = join(dir, "t.jsonl");
    await writeFile(file, rows(5), "utf8");

    hoisted.failReads = { code: "EBUSY", remaining: 2, attempts: 0 };
    const lines = await readJsonlTail(file, 3);

    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!)).toMatchObject({ id: "m4" });
    // Two rejections plus the one that worked: the retry ran, rather than the
    // read happening to dodge the lock.
    expect(hoisted.failReads.attempts).toBe(3);
  });

  it("readJsonlLines retries a locked read too", async () => {
    const file = join(dir, "l.jsonl");
    await writeFile(file, rows(4), "utf8");

    hoisted.failReads = { code: "EPERM", remaining: 2, attempts: 0 };
    expect(await readJsonlLines(file)).toHaveLength(4);
    expect(hoisted.failReads.attempts).toBe(3);
  });

  it("a missing file is still absence, not contention — answered at once", async () => {
    hoisted.failReads = { code: "ENOENT", remaining: 99, attempts: 0 };
    expect(await readJsonlTail(join(dir, "nope.jsonl"), 10)).toEqual([]);
    // ONE attempt. Retrying absence would put ~1.3s of backoff in front of
    // every read of a chat that has not written its first row yet.
    expect(hoisted.failReads.attempts).toBe(1);
  });

  it("gives up on a lock that never clears rather than hanging forever", async () => {
    const file = join(dir, "held.jsonl");
    await writeFile(file, rows(2), "utf8");

    hoisted.failReads = { code: "EBUSY", remaining: 99, attempts: 0 };
    await expect(readJsonlTail(file, 2)).rejects.toMatchObject({ code: "EBUSY" });
    // The budget is 10 attempts (~1.3s). A file genuinely pinned open is a real
    // error and must surface as one; hiding it behind an unbounded retry would
    // move the hang somewhere worse.
    expect(hoisted.failReads.attempts).toBe(10);
  });

  it("the whole windowed read survives it — readMessages, not just the primitive", async () => {
    await store.saveChat(chat("c-busy", "p1"));
    for (let i = 0; i < 4; i++) {
      await store.appendMessage({
        kind: "user",
        id: `msg-${i}`,
        chatId: "c-busy",
        ts: 1000 + i,
        text: `hello ${i}`,
      });
    }

    hoisted.failReads = { code: "EBUSY", remaining: 2, attempts: 0 };
    const got = await store.readMessages("c-busy", { limit: 2 });

    expect(got.map((m) => m.id)).toEqual(["msg-2", "msg-3"]);
  });
});
