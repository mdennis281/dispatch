import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { Store } from "../store/index.js";
import {
  InspectService,
  installedRoots,
  resolveImagePath,
  rowLabel,
  rowText,
  type RawRow,
  FindFilterError,
} from "./inspect.js";
import { renderFind, renderRead, renderProject, renderProjectList } from "./inspect-render.js";
import { GLOBAL_PROJECT_ID } from "@dispatch/shared";
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
  chat: Partial<{ title: string; projectId: string; updatedAt: number; archived: boolean; status: string; prs: unknown[] }>,
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
      prs: chat.prs ?? [],
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
  store.close();
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

  it("filters to chats blocked on the human, and flags them in the listing", async () => {
    await seedChat("chat-stuck", { title: "needs a yes", status: "awaiting-input", updatedAt: T0 + 3 * DAY }, []);
    const blocked = await service().findChats({ blockedOnHuman: true });
    expect(blocked.chats.map((c) => [c.id, c.blockedOnHuman])).toEqual([["chat-stuck", true]]);
    expect(renderFind(blocked)).toContain("⏸ waiting on the human");
    const rest = await service().findChats({ blockedOnHuman: false });
    expect(rest.chats.map((c) => c.id)).not.toContain("chat-stuck");
    expect(rest.chats.every((c) => c.blockedOnHuman === undefined)).toBe(true);
  });

  it("refuses a status, row kind or time window nothing could match — and says what IS valid", async () => {
    await expect(service().findChats({ status: "finished" })).rejects.toThrow(FindFilterError);
    await expect(service().findChats({ status: "finished" })).rejects.toThrow(
      "Valid statuses: idle, queued, running, waiting, awaiting-input, done, failed, error.",
    );
    await expect(service().findChats({ query: "x", kinds: ["tool_call"] })).rejects.toThrow(/Unknown row kind\(s\): tool_call\. Valid kinds: user, assistant/);
    await expect(service().findChats({ since: T0 + DAY, before: T0 })).rejects.toThrow(/`before` is not after `since`/);
    // A valid status still filters.
    expect((await service().findChats({ status: "done" })).chats).toEqual([]);
  });

  it("reports each chat's PR state, and `unmerged` keeps only chats with one still open", async () => {
    const pr = (n: number) => ({ number: n, url: `https://x/${n}`, branch: `b${n}`, repo: "o/r" });
    await seedChat("chat-landed", { title: "landed", updatedAt: T0 + 3 * DAY, prs: [pr(1)] }, []);
    await seedChat("chat-open", { title: "in review", updatedAt: T0 + 4 * DAY, prs: [pr(1), pr(2)] }, []);
    const base = { firstSeenAt: 1, lastChangedAt: 1, repo: "o/r" };
    await store.upsertPrRecord("o/r#1", { ...base, number: 1, url: "https://x/1", state: "merged" } as never);
    await store.upsertPrRecord("o/r#2", {
      ...base, number: 2, url: "https://x/2", title: "Still going", state: "open",
      checks: [{ name: "ci", status: "completed", conclusion: "failure" }],
    } as never);

    const all = await service().findChats({});
    const open = all.chats.find((c) => c.id === "chat-open")!;
    expect(open.prStatus?.map((p) => [p.number, p.state, p.ci])).toEqual([[1, "merged", "none"], [2, "open", "failing"]]);
    expect(renderFind(all)).toContain("PR #1 merged, #2 open (CI failing)");

    const unmerged = await service().findChats({ unmerged: true });
    expect(unmerged.chats.map((c) => c.id)).toEqual(["chat-open"]);
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

  it("REPORTS a budget stop, and hands back a cursor past it", async () => {
    const result = await service().findChats({ query: "release workflow", scanBudgetBytes: 1 });
    expect(result.truncated).toBe(true);
    expect(result.unscanned).toBeGreaterThan(0);
    expect(result.nextCursor).toBeTruthy();
    const text = renderFind(result, "release workflow");
    expect(text).toContain("Not finished");
    expect(text).toContain(result.nextCursor);
  });

  it("covers at least one transcript per page, and otherwise stays inside the budget", async () => {
    // Without the first-transcript exception a chat bigger than the budget is
    // a page that covers nothing — and a cursor that never moves.
    const result = await service().findChats({ query: "release workflow", scanBudgetBytes: 1 });
    expect(result.scanned).toBe(1);
    expect(result.bytesScanned).toBeGreaterThan(1);
  });

  it("pages through the whole search with the cursor, each chat exactly once", async () => {
    const seen: string[] = [];
    let scanned = 0;
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await service().findChats({ query: "release workflow", scanBudgetBytes: 1, cursor });
      seen.push(...page.chats.map((c) => c.id));
      scanned += page.scanned;
      cursor = page.nextCursor;
      expect(++pages).toBeLessThanOrEqual(3);
    } while (cursor);
    expect(seen).toEqual(["chat-new", "chat-old"]);
    expect(scanned).toBe(3);
  });

  it("ends a page at `limit` and resumes after it, rather than dropping the rest", async () => {
    const first = await service().findChats({ query: "release", limit: 1 });
    expect(first.chats.map((c) => c.id)).toEqual(["chat-new"]);
    expect(first.truncated).toBe(true);
    const second = await service().findChats({ query: "release", limit: 1, cursor: first.nextCursor });
    expect(second.chats.map((c) => c.id)).toEqual(["chat-old"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("lists a title match on page one even past the budget, and never again", async () => {
    // "older" is only in chat-old's TITLE; its transcript is the last one a
    // budget of 1 byte reaches.
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service().findChats({ query: "older", scanBudgetBytes: 1, cursor });
      seen.push(...page.chats.map((c) => c.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["chat-old"]);
  });

  describe("titles and content together", () => {
    beforeEach(async () => {
      await seedProject("p3", "Gamma");
      const at = (n: number) => T0 + (10 - n) * DAY; // g-a newest
      await seedChat("g-a", { projectId: "p3", updatedAt: at(0) }, [{ id: "a", ts: T0, kind: "user", text: "zebra crossing" }]);
      await seedChat("g-b", { projectId: "p3", title: "zebra notes", updatedAt: at(1) }, [{ id: "b", ts: T0, kind: "user", text: "nothing here" }]);
      await seedChat("g-c", { projectId: "p3", updatedAt: at(2) }, [{ id: "c", ts: T0, kind: "user", text: "another zebra" }]);
      await seedChat("g-d", { projectId: "p3", title: "zebra again", updatedAt: at(3) }, [{ id: "d", ts: T0, kind: "user", text: "zebra in the body too" }]);
    });

    async function everyPage(q: Parameters<InspectService["findChats"]>[0]): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 10; pages++) {
        const page = await service().findChats({ ...q, cursor });
        seen.push(...page.chats.map((c) => c.id));
        cursor = page.nextCursor;
        if (!cursor) return seen;
      }
      throw new Error("cursor never ran out");
    }

    it("never loses a title-only match between two content matches when `limit` bites", async () => {
      // The review's A/B/C: B matched by title alone used to be "covered" but
      // never listed once A filled the page, and the cursor moved past it.
      expect(await everyPage({ query: "zebra", project: "Gamma", limit: 1 })).toEqual(["g-a", "g-b", "g-c", "g-d"]);
    });

    it("lists a chat once even when page one took it by title and a later page reaches its transcript", async () => {
      const seen = await everyPage({ query: "zebra", project: "Gamma", scanBudgetBytes: 1 });
      expect([...seen].sort()).toEqual(["g-a", "g-b", "g-c", "g-d"]);
    });
  });

  describe("similarity", () => {
    const TITLE = "Anoxia: Continue without reload — modular seed loading";
    beforeEach(async () => {
      await seedProject("p4", "anoxia");
      // The live store's shape: the chat itself is OLDEST, and three newer
      // chats merely quote its title — which under newest-first buried the
      // one chat the search was for at the bottom of the list.
      await seedChat("anoxia-seed", { projectId: "p4", title: TITLE, updatedAt: T0 + 5 * DAY }, [
        { id: "s1", ts: T0, kind: "user", text: "split the seed into modules" },
      ]);
      await seedChat("anoxia-load", { projectId: "p4", title: "Anoxia: where the load time goes", updatedAt: T0 + 6 * DAY }, [
        { id: "l1", ts: T0, kind: "user", text: `see the chat "${TITLE}" for that direction` },
      ]);
      await seedChat("anoxia-speed", { projectId: "p4", title: "Anoxia: more initial-load speedups", updatedAt: T0 + 7 * DAY }, [
        { id: "x1", ts: T0, kind: "user", text: "measure the cold reload, then continue without it if it is slow" },
      ]);
    });

    it("finds a title across an em dash the old substring rule could not", async () => {
      const result = await service().findChats({ query: "reload modular seed", project: "anoxia" });
      expect(result.chats[0]!.id).toBe("anoxia-seed");
      expect(result.chats[0]!.score).toBeGreaterThanOrEqual(0.9);

      const exact = await service().findChats({ query: "reload modular seed", project: "anoxia", match: "exact" });
      expect(exact.chats).toEqual([]);
    });

    it("finds a reordered, misspelled title", async () => {
      const result = await service().findChats({ query: "seed modulr continue", project: "anoxia" });
      expect(result.chats.map((c) => c.id)).toEqual(["anoxia-seed"]);
      expect(result.chats[0]!.hits?.[0]!.kind).toBe("title");
    });

    it("ranks the chat a title names above newer chats that only quote it", async () => {
      const result = await service().findChats({ query: "continue without reload", project: "anoxia" });
      expect(result.chats[0]!.id).toBe("anoxia-seed");
      // Both quoters still come back — exact and ranked below the real one.
      expect(result.chats.map((c) => c.id)).toEqual(expect.arrayContaining(["anoxia-load", "anoxia-speed"]));
      const scores = result.chats.map((c) => c.score!);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
      expect(renderFind(result, "continue without reload")).toContain("best match first");
    });

    it("scores every hit, and drops what falls under minScore", async () => {
      const all = await service().findChats({ query: "continue without reload", project: "anoxia" });
      const scattered = all.chats.find((c) => c.id === "anoxia-speed")!;
      expect(scattered.hits?.[0]!.score).toBeLessThan(1);

      const strict = await service().findChats({ query: "continue without reload", project: "anoxia", minScore: 0.99 });
      expect(strict.chats.map((c) => c.id)).not.toContain("anoxia-speed");
    });

    it("keeps `exact` exactly as it was: substring only, newest first, no scores", async () => {
      const result = await service().findChats({ query: "continue without reload", project: "anoxia", match: "exact" });
      expect(result.chats.map((c) => c.id)).toEqual(["anoxia-load", "anoxia-seed"]);
      expect(result.chats.every((c) => c.score === undefined)).toBe(true);
    });

    it("centres a snippet on a query word when the phrase never appears whole", async () => {
      await seedChat("long-row", { projectId: "p4", title: "x", updatedAt: T0 + 8 * DAY }, [
        { id: "z1", ts: T0, kind: "assistant", text: `${"filler ".repeat(80)}the zebra and then the giraffe` },
      ]);
      const result = await service().findChats({ query: "giraffe zebra", project: "anoxia" });
      expect(result.chats[0]!.hits?.[0]!.snippet).toContain("zebra");
    });

    it("refuses a cursor minted under a different match mode", async () => {
      const first = await service().findChats({ query: "anoxia", project: "anoxia", limit: 1 });
      await expect(
        service().findChats({ query: "anoxia", project: "anoxia", limit: 1, match: "exact", cursor: first.nextCursor }),
      ).rejects.toThrow(/different search/);
    });
  });

  it("refuses a cursor from a different search, or one it never issued", async () => {
    const first = await service().findChats({ query: "release", limit: 1 });
    await expect(service().findChats({ query: "workflow", cursor: first.nextCursor })).rejects.toThrow(/different search/);
    await expect(service().findChats({ query: "release", project: "hive", cursor: first.nextCursor })).rejects.toThrow(/different search/);
    await expect(service().findChats({ query: "release", cursor: "not-a-cursor" })).rejects.toThrow(/not one chat_find handed out/);
  });

  it("lists chats by metadata alone when no query is given", async () => {
    const result = await service().findChats({ limit: 2 });
    expect(result.chats.map((c) => c.id)).toEqual(["chat-other", "chat-new"]);
    expect(result.scanned).toBe(0); // no transcript opened at all
    // …and pages the listing the same way.
    const rest = await service().findChats({ limit: 2, cursor: result.nextCursor });
    expect(rest.chats.map((c) => c.id)).toEqual(["chat-old"]);
    expect(rest.nextCursor).toBeUndefined();
  });

  it("orders equal activity times by id, so a boundary between them is exact", async () => {
    await seedChat("tie-b", { title: "tie b", updatedAt: T0 + 3 * DAY }, [{ id: "t1", ts: T0, kind: "user", text: "tie" }]);
    await seedChat("tie-a", { title: "tie a", updatedAt: T0 + 3 * DAY }, [{ id: "t2", ts: T0, kind: "user", text: "tie" }]);
    const first = await service().findChats({ limit: 1 });
    expect(first.chats.map((c) => c.id)).toEqual(["tie-a"]);
    const second = await service().findChats({ limit: 1, cursor: first.nextCursor });
    expect(second.chats.map((c) => c.id)).toEqual(["tie-b"]);
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

  it("neither matches nor serves a session start's prompt text in the clipped view", async () => {
    // The sent context IS the system prompt: in grep every instruction word made
    // the init row a hit, and the clipped view is what the integration API serves.
    await seedChat("c2", { title: "with init", updatedAt: T0 + DAY }, [
      {
        id: "s",
        ts: T0,
        kind: "system",
        subtype: "init",
        data: {
          model: "m",
          sentContext: {
            sections: [{ id: "workflow", label: "Workflow profile", text: "zebracorn rule", chars: 14 }],
            mcpServers: [],
            skills: [],
          },
        },
      },
      { id: "u", ts: T0 + 1, kind: "user", text: "hello" },
    ]);
    const grep = await service().readChat({ chatId: "c2", view: "grep", query: "zebracorn" });
    expect(grep.rows).toHaveLength(0);
    const rows = await service().readChat({ chatId: "c2", view: "messages" });
    expect(JSON.stringify(rows.rows)).not.toContain("zebracorn");
    expect(JSON.stringify(rows.rows)).toContain("Workflow profile");
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

  it("returns at most `limit` rows in grep view", async () => {
    const result = await service().readChat({
      chatId: "c1",
      view: "grep",
      query: "ask",
      limit: 1,
    });
    expect(result.rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("still counts kinds and images beyond the returned window", async () => {
    const result = await service().readChat({ chatId: "c1", view: "grep", query: "ask", limit: 1 });
    // The window is one row, but the histogram/inventory describe the whole file.
    expect(result.totalRows).toBe(6);
    expect(result.images).toHaveLength(1);
  });

  it("reads a chat that has no transcript yet as empty, not as an error", async () => {
    await seedChat("silent", { title: "never spoke" }, []);
    const result = await service().readChat({ chatId: "silent" });
    expect(result.totalRows).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.images).toEqual([]);
    expect(renderRead(result)).toContain("never spoke");
  });

  it("errors clearly on an unknown chat id", async () => {
    await expect(service().readChat({ chatId: "nope" })).rejects.toThrow(/No chat with id/);
  });
});

describe("resolveImagePath", () => {
  const DIR = process.platform === "win32" ? "C:/chats/c1/assets" : "/chats/c1/assets";

  it("resolves the portable assets/<name> form against the chat's asset dir", () => {
    expect(resolveImagePath("assets/shot.png", DIR).replace(/\\/g, "/")).toBe(`${DIR}/shot.png`);
  });

  it("refuses to let a stored path escape the asset dir", () => {
    // A persisted path is not trustworthy input — and this function's output is
    // a path an agent is then invited to read.
    const out = resolveImagePath("assets/../../secrets.png", DIR).replace(/\\/g, "/");
    expect(out).toBe(`${DIR}/secrets.png`);
    expect(out).not.toContain("..");
  });

  it("leaves data: and remote URLs untouched", () => {
    expect(resolveImagePath("data:image/png;base64,AAAA", DIR)).toBe("data:image/png;base64,AAAA");
    expect(resolveImagePath("https://example.com/a.png", DIR)).toBe("https://example.com/a.png");
  });

  it("leaves an absolute or unrecognised path alone", () => {
    const abs = process.platform === "win32" ? "C:/tmp/a.png" : "/tmp/a.png";
    expect(resolveImagePath(abs, DIR)).toBe(abs);
    expect(resolveImagePath("some/harness/relative.png", DIR)).toBe("some/harness/relative.png");
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

  it("reads a real config shape: mcpServers is a record keyed by name, not a list", async () => {
    // The loaded ProjectConfig's `mcpServers` is `z.record(...)`; treating it
    // like the `agents`/`modes`/`skills` arrays threw `.map is not a function`
    // for EVERY project with a config, which is every project.
    const svc = new InspectService({
      store,
      projectConfig: {
        get: () => ({
          sourceDir: "/cfg",
          errors: [],
          config: {
            agents: [{ id: "a1", name: "Reviewer" }],
            modes: [],
            skills: [{ name: "deploy" }],
            mcpServers: { linear: { transport: "http" }, sentry: { transport: "stdio" } },
          },
        }),
      },
    });
    const result = await svc.projectInfo({ project: "dispatch" });
    expect(result.mcpServers).toEqual(["linear", "sentry"]);
    expect(result.agents).toEqual(["Reviewer"]);
    expect(result.skills).toEqual(["deploy"]);
  });

  it("errors when there is nothing to describe", async () => {
    await expect(service().projectInfo({})).rejects.toThrow(/No project to describe/);
    await expect(service().projectInfo({ project: "ghost" })).rejects.toThrow(/No project matching/);
  });
});

describe("projectList", () => {
  beforeEach(async () => {
    await seedProject("p1", "Dispatch");
    await seedProject("p2", "The Salesman");
    await seedChat("c1", { projectId: "p1", updatedAt: T0 + DAY }, []);
    await seedChat("c2", { projectId: "p1", updatedAt: T0 + 2 * DAY }, []);
    // Archived chats are not "open chats" and must not inflate the count, nor
    // stand in as the project's last activity after everyone moved on.
    await seedChat("c3", { projectId: "p1", updatedAt: T0 + 9 * DAY, archived: true }, []);
    // A chat filed against the pseudo-project — the global chat's own. It must
    // not conjure a row for a project that is not in the list.
    await seedChat("c4", { projectId: GLOBAL_PROJECT_ID, updatedAt: T0 + DAY }, []);
  });

  it("never lists the reserved pseudo-project", async () => {
    // The whole approach's predictable failure is a leak into one listing, and
    // this is the listing a cross-project chat reads FIRST.
    const ids = (await service().projectList()).map((p) => p.id);
    expect(ids).toEqual(["p1", "p2"]);
    expect(ids).not.toContain(GLOBAL_PROJECT_ID);
  });

  it("counts only open chats, and dates each project by its newest", async () => {
    const byId = new Map((await service().projectList()).map((p) => [p.id, p]));
    expect(byId.get("p1")!.chats).toBe(2);
    expect(byId.get("p1")!.lastActiveAt).toBe(T0 + 2 * DAY);
    // A project with no chats reports zero and volunteers no date at all,
    // rather than an epoch-0 one that would render as 1970.
    expect(byId.get("p2")!.chats).toBe(0);
    expect(byId.get("p2")!.lastActiveAt).toBeUndefined();
  });

  it("reports each project's workflow and the config it carries", async () => {
    const svc = new InspectService({
      store,
      projectConfig: {
        get: () => ({
          sourceDir: "/cfg",
          errors: [],
          config: {
            agents: [{ id: "a1", name: "Reviewer" }],
            modes: [],
            skills: [{ name: "deploy" }],
            mcpServers: { linear: { transport: "http" } },
          },
        }),
      },
    });
    const entry = (await svc.projectList()).find((p) => p.id === "p1")!;
    // Sub-apps and MCP servers by NAME — "which project has the Linear MCP" is
    // the question this tier exists to answer in one call, and a count can't.
    expect(entry.mcpServers).toEqual(["linear"]);
    expect(entry.agents).toBe(1);
    expect(entry.skills).toBe(1);
    expect(entry.workflow).toBe("none");
    expect(entry.defaultBranch).toBe("main");
    expect(renderProjectList(await svc.projectList())).toContain("MCP: linear");
  });

  it("says so rather than rendering an empty document", async () => {
    expect(renderProjectList([])).toBe("No projects on this install yet.");
  });
});

describe("instance: stable", () => {
  it("refuses rather than silently reading the wrong store when nothing is wired", async () => {
    const svc = new InspectService({ store });
    await expect(svc.findChats({ instance: "stable" })).rejects.toThrow(/unavailable/);
  });

  it("answers from self when this process ALREADY is the installed instance", async () => {
    // installedRoots() returns null in exactly that case; failing there would
    // make `instance: "stable"` unusable on the stable instance itself.
    await seedProject("p1", "Dispatch");
    await seedChat("c1", { title: "local" }, [
      { id: "r1", ts: T0, kind: "user", text: "findable" },
    ]);
    const svc = new InspectService({
      store,
      stableRoots: () => null,
      makeStore: (d, c) => new Store(d, c),
    });
    const result = await svc.findChats({ instance: "stable", query: "findable" });
    expect(result.chats.map((c) => c.id)).toEqual(["c1"]);
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
    otherStore.close();
    await rm(other, { recursive: true, force: true });
  });
});

describe("installedRoots", () => {
  // Absolute-path fixtures must be rooted PER PLATFORM: POSIX doesn't treat a
  // drive letter as absolute, so `resolve("D:/dispatch")` on the Linux CI runner
  // silently prepends the cwd. `installedRoots` resolves DISPATCH_HOME, so a
  // literal "D:/…" here fails the gate for a reason that has nothing to do with
  // the code under test.
  const LOCAL = process.platform === "win32" ? "C:/Users/x/AppData/Local" : "/home/x/.local/share";
  const HOME = process.platform === "win32" ? "D:/dispatch" : "/opt/dispatch";
  const slash = (p: string | undefined) => p?.replace(/\\/g, "/");

  it("derives the documented layout from LOCALAPPDATA", () => {
    const roots = installedRoots({ LOCALAPPDATA: LOCAL } as NodeJS.ProcessEnv);
    expect(slash(roots?.dataDir)).toBe(`${LOCAL}/dispatch/data`);
    expect(slash(roots?.configDir)).toBe(`${LOCAL}/dispatch/config`);
  });

  it("returns null when this process ALREADY is the installed instance", () => {
    const roots = installedRoots({
      LOCALAPPDATA: LOCAL,
      DISPATCH_DATA_DIR: join(LOCAL, "dispatch", "data"),
    } as NodeJS.ProcessEnv);
    expect(roots).toBeNull();
  });

  it("honours an explicit DISPATCH_HOME override", () => {
    const roots = installedRoots({ DISPATCH_HOME: HOME } as NodeJS.ProcessEnv);
    expect(slash(roots?.dataDir)).toBe(`${HOME}/data`);
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
