import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./index.js";
import type { Project, Chat, ChatMessage, RunnerInstance, Checkpoint } from "@cm/shared";

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
