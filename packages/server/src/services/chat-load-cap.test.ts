import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, ChatStatus } from "@dispatch/shared";
import { Store } from "../store/index.js";
import {
  chatTotalsByProject,
  listCappedChats,
  pinnedChatIds,
  type LoadCapDeps,
} from "./chat-load-cap.js";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-10-07T12:00:00.000Z");

let dir: string;
let store: Store;
let statuses: Record<string, ChatStatus>;
let attention: Array<{ chatId: string }>;
let projectRetention: Record<string, { maxChatsPerProject?: number }>;

function deps(): LoadCapDeps {
  return {
    getStatus: (chatId) => statuses[chatId],
    attention: { list: () => attention as never },
    projectRetention: (projectId) => projectRetention[projectId],
  };
}

/** `ageDays` back from NOW, so "newest" is unambiguous in each assertion. */
async function chat(id: string, projectId: string, ageDays: number): Promise<Chat> {
  return store.saveChat({
    id,
    projectId,
    title: id,
    harness: "claude",
    modeId: "default",
    status: "idle",
    effort: "medium",
    worktrees: [],
    prs: [],
    createdAt: NOW - ageDays * DAY,
    updatedAt: NOW - ageDays * DAY,
  } as Chat);
}

const ids = (chats: Chat[]) => chats.map((c) => c.id).sort();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-loadcap-"));
  store = new Store(dir);
  await store.init();
  statuses = {};
  attention = [];
  projectRetention = {};
});

afterEach(async () => {
  // Close before unlinking: the SQLite handle holds `state.db-shm` open and the
  // rm fails EBUSY on Windows, which surfaces as every test in the file failing.
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("listCappedChats", () => {
  it("ships the newest N per project and leaves the rest on disk", async () => {
    await store.saveSettings({ theme: "dark", retention: { maxChatsPerProject: 2 } });
    await chat("a-new", "a", 1);
    await chat("a-mid", "a", 2);
    await chat("a-old", "a", 3);

    expect(ids(await listCappedChats(store, deps()))).toEqual(["a-mid", "a-new"]);
    // Nothing was deleted — the cap is a read, not a sweep.
    expect(await store.getChat("a-old")).not.toBeNull();
  });

  it("caps each project independently", async () => {
    await store.saveSettings({ theme: "dark", retention: { maxChatsPerProject: 1 } });
    await chat("a1", "a", 1);
    await chat("a2", "a", 2);
    await chat("b1", "b", 5);
    await chat("b2", "b", 6);

    expect(ids(await listCappedChats(store, deps()))).toEqual(["a1", "b1"]);
  });

  it("applies the same cap whether the fetch is scoped or not", async () => {
    // The ordering trap: cap before the project filter and a scoped fetch
    // returns a different set for that project than the unscoped one did.
    await store.saveSettings({ theme: "dark", retention: { maxChatsPerProject: 1 } });
    await chat("a1", "a", 1);
    await chat("a2", "a", 2);
    await chat("b1", "b", 0);

    const scoped = await listCappedChats(store, deps(), { projectId: "a" });
    expect(ids(scoped)).toEqual(["a1"]);
  });

  it("?all=1 bypasses the cap — the escape hatch the sidebar footer uses", async () => {
    await store.saveSettings({ theme: "dark", retention: { maxChatsPerProject: 1 } });
    await chat("a1", "a", 1);
    await chat("a2", "a", 2);

    expect(ids(await listCappedChats(store, deps(), { all: true }))).toEqual(["a1", "a2"]);
  });

  it("loads everything when the cap is 0", async () => {
    await store.saveSettings({ theme: "dark", retention: { maxChatsPerProject: 0 } });
    await chat("a1", "a", 1);
    await chat("a2", "a", 900);

    expect(await listCappedChats(store, deps())).toHaveLength(2);
  });

  it("lets a project override the cap without affecting its neighbour", async () => {
    await store.saveSettings({ theme: "dark", retention: { maxChatsPerProject: 1 } });
    projectRetention["a"] = { maxChatsPerProject: 2 };
    await chat("a1", "a", 1);
    await chat("a2", "a", 2);
    await chat("b1", "b", 1);
    await chat("b2", "b", 2);

    expect(ids(await listCappedChats(store, deps()))).toEqual(["a1", "a2", "b1"]);
  });

  it("keeps a live chat the recency cap would have dropped", async () => {
    await store.saveSettings({ theme: "dark", retention: { maxChatsPerProject: 1 } });
    await chat("fresh", "a", 0);
    await chat("running", "a", 40);
    statuses["running"] = "running";

    expect(ids(await listCappedChats(store, deps()))).toEqual(["running"]);
  });

  it("keeps a chat with an attention item, however old", async () => {
    await store.saveSettings({ theme: "dark", retention: { maxChatsPerProject: 1 } });
    await chat("fresh", "a", 0);
    await chat("asking", "a", 40);
    attention = [{ chatId: "asking" }];

    expect(ids(await listCappedChats(store, deps()))).toEqual(["asking"]);
  });
});

describe("pinnedChatIds", () => {
  it("pins every status except idle", async () => {
    const chats = [
      await chat("idle-one", "a", 1),
      await chat("running-one", "a", 1),
      await chat("waiting-one", "a", 1),
      await chat("asking-one", "a", 1),
    ];
    statuses = {
      "idle-one": "idle",
      "running-one": "running",
      "waiting-one": "waiting",
      "asking-one": "awaiting-input",
    };

    expect([...pinnedChatIds(deps(), chats)].sort()).toEqual([
      "asking-one",
      "running-one",
      "waiting-one",
    ]);
  });
});

describe("chatTotalsByProject", () => {
  it("counts every chat on disk, not the capped set", async () => {
    await store.saveSettings({ theme: "dark", retention: { maxChatsPerProject: 1 } });
    await chat("a1", "a", 1);
    await chat("a2", "a", 2);
    await chat("a3", "a", 3);
    await chat("b1", "b", 1);

    const { totals, limit } = await chatTotalsByProject(store);
    expect(totals).toEqual({ a: 3, b: 1 });
    expect(limit).toBe(1);
  });

  it("reports the default cap when nothing is configured", async () => {
    await chat("a1", "a", 1);
    expect((await chatTotalsByProject(store)).limit).toBe(200);
  });
});
