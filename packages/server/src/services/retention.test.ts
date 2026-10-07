import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, PrRecord } from "@dispatch/shared";
import { Store } from "../store/index.js";
import {
  AGED_CHAT_DELETE_LIMIT,
  RetentionService,
  REVIEWER_CHAT_RETENTION_MS,
  TOOL_IMAGE_RETENTION_MS,
  classifyAssets,
} from "./retention.js";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let dir: string;
let store: Store;
let now: number;
let deleted: string[];
let busy: Set<string>;
let logs: string[];
let sweptRepoFor: ((chatId: string) => Promise<string | null>) | undefined;

function service(): RetentionService {
  return new RetentionService({
    store,
    checkpoints: {
      sweepMissingWorktrees: async (repoFor) => {
        sweptRepoFor = repoFor;
        return { rows: 0, refs: 0, skipped: 0 };
      },
    },
    deleteChat: async (chatId) => {
      deleted.push(chatId);
      await store.deleteChat(chatId);
    },
    isBusy: (chatId) => busy.has(chatId),
    now: () => now,
    log: (line) => logs.push(line),
  });
}

async function chat(id: string, extra: Partial<Chat> = {}): Promise<Chat> {
  return store.saveChat({
    id,
    projectId: "p1",
    title: id,
    harness: "claude",
    modeId: "default",
    status: "idle",
    effort: "medium",
    worktrees: [],
    prs: [],
    createdAt: NOW - 60 * DAY,
    updatedAt: NOW - 60 * DAY,
    ...extra,
  } as Chat);
}

async function pr(key: string, fields: Partial<PrRecord>): Promise<void> {
  const [repo, number] = key.split("#");
  await store.upsertPrRecord(key, {
    repo: repo!,
    number: Number(number),
    url: `https://github.com/${repo}/pull/${number}`,
    firstSeenAt: NOW - 90 * DAY,
    lastChangedAt: NOW - 90 * DAY,
    ...fields,
  } as Omit<PrRecord, "key">);
}

async function transcript(chatId: string, rows: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(
    store.chatTranscriptPath(chatId),
    rows.map((r, i) => JSON.stringify({ id: `r${i}`, chatId, turn: 1, ...r })).join("\n") + "\n",
  );
}

const toolImage = (name: string, ts: number) => ({
  kind: "tool_result",
  ts,
  toolUseId: `t-${name}`,
  ok: true,
  content: [{ type: "image", media_type: "image/png", asset: `assets/${name}` }],
  images: [{ id: `i-${name}`, path: `assets/${name}`, mimeType: "image/png" }],
});
const userImage = (name: string, ts: number) => ({
  kind: "user",
  ts,
  text: "look at this",
  images: [{ id: `u-${name}`, path: `assets/${name}`, mimeType: "image/png" }],
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-retention-"));
  store = new Store(dir);
  await store.init();
  now = NOW;
  deleted = [];
  busy = new Set();
  logs = [];
  sweptRepoFor = undefined;
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("reviewer chats", () => {
  const long = new Date(NOW - REVIEWER_CHAT_RETENTION_MS - DAY).toISOString();
  const recent = new Date(NOW - REVIEWER_CHAT_RETENTION_MS + DAY).toISOString();

  it("deletes a reviewer once its PR has been settled past the window", async () => {
    await pr("o/r#1", { state: "merged", mergedAt: long });
    await pr("o/r#2", { state: "closed", closedAt: long });
    await chat("merged-long-ago", { reviewOf: "o/r#1", purpose: { kind: "pr:review" } });
    // A reviewer from before `reviewOf` existed: the label is its only pointer.
    await chat("legacy", { purpose: { kind: "pr:review", label: "Reviewing PR #2 in o/r" } });

    const report = await service().sweep();

    expect(report.reviewerChats.deleted.sort()).toEqual(["legacy", "merged-long-ago"]);
    expect(await store.getChat("legacy")).toBeNull();
    expect(logs.some((l) => l.includes("deleted 2 reviewer chat(s)"))).toBe(true);
  });

  it("keeps every reviewer that has not provably finished its useful life", async () => {
    await pr("o/r#3", { state: "merged", mergedAt: recent });
    await pr("o/r#4", { state: "open" });
    await pr("o/r#5", { state: "merged", mergedAt: long });
    await chat("merged-recently", { reviewOf: "o/r#3" });
    await chat("still-open", { reviewOf: "o/r#4" });
    await chat("never-tracked", { reviewOf: "o/r#404" });
    await chat("unnamed-target", { purpose: { kind: "pr:review", label: "Reviewing a pull request" } });
    await chat("mid-turn", { reviewOf: "o/r#5" });
    busy.add("mid-turn");
    // Not a reviewer at all, on a PR that settled long ago.
    await chat("author", { prs: [{ number: 5, url: "u", branch: "b", repo: "o/r", state: "merged" }] });

    const report = await service().sweep();

    expect(report.reviewerChats.deleted).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("falls back to the catalog's change stamp when GitHub gave no settle time", async () => {
    await pr("o/r#6", { state: "merged", lastChangedAt: NOW - REVIEWER_CHAT_RETENTION_MS - DAY });
    await chat("stamped", { reviewOf: "o/r#6" });

    expect((await service().sweep()).reviewerChats.deleted).toEqual(["stamped"]);
  });
});

describe("tool-output images", () => {
  const old = NOW - TOOL_IMAGE_RETENTION_MS - DAY;
  const young = NOW - TOOL_IMAGE_RETENTION_MS + DAY;

  async function seed(): Promise<void> {
    await chat("c1");
    for (const name of ["old.png", "young.png", "mine.png", "stray.png", "both.png"]) {
      await store.writeChatAsset("c1", name, PNG);
    }
    await store.writeChatAsset("c1", "clip.mp4", Buffer.from("not really a video"));
    await transcript("c1", [
      toolImage("old.png", old),
      toolImage("young.png", young),
      userImage("mine.png", old),
      // Returned by a tool AND attached by the human: theirs.
      toolImage("both.png", old),
      userImage("both.png", old),
      { ...toolImage("clip.mp4", old), images: [{ id: "v", path: "assets/clip.mp4", mimeType: "video/mp4" }] },
      // `stray.png` is named by no row at all — an upload never sent.
    ]);
  }

  const assets = async () => (await store.listChatAssets("c1")).map((a) => a.name).sort();

  it("expires only old images a tool produced, and records the expiry", async () => {
    await seed();

    const report = await service().sweep();

    expect(report.images.files).toBe(1);
    expect(report.images.bytes).toBe(PNG.length);
    expect(await assets()).toEqual(["both.png", "clip.mp4", "mine.png", "stray.png", "young.png"]);
    expect(await store.chatAssetExpiredAt("c1", "old.png")).toBe(NOW);
    expect(await store.chatAssetExpiredAt("c1", "young.png")).toBeNull();
    // The transcript is never rewritten — it may be the only copy left.
    expect(existsSync(store.chatTranscriptPath("c1"))).toBe(true);
    expect(logs.some((l) => l.includes("expired 1 tool-output image(s)"))).toBe(true);
  });

  it("does not re-read an unchanged transcript until something comes due", async () => {
    await seed();
    const svc = service();
    const read = vi.spyOn(store, "readMessageLines");

    await svc.sweep();
    expect(read).toHaveBeenCalledTimes(1);

    // An hour later nothing is due: the transcript is not read again.
    now += 60 * 60_000;
    await svc.sweep();
    expect(read).toHaveBeenCalledTimes(1);

    // Once `young.png` crosses the window it is.
    now = young + TOOL_IMAGE_RETENTION_MS + 1;
    await svc.sweep();
    expect(read).toHaveBeenCalledTimes(2);
    expect(await assets()).toEqual(["both.png", "clip.mp4", "mine.png", "stray.png"]);
  });

  it("leaves a chat with no images untouched and unread", async () => {
    await chat("prose");
    await transcript("prose", [{ kind: "assistant", ts: old, text: "no pictures here" }]);
    const read = vi.spyOn(store, "readMessageLines");

    expect((await service().sweep()).images.files).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("checkpoint rule", () => {
  it("hands the checkpoint sweep each chat's project checkout", async () => {
    const repo = await mkdtemp(join(tmpdir(), "cm-retention-repo-"));
    await store.saveProject({
      id: "p1",
      name: "P",
      repoPath: repo,
      worktreeRoot: "wt",
      subApps: [],
      createdAt: NOW,
    });
    await chat("c1");

    await service().sweep();

    expect(await sweptRepoFor!("c1")).toBe(repo);
    expect(await sweptRepoFor!("unknown-chat")).toBeNull();
    await rm(repo, { recursive: true, force: true });
  });
});

describe("aged chats (rule 4)", () => {
  /** Rule 4 only runs when a window is configured. */
  async function window(days: number): Promise<void> {
    await store.saveSettings({ theme: "dark", retention: { chatDeleteDays: days } });
  }

  it("is OFF by default — an install upgrading into the field loses nothing", async () => {
    await chat("ancient", { updatedAt: NOW - 400 * DAY });

    const report = await service().sweep();

    expect(report.agedChats.deleted).toEqual([]);
    expect(deleted).toEqual([]);
    expect(existsSync(store.chatTranscriptPath("ancient"))).toBe(false); // never had one
    expect(await store.getChat("ancient")).not.toBeNull();
  });

  it("deletes a chat idle past the window and keeps one inside it", async () => {
    await window(30);
    await chat("old", { updatedAt: NOW - 31 * DAY });
    await chat("recent", { updatedAt: NOW - 29 * DAY });

    const report = await service().sweep();

    expect(report.agedChats.deleted).toEqual(["old"]);
    expect(await store.getChat("recent")).not.toBeNull();
  });

  it("keeps an old chat whose PR has not settled", async () => {
    await window(30);
    await chat("open-pr", {
      updatedAt: NOW - 90 * DAY,
      prs: [{ number: 7, url: "u", branch: "b", state: "open" }],
    });
    // State we could not classify is treated the same way, deliberately.
    await chat("unknown-pr", {
      updatedAt: NOW - 90 * DAY,
      prs: [{ number: 8, url: "u", branch: "b" }],
    });
    await chat("merged-pr", {
      updatedAt: NOW - 90 * DAY,
      prs: [{ number: 9, url: "u", branch: "b", state: "merged" }],
    });

    const report = await service().sweep();

    expect(report.agedChats.deleted).toEqual(["merged-pr"]);
    expect(report.agedChats.skipped).toBe(2);
  });

  it("keeps an old chat that still has a worktree on disk", async () => {
    await window(30);
    await chat("has-tree", { updatedAt: NOW - 90 * DAY, worktrees: ["C:/wt/feat-x"] });

    expect((await service().sweep()).agedChats.deleted).toEqual([]);
  });

  it("keeps a busy chat, and the global chat however old", async () => {
    await window(30);
    await chat("busy-one", { updatedAt: NOW - 90 * DAY });
    await chat("global-one", { projectId: "__global__", updatedAt: NOW - 90 * DAY });
    busy.add("busy-one");

    expect((await service().sweep()).agedChats.deleted).toEqual([]);
  });

  it("caps a pass and takes the oldest first, so a big backlog drains over passes", async () => {
    await window(30);
    for (let i = 0; i < AGED_CHAT_DELETE_LIMIT + 5; i++) {
      await chat(`c${String(i).padStart(2, "0")}`, { updatedAt: NOW - (100 + i) * DAY });
    }

    const report = await service().sweep();

    expect(report.agedChats.deleted).toHaveLength(AGED_CHAT_DELETE_LIMIT);
    // `c29` is the oldest (NOW - 129d), so it goes in the first pass and `c00`
    // (the youngest of the candidates) survives it.
    expect(report.agedChats.deleted).toContain("c29");
    expect(await store.getChat("c00")).not.toBeNull();
  });

  it("does not delete a reviewer chat twice when both rules want it", async () => {
    await window(30);
    await pr("o/r#1", { state: "merged", mergedAt: new Date(NOW - 90 * DAY).toISOString() });
    await chat("reviewer", { updatedAt: NOW - 90 * DAY, reviewOf: "o/r#1" });

    const report = await service().sweep();

    expect(report.reviewerChats.deleted).toEqual(["reviewer"]);
    expect(report.agedChats.deleted).toEqual([]);
    expect(deleted).toEqual(["reviewer"]);
  });
});

describe("configured windows", () => {
  it("uses the reviewer window from settings rather than the default", async () => {
    await store.saveSettings({ theme: "dark", retention: { reviewerChatDays: 1 } });
    await pr("o/r#2", { state: "merged", mergedAt: new Date(NOW - 2 * DAY).toISOString() });
    await chat("rev", { updatedAt: NOW - 2 * DAY, reviewOf: "o/r#2" });

    // 2 days settled is inside the 14-day default and past a 1-day setting.
    expect(REVIEWER_CHAT_RETENTION_MS).toBeGreaterThan(2 * DAY);
    expect((await service().sweep()).reviewerChats.deleted).toEqual(["rev"]);
  });

  it("uses the image window from settings rather than the default", async () => {
    await store.saveSettings({ theme: "dark", retention: { toolImageDays: 1 } });
    await chat("imgs");
    await store.writeChatAsset("imgs", "shot.png", PNG);
    await transcript("imgs", [toolImage("shot.png", NOW - 2 * DAY)]);

    expect(TOOL_IMAGE_RETENTION_MS).toBeGreaterThan(2 * DAY);
    expect((await service().sweep()).images.files).toBe(1);
  });
});

describe("classifyAssets", () => {
  it("finds a tool image inside a serialized CallToolResult", () => {
    // A bridged MCP server's whole result JSON-encoded into one text block.
    const inner = JSON.stringify({ content: [{ type: "image", asset: "assets/deep.png" }] });
    const line = JSON.stringify({ kind: "tool_result", ts: 5, content: [{ type: "text", text: inner }] });

    expect([...classifyAssets([line]).toolOutput]).toEqual([["deep.png", 5]]);
  });

  it("ignores rows that are neither a tool result nor the human's", () => {
    const line = JSON.stringify({ kind: "assistant", ts: 5, text: "see ![](assets/prose.png)" });
    const { toolOutput, attached } = classifyAssets([line]);
    expect(toolOutput.size).toBe(0);
    expect(attached.size).toBe(0);
  });
});
