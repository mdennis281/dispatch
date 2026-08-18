import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./index.js";
import { STATE_DB_FILENAME } from "./db.js";
import { DatabaseSync } from "node:sqlite";
import { renameWithRetry, writeJsonAtomic, readJson } from "./fsq.js";
import type { Project, Chat, ChatMessage, RunnerInstance, Checkpoint, PrRecord } from "@dispatch/shared";
import { PrRecordSchema } from "@dispatch/shared";

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-store-"));
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

/** A complete PrRecord minus its key — every default filled in, as a real caller has. */
function pr(number: number, title: string): Omit<PrRecord, "key"> {
  const { key: _key, ...rest } = PrRecordSchema.parse({
    key: `owner/repo#${number}`,
    repo: "owner/repo",
    number,
    title,
    url: `https://example.test/${number}`,
    firstSeenAt: 1,
    lastChangedAt: 1,
  });
  return rest;
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

describe("Store projects/chats CRUD", () => {
  it("saves, reads, lists, and deletes a project", async () => {
    await store.saveProject(project("p1"));
    expect(await store.getProject("p1")).toMatchObject({ id: "p1", name: "Project p1" });
    expect(await store.listProjects()).toHaveLength(1);
    await store.deleteProject("p1");
    expect(await store.getProject("p1")).toBeNull();
    expect(await store.listProjects()).toHaveLength(0);
  });

  it("scopes listChats by projectId and deletes chat dir", async () => {
    await store.saveChat(chat("c1", "p1"));
    await store.saveChat(chat("c2", "p2"));
    expect(await store.listChats()).toHaveLength(2);
    expect(await store.listChats("p1")).toHaveLength(1);
    await store.deleteChat("c1");
    expect(await store.getChat("c1")).toBeNull();
    expect(await store.listChats()).toHaveLength(1);
  });

  it("patches a chat atomically without changing unrelated metadata", async () => {
    await store.saveChat({ ...chat("c1", "p1"), title: "Keep me", updatedAt: 123 });

    const saved = await store.patchChat("c1", { status: "waiting" });

    expect(saved).toMatchObject({ title: "Keep me", status: "waiting", updatedAt: 123 });
    expect(await store.patchChat("missing", { status: "error" })).toBeNull();
  });

  it("reports updatedAt as last TRANSCRIPT activity, not last chat-record write", async () => {
    // A chat record written long ago; appending rows never rewrites chat.json,
    // so without the mtime fold the sidebar would sort this by its stale stamp.
    await store.saveChat({ ...chat("c1", "p1"), createdAt: 1000, updatedAt: 1000 });
    expect((await store.getChat("c1"))?.updatedAt).toBe(1000);

    await store.appendMessage({
      kind: "notice",
      id: "n1",
      chatId: "c1",
      ts: 2000,
      level: "info",
      text: "hi",
    });
    const after = (await store.getChat("c1"))!.updatedAt!;
    expect(after).toBeGreaterThan(1000);
    // listChats sees the same clock (it is what the sidebar sorts on).
    expect((await store.listChats("p1"))[0]!.updatedAt).toBe(after);
  });

  it("keeps the record's own updatedAt when a chat has no transcript yet", async () => {
    await store.saveChat({ ...chat("c9", "p1"), createdAt: 500, updatedAt: 900 });
    expect((await store.getChat("c9"))?.updatedAt).toBe(900);
  });

  it("rejects invalid data on write (zod)", async () => {
    // Missing required fields -> schema throws.
    await expect(store.saveProject({ id: "bad" } as unknown as Project)).rejects.toBeTruthy();
  });
});

describe("Store JSONL transcript", () => {
  it("appends and reads back messages in order", async () => {
    const rows: ChatMessage[] = [
      { kind: "user", id: "m1", chatId: "c1", ts: 1, text: "hi" },
      { kind: "assistant", id: "m2", chatId: "c1", ts: 2, text: "hello" },
      {
        kind: "tool_use",
        id: "m3",
        chatId: "c1",
        ts: 3,
        toolUseId: "t1",
        name: "Bash",
        input: { command: "echo hi" },
      },
    ];
    for (const r of rows) await store.appendMessage(r);
    const back = await store.readMessages("c1");
    expect(back.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(back[2]).toMatchObject({ kind: "tool_use", name: "Bash" });
  });

  it("supports afterId and limit", async () => {
    for (let i = 1; i <= 5; i++) {
      await store.appendMessage({ kind: "notice", id: `n${i}`, chatId: "c2", ts: i, level: "info", text: String(i) });
    }
    expect((await store.readMessages("c2", { afterId: "n2" })).map((m) => m.id)).toEqual(["n3", "n4", "n5"]);
    expect((await store.readMessages("c2", { limit: 2 })).map((m) => m.id)).toEqual(["n4", "n5"]);
    expect(await store.readMessages("nope")).toEqual([]);
  });

  it("pages backwards with beforeId (the window above what the client holds)", async () => {
    for (let i = 1; i <= 10; i++) {
      await store.appendMessage({ kind: "notice", id: `b${i}`, chatId: "c4", ts: i, level: "info", text: String(i) });
    }
    // The newest page, then the page above it — how the client walks upward.
    const newest = await store.readMessages("c4", { limit: 3 });
    expect(newest.map((m) => m.id)).toEqual(["b8", "b9", "b10"]);
    const older = await store.readMessages("c4", { limit: 3, beforeId: newest[0]!.id });
    expect(older.map((m) => m.id)).toEqual(["b5", "b6", "b7"]);
    // Walking off the top returns a SHORT page — that's how the client learns it
    // has reached the beginning and stops asking.
    const top = await store.readMessages("c4", { limit: 10, beforeId: "b3" });
    expect(top.map((m) => m.id)).toEqual(["b1", "b2"]);
    expect(await store.readMessages("c4", { limit: 5, beforeId: "b1" })).toEqual([]);
  });

  it("beforeId + afterId bound the window from both ends", async () => {
    for (let i = 1; i <= 6; i++) {
      await store.appendMessage({ kind: "notice", id: `w${i}`, chatId: "c5", ts: i, level: "info", text: String(i) });
    }
    const mid = await store.readMessages("c5", { afterId: "w1", beforeId: "w6" });
    expect(mid.map((m) => m.id)).toEqual(["w2", "w3", "w4", "w5"]);
    // An unknown cursor is ignored rather than emptying the window.
    expect((await store.readMessages("c5", { beforeId: "nope" })).map((m) => m.id)).toHaveLength(6);
  });

  it("reads specific rows by id (hydrate-on-expand)", async () => {
    for (let i = 1; i <= 5; i++) {
      await store.appendMessage({ kind: "notice", id: `h${i}`, chatId: "c6", ts: i, level: "info", text: String(i) });
    }
    // File order, not argument order; unknown ids are simply absent.
    const rows = await store.readMessagesByIds("c6", ["h4", "h2", "missing"]);
    expect(rows.map((m) => m.id)).toEqual(["h2", "h4"]);
    expect(await store.readMessagesByIds("c6", [])).toEqual([]);
  });

  it("does not confuse a row id with the same string inside another row's payload", async () => {
    await store.appendMessage({
      kind: "tool_result",
      id: "r1",
      chatId: "c7",
      ts: 1,
      toolUseId: "t1",
      ok: true,
      // A decoy: the NEXT row's id appears verbatim inside this row's content.
      content: 'grep output: {"id":"r2"}',
    });
    await store.appendMessage({ kind: "notice", id: "r2", chatId: "c7", ts: 2, level: "info", text: "real" });
    expect((await store.readMessagesByIds("c7", ["r2"])).map((m) => m.id)).toEqual(["r2"]);
    expect((await store.readMessages("c7", { afterId: "r1" })).map((m) => m.id)).toEqual(["r2"]);
  });

  it("serializes concurrent appends without loss", async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.appendMessage({ kind: "notice", id: `x${i}`, chatId: "c3", ts: i, level: "info", text: String(i) }),
      ),
    );
    expect(await store.readMessages("c3")).toHaveLength(25);
  });
});

describe("Store runners + checkpoints + settings", () => {
  it("upserts and deletes runners", async () => {
    const r: RunnerInstance = {
      id: "r1",
      worktreePath: "C:/wt",
      subAppId: "game",
      kind: "process",
      status: "running",
      port: 5173,
    };
    await store.saveRunner(r);
    await store.saveRunner({ ...r, status: "stopped" });
    expect(await store.getRunner("r1")).toMatchObject({ status: "stopped" });
    expect(await store.listRunners()).toHaveLength(1);
    await store.deleteRunner("r1");
    expect(await store.getRunner("r1")).toBeNull();
  });

  it("stores checkpoints per chat/message", async () => {
    const cp: Checkpoint = { messageId: "m1", chatId: "c1", ref: "refs/cm/x", createdAt: Date.now() };
    await store.saveCheckpoint(cp);
    expect(await store.getCheckpoint("c1", "m1")).toMatchObject({ ref: "refs/cm/x" });
    expect(await store.getCheckpoints("c1")).toHaveLength(1);
    await store.deleteCheckpoints("c1");
    expect(await store.getCheckpoints("c1")).toHaveLength(0);
  });

  it("keeps roster order across an update, rather than moving the row to the end", async () => {
    // The JSON array these replaced was read in insertion order, and several
    // panels render it that way. An upsert must not resort the roster just
    // because a runner reported a new status.
    const mk = (id: string): RunnerInstance => ({
      id,
      worktreePath: "C:/wt",
      subAppId: "game",
      kind: "process",
      status: "running",
    });
    for (const id of ["a", "b", "c"]) await store.saveRunner(mk(id));
    await store.saveRunner({ ...mk("a"), status: "stopped" });
    expect((await store.listRunners()).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("upserts a checkpoint in place and scopes deletes to one chat", async () => {
    const at = Date.now();
    await store.saveCheckpoint({ messageId: "m1", chatId: "c1", ref: "refs/cm/one", createdAt: at });
    await store.saveCheckpoint({ messageId: "m2", chatId: "c1", ref: "refs/cm/two", createdAt: at });
    await store.saveCheckpoint({ messageId: "m1", chatId: "c2", ref: "refs/cm/other", createdAt: at });
    // Same chat + message: one row, rewritten — not a second rollback point.
    await store.saveCheckpoint({ messageId: "m1", chatId: "c1", ref: "refs/cm/redone", createdAt: at });

    expect((await store.getCheckpoints("c1")).map((c) => c.ref)).toEqual([
      "refs/cm/redone",
      "refs/cm/two",
    ]);
    await store.deleteCheckpoints("c1");
    expect(await store.getCheckpoints("c1")).toHaveLength(0);
    // Deleting a chat must not cost another chat its rollback points.
    expect(await store.getCheckpoints("c2")).toHaveLength(1);
  });

  it("drops a row it cannot even parse, instead of losing the whole roster", async () => {
    // The tolerant readers (PRs, MCP port leases) used to face one JSON document
    // per file: a malformed row could not exist, because the whole file either
    // parsed or it didn't. Row by row it can — and letting `JSON.parse` throw
    // ahead of the schema check would cost the entire catalog for one bad record,
    // which is the exact opposite of what those readers are for.
    await store.upsertPrRecord("owner/repo#1", pr(1, "good"));
    // Reach past the API to plant the corruption a torn disk write would leave.
    const db = new DatabaseSync(join(dir, STATE_DB_FILENAME));
    db.prepare("INSERT INTO pr (key, body) VALUES (?, ?)").run("owner/repo#2", "{not json");
    db.close();

    expect((await store.listPrRecords()).map((p) => p.key)).toEqual(["owner/repo#1"]);
    expect(await store.getPrRecord("owner/repo#2")).toBeNull();
    // …and the next poll simply replaces it, rather than being wedged out.
    const healed = await store.upsertPrRecord("owner/repo#2", pr(2, "rewritten"));
    expect(healed.title).toBe("rewritten");
    expect(await store.listPrRecords()).toHaveLength(2);
  });

  it("round-trips settings with defaults", async () => {
    expect(await store.getSettings()).toMatchObject({ theme: "dark" });
    await store.saveSettings({ theme: "light", defaultModeId: "plan" });
    expect(await store.getSettings()).toMatchObject({ theme: "light", defaultModeId: "plan" });
  });

  it("leaves updateChannel unset, which every pre-channel install reads as stable", async () => {
    // Deliberately not `.default("stable")`: a default would make the field
    // REQUIRED in the inferred type and invalidate every existing AppSettings
    // literal, and "unset" and "stable" mean the same thing to every reader.
    expect((await store.getSettings()).updateChannel).toBeUndefined();
    await store.saveSettings({ theme: "dark", updateChannel: "unstable" });
    expect((await store.getSettings()).updateChannel).toBe("unstable");
  });
});

describe("Store config/state split", () => {
  let stateDir: string;
  let configDir: string;
  let split: Store;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "cm-state-"));
    configDir = await mkdtemp(join(tmpdir(), "cm-config-"));
    split = new Store(stateDir, configDir);
    await split.init();
  });
  afterEach(async () => {
    split.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  it("writes config entities under configDir and state under dataDir", async () => {
    await split.saveProject(project("p1"));
    await split.saveMode({ id: "auto", name: "Auto", permissionMode: "acceptEdits", scope: "global" });
    await split.saveSettings({ theme: "light" });
    await split.saveChat(chat("c1", "p1"));
    await split.saveCheckpoint({
      messageId: "m1", chatId: "c1", ref: "refs/cm/x", createdAt: Date.now(),
    });

    // Config root holds the shareable entities...
    expect(existsSync(join(configDir, "projects", "p1.json"))).toBe(true);
    expect(existsSync(join(configDir, "modes", "auto.json"))).toBe(true);
    expect(existsSync(join(configDir, "config.json"))).toBe(true);
    // ...and NONE of the per-instance state.
    expect(existsSync(join(configDir, "chats"))).toBe(false);
    expect(existsSync(join(configDir, STATE_DB_FILENAME))).toBe(false);

    // State root holds only the per-instance state: transcripts as files, and
    // everything that used to be a whole-file JSON map inside the database.
    expect(existsSync(join(stateDir, "chats", "c1", "chat.json"))).toBe(true);
    expect(existsSync(join(stateDir, STATE_DB_FILENAME))).toBe(true);
    expect(await split.getCheckpoints("c1")).toHaveLength(1);
    expect(existsSync(join(stateDir, "projects", "p1.json"))).toBe(false);
  });

  it("lets a second instance share config while keeping its own chats", async () => {
    await split.saveProject(project("shared"));
    await split.saveChat(chat("mine", "shared"));

    const otherState = await mkdtemp(join(tmpdir(), "cm-state2-"));
    try {
      const other = new Store(otherState, configDir);
      await other.init();
      // Sees the shared project...
      expect(await other.listProjects()).toHaveLength(1);
      // ...but not the first instance's chats.
      expect(await other.listChats()).toHaveLength(0);
      other.close();
    } finally {
      await rm(otherState, { recursive: true, force: true });
    }
  });

  it("defaults configDir to dataDir (single-root layout unchanged)", async () => {
    const only = await mkdtemp(join(tmpdir(), "cm-single-"));
    try {
      const s = new Store(only);
      await s.init();
      await s.saveProject(project("p"));
      await s.saveChat(chat("c", "p"));
      expect(existsSync(join(only, "projects", "p.json"))).toBe(true);
      expect(existsSync(join(only, "chats", "c", "chat.json"))).toBe(true);
      expect(existsSync(join(only, STATE_DB_FILENAME))).toBe(true);
      s.close();
    } finally {
      await rm(only, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------- atomic write under a lock */

describe("renameWithRetry — Windows destination contention", () => {
  // Reproduced on a real box: a foreign process holding runners.json open with
  // share mode Read / ReadWrite / None makes the replace-existing rename fail
  // `EPERM: operation not permitted, rename '…tmp' -> 'runners.json'` — the
  // failure that took out runner.test.ts under parallel agent load. The holder
  // is a virus scanner or indexer, so it lets go within a few hundred ms.
  //
  // These drive the policy through the injected rename rather than a real lock.
  // Provoking the genuine handle costs a spawned process and a sleep, and would
  // assert nothing anywhere but Windows — so the real-lock case was verified by
  // hand (a PowerShell holder against the built writeJsonAtomic: EPERM before
  // this change, clean write 600ms later after it) and the policy itself — which
  // codes retry, how many times, what is rethrown — is pinned here, fast and
  // deterministic.

  it("rides out a burst of EPERM and then succeeds", async () => {
    let calls = 0;
    await renameWithRetry("a.tmp", "a.json", async () => {
      if (++calls < 4) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    expect(calls).toBe(4);
  });

  it("retries EACCES and EBUSY too — same cause, different code", async () => {
    for (const code of ["EACCES", "EBUSY"]) {
      let calls = 0;
      await renameWithRetry("a.tmp", "a.json", async () => {
        if (++calls < 3) throw Object.assign(new Error(code), { code });
      });
      expect(calls).toBe(3);
    }
  });

  it("does NOT retry an unrelated error — a missing temp file is a real bug", async () => {
    let calls = 0;
    await expect(
      renameWithRetry("a.tmp", "a.json", async () => {
        calls++;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  it("gives up and rethrows the FIRST error rather than retrying forever", async () => {
    // Every attempt throws a DISTINGUISHABLE error. The previous version of this
    // test threw an identical EPERM each time and asserted only `code`, so it
    // passed whether the first or the tenth came back — which is how the
    // implementation came to throw the latest one while the docblock promised
    // the original, and why review caught it and this test did not. The
    // difference matters: the tenth is raised ~1.3s into backoff, by which point
    // the callers above have unwound and its stack no longer names the write
    // that was lost.
    let calls = 0;
    const thrown: Error[] = [];
    await expect(
      renameWithRetry("a.tmp", "a.json", async () => {
        const err = Object.assign(new Error(`EPERM attempt ${++calls}`), { code: "EPERM" });
        thrown.push(err);
        throw err;
      }),
    ).rejects.toBe(thrown[0]);
    expect(calls).toBe(10);
    expect(thrown[0]?.message).toBe("EPERM attempt 1");
  });

  it("writeJsonAtomic still writes through and leaves no .tmp behind", async () => {
    const target = join(dir, "atomic.json");
    await writeJsonAtomic(target, { v: 1 });
    await writeJsonAtomic(target, { v: 2 });
    expect(await readJson(target)).toEqual({ v: 2 });
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("worktree records", () => {
  const wtFile = () => join(dir, "worktrees.json");

  it("applies `create` fields only on insert, `update` always", async () => {
    await store.upsertWorktreeRecord("/wt/a", {
      projectId: "p1",
      branch: "feat/a",
      chatId: "c1",
      origin: "tool",
    });
    // A later caller that only re-saw the path must NOT restate it as external
    // and orphan it — that was the whole reason for splitting the two arguments.
    const after = await store.upsertWorktreeRecord("/wt/a", {
      projectId: "p1",
      branch: "feat/a",
      origin: "external",
    });
    expect(after).toMatchObject({ origin: "tool", chatId: "c1" });

    const updated = await store.upsertWorktreeRecord(
      "/wt/a",
      { projectId: "p1", branch: "feat/a", origin: "external" },
      { chatId: "c2" },
    );
    expect(updated).toMatchObject({ origin: "tool", chatId: "c2" });
  });

  it("syncWorktreeRecords back-fills, drops the gone, and no-ops when unchanged", async () => {
    const live = [{ path: "/wt/a", branch: "feat/a" }];
    await store.syncWorktreeRecords("p1", live, { now: 1_000 });
    expect(await store.listWorktreeRecords()).toMatchObject([
      { path: "/wt/a", origin: "external", createdAt: 1_000, lastSeenAt: 1_000 },
    ]);

    // Nothing changed and the row isn't stale → the file must not be rewritten,
    // because list() runs on every panel refresh and this is on that path.
    const before = await readJson(wtFile());
    await store.syncWorktreeRecords("p1", live, { now: 1_500 });
    expect(await readJson(wtFile())).toEqual(before);

    // Git stopped reporting it → the row goes. Git owns existence.
    await store.syncWorktreeRecords("p1", [], { now: 2_000 });
    expect(await store.listWorktreeRecords()).toEqual([]);
  });

  it("only reconciles the project it was given", async () => {
    await store.upsertWorktreeRecord("/wt/other", {
      projectId: "p2",
      branch: "feat/other",
      origin: "tool",
    });
    await store.syncWorktreeRecords("p1", [], { now: 1_000 });
    expect((await store.listWorktreeRecords()).map((r) => r.path)).toEqual([
      "/wt/other",
    ]);
  });

  it("refreshes lastSeenAt on a branch change and on a stale row", async () => {
    await store.syncWorktreeRecords("p1", [{ path: "/wt/a", branch: "feat/a" }], {
      now: 1_000,
    });
    await store.syncWorktreeRecords("p1", [{ path: "/wt/a", branch: "feat/b" }], {
      now: 1_100,
    });
    expect(await store.listWorktreeRecords()).toMatchObject([
      { branch: "feat/b", lastSeenAt: 1_100 },
    ]);

    await store.syncWorktreeRecords("p1", [{ path: "/wt/a", branch: "feat/b" }], {
      now: 1_100 + 10 * 60_000,
    });
    expect((await store.listWorktreeRecords())[0]!.lastSeenAt).toBe(1_100 + 10 * 60_000);
  });

  it("matches paths through the caller's key fn (case-folding on Windows)", async () => {
    await store.upsertWorktreeRecord("/WT/A", {
      projectId: "p1",
      branch: "feat/a",
      chatId: "c1",
      origin: "tool",
    });
    const out = await store.syncWorktreeRecords(
      "p1",
      [{ path: "/wt/a", branch: "feat/a" }],
      { now: 2_000, key: (p) => p.toLowerCase() },
    );
    // One row, still attributed — not a second, anonymous back-fill.
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path: "/WT/A", chatId: "c1", origin: "tool" });
  });

  it("appends a large batch and reads every line back", async () => {
    // A write-behind flush of a dev server's output is routinely this size,
    // which is why `appendTerminalLines` makes it ONE write rather than one per
    // line. What's observable from here is that the batch round-trips intact.
    const rows = Array.from({ length: 500 }, (_, i) => ({
      stream: "stdout" as const,
      chunk: `line ${i}`,
      ts: 1_000 + i,
    }));
    await store.appendTerminalLines("log1", rows);
    const back = await store.readTerminalLines("log1");
    expect(back).toHaveLength(500);
    expect(back[0]!.chunk).toBe("line 0");
    expect(back[499]!.chunk).toBe("line 499");
  });

  it("round-trips a batch and filters it on the way back", async () => {
    await store.appendTerminalLines("log2", [
      { stream: "command", chunk: "pnpm build", ts: 1_000 },
      { stream: "stdout", chunk: "compiled", ts: 1_100 },
      { stream: "stderr", chunk: "deprecated", ts: 1_200 },
    ]);
    expect(await store.readTerminalLines("log2")).toHaveLength(3);
    expect(
      (await store.readTerminalLines("log2", { stream: "stderr" })).map((l) => l.chunk),
    ).toEqual(["deprecated"]);
    expect(
      (await store.readTerminalLines("log2", { since: 1_100 })).map((l) => l.chunk),
    ).toEqual(["compiled", "deprecated"]);
    expect((await store.readTerminalLines("log2", { q: "compil" })).map((l) => l.chunk)).toEqual([
      "compiled",
    ]);
    expect((await store.readTerminalLines("log2", { tail: 1 })).map((l) => l.chunk)).toEqual([
      "deprecated",
    ]);

    // Retention rewrites the file, keeping only what's inside the window.
    expect(await store.pruneTerminalLog("log2", 1_150)).toMatchObject({ lines: 1 });
    expect((await store.readTerminalLines("log2")).map((l) => l.chunk)).toEqual(["deprecated"]);
  });

  it("drops a terminal's transcript with its row, in one step", async () => {
    // These were two file operations — a whole-file rewrite of terminals.json
    // and an unlink of terminals/<logId>.jsonl — with a crash window between
    // them that stranded a transcript no roster row referenced.
    await store.saveTerminalRecord({
      id: "c1::build",
      logId: "log-build",
      chatId: "c1",
      name: "build",
      cwd: "C:/wt",
      origin: "agent",
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
      lines: 0,
      bytes: 0,
    });
    await store.appendTerminalLines("log-build", [
      { stream: "stdout", chunk: "hello", ts: 1_000 },
    ]);
    const removed = await store.deleteTerminalRecord("c1::build");
    expect(removed).toMatchObject({ logId: "log-build" });
    expect(await store.listTerminalRecords()).toHaveLength(0);
    expect(await store.readTerminalLines("log-build")).toHaveLength(0);
    // Deleting again is a no-op, not a throw — the reaper runs on stale rosters.
    expect(await store.deleteTerminalRecord("c1::build")).toBeNull();
  });

  it("windows `tail` AFTER `q`, so it means the last N that MATCHED", async () => {
    // The two are separate code paths now (a bare tail is `ORDER BY seq DESC
    // LIMIT n` in SQL; a `q` scan filters in JS because SQLite's lower() folds
    // ASCII only). They have to agree on what tail means.
    await store.appendTerminalLines(
      "log3",
      Array.from({ length: 10 }, (_, i) => ({
        stream: "stdout" as const,
        chunk: i % 2 === 0 ? `hit ${i}` : `miss ${i}`,
        ts: 1_000 + i,
      })),
    );
    expect((await store.readTerminalLines("log3", { q: "hit", tail: 2 })).map((l) => l.chunk)).toEqual([
      "hit 6",
      "hit 8",
    ]);
    // …and a non-ASCII haystack still folds the way String.toLowerCase does.
    await store.appendTerminalLines("log3", [
      { stream: "stdout", chunk: "\u00c9CHEC de la build", ts: 2_000 },
    ]);
    expect((await store.readTerminalLines("log3", { q: "\u00e9chec" })).map((l) => l.chunk)).toEqual([
      "\u00c9CHEC de la build",
    ]);
  });

  it("deletes a record by path", async () => {
    await store.upsertWorktreeRecord("/wt/a", {
      projectId: "p1",
      branch: "feat/a",
      origin: "ui",
    });
    expect(await store.getWorktreeRecord("/wt/a")).not.toBeNull();
    await store.deleteWorktreeRecord("/wt/a");
    expect(await store.getWorktreeRecord("/wt/a")).toBeNull();
  });
});
