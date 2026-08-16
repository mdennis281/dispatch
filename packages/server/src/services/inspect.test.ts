import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { Store } from "../store/index.js";
import {
  InspectService,
  installedRoots,
  rowLabel,
  rowText,
  type RawRow,
} from "./inspect.js";
import { renderFind, renderRead, renderProject } from "./inspect-render.js";
import { parseTimeBound } from "./mcp/manager-mcp.js";

/**
 * These tests write REAL files. The whole point of the service is streaming a
 * JSONL transcript off disk under a byte budget, and a mocked fs would test the
 * mock rather than the thing that was slow.
 */
let root: string;
let store: Store;

const T0 = Date.parse("2026-08-01T10:00:00Z");
const DAY = 86_400_000;

/** Write a chat record + its transcript rows. */
async function seedChat(
  id: string,
  chat: Partial<{ title: string; projectId: string; updatedAt: number; archived: boolean; status: string }>,
  rows: RawRow[],
): Promise<void> {
  const dir = join(root, "chats", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "chat.json"),
    JSON.stringify({
      id,
      projectId: chat.projectId ?? "p1",
      title: chat.title ?? id,
      modeId: "default",
      effort: "medium",
      worktrees: [],
      prs: [],
      archived: chat.archived,
      status: chat.status,
      createdAt: T0,
      updatedAt: chat.updatedAt ?? T0,
    }),
  );
  if (rows.length) {
    const file = join(dir, "messages.jsonl");
    await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    // `Store.getChat` reports updatedAt as max(record, TRANSCRIPT MTIME) — the
    // transcript is the truthful activity clock. A fixture that only sets the
    // JSON field would be dated "now" by its own mtime and every time filter
    // here would silently test nothing.
    const at = new Date(chat.updatedAt ?? T0);
    await utimes(file, at, at);
  }
}

async function seedProject(id: string, name: string): Promise<void> {
  await mkdir(join(root, "projects"), { recursive: true });
  await writeFile(
    join(root, "projects", `${id}.json`),
    JSON.stringify({
      id,
      name,
      repoPath: join(root, "repo"),
      worktreeRoot: join(root, "wt"),
      subApps: [],
      createdAt: T0,
    }),
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inspect-test-"));
  store = new Store(root);
  await store.init();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function service(): InspectService {
  return new InspectService({ store });
}

describe("findChats", () => {
  beforeEach(async () => {
    await seedProject("p1", "Dispatch");
    await seedProject("p2", "Hivebreak");
    await seedChat("chat-old", { title: "older work", updatedAt: T0 }, [
      { id: "r1", ts: T0, kind: "user", text: "please fix the flaky release workflow" },
      { id: "r2", ts: T0 + 1, kind: "assistant", text: "looking at promote.yml now" },
    ]);
    await seedChat("chat-new", { title: "newer work", updatedAt: T0 + DAY }, [
      { id: "r3", ts: T0 + DAY, kind: "user", text: "the release workflow is green again" },
      {
        id: "r4",
        ts: T0 + DAY + 1,
        kind: "tool_use",
        name: "Bash",
        input: { command: "gh run list --workflow=promote.yml" },
      },
    ]);
    await seedChat("chat-other", { title: "unrelated", projectId: "p2", updatedAt: T0 + 2 * DAY }, [
      { id: "r5", ts: T0, kind: "user", text: "nothing to do with the above" },
    ]);
  });

  it("finds chats by transcript content, newest first, with snippets", async () => {
    const result = await service().findChats({ query: "release workflow" });
    expect(result.chats.map((c) => c.id)).toEqual(["chat-new", "chat-old"]);
    expect(result.chats[0]!.hits?.[0]!.snippet).toContain("release workflow is green");
    expect(result.chats[0]!.hits?.[0]!.id).toBe("r3");
    expect(result.scanned).toBe(3);
  });

  it("searches only user+assistant rows by default, tool rows on request", async () => {
    const prose = await service().findChats({ query: "promote.yml" });
    expect(prose.chats.map((c) => c.id)).toEqual(["chat-old"]); // assistant text only

    const tools = await service().findChats({
      query: "gh run list",
      kinds: ["user", "assistant", "tool_use"],
    });
    expect(tools.chats.map((c) => c.id)).toEqual(["chat-new"]);
    expect(tools.chats[0]!.hits?.[0]!.label).toBe("Bash");
  });

  it("matches titles even when the transcript doesn't contain the term", async () => {
    const result = await service().findChats({ query: "unrelated" });
    expect(result.chats.map((c) => c.id)).toEqual(["chat-other"]);
    expect(result.chats[0]!.hits?.[0]!.kind).toBe("title");
  });

  it("filters by project name substring, case-insensitively", async () => {
    const result = await service().findChats({ project: "hive" });
    expect(result.chats.map((c) => c.id)).toEqual(["chat-other"]);
  });

  it("returns nothing (not everything) for a project that doesn't exist", async () => {
    const result = await service().findChats({ project: "nope", query: "release" });
    expect(result.chats).toEqual([]);
    expect(result.candidates).toBe(0);
  });

  it("applies since/before bounds against last activity", async () => {
    const since = await service().findChats({ since: T0 + DAY });
    expect(since.chats.map((c) => c.id)).toEqual(["chat-other", "chat-new"]);

    const before = await service().findChats({ before: T0 + DAY });
    expect(before.chats.map((c) => c.id)).toEqual(["chat-old"]);
  });

  it("excludes archived chats unless asked", async () => {
    await seedChat("chat-archived", { title: "archived one", archived: true }, [
      { id: "r9", ts: T0, kind: "user", text: "release workflow archived note" },
    ]);
    const without = await service().findChats({ query: "release workflow" });
    expect(without.chats.map((c) => c.id)).not.toContain("chat-archived");

    const with_ = await service().findChats({ query: "release workflow", archived: true });
    expect(with_.chats.map((c) => c.id)).toContain("chat-archived");
  });

  it("REPORTS a budget stop rather than silently returning a short list", async () => {
    const result = await service().findChats({ query: "release workflow", scanBudgetBytes: 1 });
    expect(result.truncated).toBe(true);
    expect(result.unscanned).toBeGreaterThan(0);
    expect(renderFind(result, "release workflow")).toContain("Scan budget reached");
  });

  it("lists chats by metadata alone when no query is given", async () => {
    const result = await service().findChats({ limit: 2 });
    expect(result.chats.map((c) => c.id)).toEqual(["chat-other", "chat-new"]);
    expect(result.scanned).toBe(0); // no transcript opened at all
  });
});

describe("readChat", () => {
  beforeEach(async () => {
    await seedProject("p1", "Dispatch");
    await seedChat("c1", { title: "the chat", updatedAt: T0 + DAY }, [
      { id: "a", ts: T0, kind: "user", text: "first ask" },
      { id: "b", ts: T0 + 1, kind: "assistant", text: "working on it" },
      {
        id: "c",
        ts: T0 + 2,
        kind: "tool_use",
        name: "Bash",
        input: { command: "pnpm test" },
      },
      {
        id: "d",
        ts: T0 + 3,
        kind: "tool_result",
        name: "Bash",
        ok: false,
        isError: true,
        content: "2 tests failed",
      },
      {
        id: "e",
        ts: T0 + 4,
        kind: "user",
        text: "second ask",
        images: [{ id: "i1", path: "assets/shot.png", mimeType: "image/png" }],
      },
      { id: "f", ts: T0 + 5, kind: "notice", level: "warn", text: "session restarted" },
    ]);
  });

  it("digests a chat into intent, problems, images and latest activity", async () => {
    const result = await service().readChat({ chatId: "c1" });
    expect(result.totalRows).toBe(6);
    expect(result.kindCounts).toMatchObject({ user: 2, assistant: 1, tool_use: 1 });
    expect(result.userMessages?.map((r) => r.text)).toEqual(["first ask", "second ask"]);
    // Both the failed tool result and the notice count as problems.
    expect(result.problems?.map((r) => r.id)).toEqual(["d", "f"]);
  });

  it("resolves image refs to absolute paths so they can be read directly", async () => {
    const result = await service().readChat({ chatId: "c1" });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.path).toBe(join(root, "chats", "c1", "assets", "shot.png"));
    expect(result.images[0]!.rowId).toBe("e");
    expect(renderRead(result)).toContain("shot.png");
  });

  it("greps inside one chat", async () => {
    const result = await service().readChat({ chatId: "c1", view: "grep", query: "ask" });
    expect(result.rows.map((r) => r.id)).toEqual(["a", "e"]);
  });

  it("filters by row kind", async () => {
    const result = await service().readChat({
      chatId: "c1",
      view: "messages",
      kinds: ["tool_result"],
    });
    expect(result.rows.map((r) => r.id)).toEqual(["d"]);
  });

  it("pages with exclusive beforeId / afterId cursors", async () => {
    const after = await service().readChat({ chatId: "c1", view: "messages", afterId: "d" });
    expect(after.rows.map((r) => r.id)).toEqual(["e", "f"]);

    const before = await service().readChat({ chatId: "c1", view: "messages", beforeId: "c" });
    expect(before.rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("keeps the NEWEST rows when the limit bites", async () => {
    const result = await service().readChat({ chatId: "c1", view: "messages", limit: 2 });
    expect(result.rows.map((r) => r.id)).toEqual(["e", "f"]);
    expect(result.truncated).toBe(true);
  });

  it("clips bulky payloads unless full is set", async () => {
    const big = "x".repeat(9_000);
    await seedChat("c2", { title: "big" }, [{ id: "z", ts: T0, kind: "assistant", text: big }]);
    const clipped = await service().readChat({ chatId: "c2", view: "messages" });
    expect((clipped.rows[0]!.text as string).length).toBeLessThan(big.length);
    const full = await service().readChat({ chatId: "c2", view: "messages", full: true });
    expect(full.rows[0]!.text).toBe(big);
  });

  it("tolerates rows written by older schema versions", async () => {
    await seedChat("c3", { title: "legacy" }, [
      { id: "old", ts: T0, kind: "assistant", text: "hi", someRetiredField: 1 } as RawRow,
      { kind: "mystery_kind", text: "from the future" } as RawRow,
    ]);
    const result = await service().readChat({ chatId: "c3", view: "messages" });
    expect(result.totalRows).toBe(2);
    expect(result.kindCounts.mystery_kind).toBe(1);
  });

  it("errors clearly on an unknown chat id", async () => {
    await expect(service().readChat({ chatId: "nope" })).rejects.toThrow(/No chat with id/);
  });
});

describe("projectInfo", () => {
  beforeEach(async () => {
    await seedProject("p1", "Dispatch");
    await seedChat("c1", { title: "recent", updatedAt: T0 + DAY }, []);
  });

  it("describes a project by name substring and lists its recent chats", async () => {
    const result = await service().projectInfo({ project: "dispatch" });
    expect(result.project.id).toBe("p1");
    expect(result.recentChats.map((c) => c.id)).toEqual(["c1"]);
    expect(renderProject(result)).toContain("# Dispatch");
  });

  it("falls back to the caller's own project when none is named", async () => {
    const result = await service().projectInfo({}, "p1");
    expect(result.project.id).toBe("p1");
  });

  it("errors when there is nothing to describe", async () => {
    await expect(service().projectInfo({})).rejects.toThrow(/No project to describe/);
    await expect(service().projectInfo({ project: "ghost" })).rejects.toThrow(/No project matching/);
  });
});

describe("instance: stable", () => {
  it("refuses rather than silently reading the wrong store when roots are unknown", async () => {
    const svc = new InspectService({ store, stableRoots: () => null });
    await expect(svc.findChats({ instance: "stable" })).rejects.toThrow(/unavailable/);
  });

  it("opens a second store over the installed roots", async () => {
    const other = await mkdtemp(join(tmpdir(), "inspect-stable-"));
    const otherStore = new Store(other);
    await otherStore.init();
    const svc = new InspectService({
      store,
      stableRoots: () => ({ dataDir: other, configDir: other }),
      makeStore: (d, c) => new Store(d, c),
    });
    const before = root;
    root = other;
    await seedProject("px", "Production");
    await seedChat("prod-chat", { title: "prod", projectId: "px" }, [
      { id: "p1", ts: T0, kind: "user", text: "production only" },
    ]);
    root = before;

    const result = await svc.findChats({ instance: "stable", query: "production only" });
    expect(result.chats.map((c) => c.id)).toEqual(["prod-chat"]);
    // …and the caller's own store is untouched by that.
    expect((await svc.findChats({ query: "production only" })).chats).toEqual([]);
    await rm(other, { recursive: true, force: true });
  });
});

describe("installedRoots", () => {
  it("derives the documented layout from LOCALAPPDATA", () => {
    const roots = installedRoots({ LOCALAPPDATA: "C:/Users/x/AppData/Local" } as NodeJS.ProcessEnv);
    expect(roots?.dataDir.replace(/\\/g, "/")).toBe("C:/Users/x/AppData/Local/claude-manager/data");
    expect(roots?.configDir.replace(/\\/g, "/")).toBe(
      "C:/Users/x/AppData/Local/claude-manager/config",
    );
  });

  it("returns null when this process ALREADY is the installed instance", () => {
    const local = "C:/Users/x/AppData/Local";
    const roots = installedRoots({
      LOCALAPPDATA: local,
      DISPATCH_DATA_DIR: join(local, "claude-manager", "data"),
    } as NodeJS.ProcessEnv);
    expect(roots).toBeNull();
  });

  it("honours an explicit DISPATCH_HOME override", () => {
    const roots = installedRoots({ DISPATCH_HOME: "D:/dispatch" } as NodeJS.ProcessEnv);
    expect(roots?.dataDir.replace(/\\/g, "/")).toBe("D:/dispatch/data");
  });
});

describe("row helpers", () => {
  it("extracts searchable text from every row kind", () => {
    expect(rowText({ kind: "user", text: "hi" })).toContain("hi");
    expect(rowText({ kind: "tool_use", name: "Bash", input: { command: "ls" } })).toContain("ls");
    expect(rowText({ kind: "tool_result", name: "Bash", content: "out" })).toContain("out");
    expect(rowText({ kind: "notice", level: "warn", text: "careful" })).toBe("careful");
  });

  it("labels rows by their most identifying field", () => {
    expect(rowLabel({ kind: "tool_use", name: "Bash" })).toBe("Bash");
    expect(rowLabel({ kind: "assistant", subagentType: "Explore" })).toBe("subagent:Explore");
    expect(rowLabel({ kind: "user" })).toBeUndefined();
  });
});

describe("parseTimeBound", () => {
  const now = Date.parse("2026-08-16T12:00:00Z");

  it("parses relative ages", () => {
    expect(parseTimeBound("30m", now)).toBe(now - 30 * 60_000);
    expect(parseTimeBound("6h", now)).toBe(now - 6 * 3_600_000);
    expect(parseTimeBound("7d", now)).toBe(now - 7 * 86_400_000);
    expect(parseTimeBound("2w", now)).toBe(now - 14 * 86_400_000);
  });

  it("parses absolute dates", () => {
    expect(parseTimeBound("2026-08-01", now)).toBe(Date.parse("2026-08-01"));
  });

  it("ignores junk rather than filtering everything out", () => {
    expect(parseTimeBound("soonish", now)).toBeUndefined();
    expect(parseTimeBound(undefined, now)).toBeUndefined();
  });
});
