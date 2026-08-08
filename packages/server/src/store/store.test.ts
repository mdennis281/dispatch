import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./index.js";
import { renameWithRetry, writeJsonAtomic, readJson } from "./fsq.js";
import type { Project, Chat, ChatMessage, RunnerInstance, Checkpoint } from "@dispatch/shared";

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-store-"));
  store = new Store(dir);
  await store.init();
});
afterEach(async () => {
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

  it("round-trips settings with defaults", async () => {
    expect(await store.getSettings()).toMatchObject({ theme: "dark" });
    await store.saveSettings({ theme: "light", defaultModeId: "plan" });
    expect(await store.getSettings()).toMatchObject({ theme: "light", defaultModeId: "plan" });
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
    expect(existsSync(join(configDir, "checkpoints.json"))).toBe(false);

    // State root holds only the per-instance state.
    expect(existsSync(join(stateDir, "chats", "c1", "chat.json"))).toBe(true);
    expect(existsSync(join(stateDir, "checkpoints.json"))).toBe(true);
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

  it("gives up and rethrows the original error rather than retrying forever", async () => {
    let calls = 0;
    await expect(
      renameWithRetry("a.tmp", "a.json", async () => {
        calls++;
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(calls).toBe(10);
  });

  it("writeJsonAtomic still writes through and leaves no .tmp behind", async () => {
    const target = join(dir, "atomic.json");
    await writeJsonAtomic(target, { v: 1 });
    await writeJsonAtomic(target, { v: 2 });
    expect(await readJson(target)).toEqual({ v: 2 });
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
