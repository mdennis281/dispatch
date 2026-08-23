import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, ChatMessage } from "@dispatch/shared";
import { Store } from "../store/index.js";
import { MetricsService } from "./metrics.js";
import { MetricsBackfill, BACKFILL_META_KEY, BACKFILL_VERSION } from "./metrics-backfill.js";

let dir: string;
let store: Store;
let metrics: MetricsService;
let backfill: MetricsBackfill;

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-backfill-"));
  store = new Store(dir);
  metrics = new MetricsService({ db: store.stateDb, now: () => NOW, flushMs: 0 });
  backfill = new MetricsBackfill({ store, metrics, now: () => NOW });
});
afterEach(async () => {
  metrics.dispose();
  store.close();
  await rm(dir, { recursive: true, force: true });
});

async function makeChat(id: string, over: Partial<Chat> = {}): Promise<Chat> {
  return store.saveChat({
    id,
    projectId: "p1",
    title: id,
    modeId: "default",
    effort: "medium",
    agentId: "reviewer",
    model: "claude-opus-5",
    harness: "claude",
    worktrees: [],
    prs: [],
    createdAt: 1,
    ...over,
  } as Chat);
}

/** Append a `tool_use` row exactly as the broker would have written it. */
async function toolRow(
  chatId: string,
  toolUseId: string,
  name: string,
  over: Partial<Extract<ChatMessage, { kind: "tool_use" }>> = {},
): Promise<void> {
  await store.appendMessage({
    id: `m-${chatId}-${toolUseId}`,
    chatId,
    ts: NOW - 1000,
    turn: 0,
    kind: "tool_use",
    toolUseId,
    name,
    input: {},
    ...over,
  } as ChatMessage);
}

/** Append a RAW line to a chat's transcript, bypassing the store's validation. */
async function appendRaw(chatId: string, line: string): Promise<void> {
  await appendFile(store.chatTranscriptPath(chatId), `${line}\n`, "utf8");
}

describe("MetricsBackfill", () => {
  it("imports every tool_use row and stamps it as reconstructed", async () => {
    await makeChat("c1");
    await toolRow("c1", "t1", "Read");
    await toolRow("c1", "t2", "Bash");

    const res = await backfill.run();
    expect(res).toMatchObject({ ran: true, chats: 1, rows: 2, scanned: 2 });
    const rows = metrics.recent();
    expect(rows).toHaveLength(2);
    // `backfill`, not `live` — which is what lets a chart tell "nobody used
    // this" apart from "this predates the ledger".
    expect(rows.every((r) => r.source === "backfill")).toBe(true);
  });

  it("classifies imported rows exactly as live recording would", async () => {
    await makeChat("c1");
    await toolRow("c1", "t1", "Skill", { input: { skill: "code-review" } });
    await toolRow("c1", "t2", "mcp__dispatch-github__create_pr");
    await toolRow("c1", "t3", "Task", { input: { subagent_type: "Explore" } });
    await backfill.run();

    const byCategory = Object.fromEntries(
      metrics.recent().map((r) => [r.category, r.identifier]),
    );
    expect(byCategory).toEqual({
      skill: "code-review",
      manager: "create_pr",
      subagent: "Explore",
    });
  });

  it("attributes rows to the chat's project/agent/model", async () => {
    await makeChat("c1", { projectId: "px", agentId: "builder", model: "claude-sonnet-5" });
    await toolRow("c1", "t1", "Read");
    await backfill.run();
    expect(metrics.recent()[0]).toMatchObject({
      projectId: "px",
      agent: "builder",
      model: "claude-sonnet-5",
      chatId: "c1",
    });
  });

  it("takes `harness` from the ROW, so a chat that switched runtimes keeps both", async () => {
    await makeChat("c1", { harness: "codex" });
    await toolRow("c1", "t1", "Read", { harness: "claude" });
    await toolRow("c1", "t2", "Bash"); // no per-row harness → falls back to the chat
    await backfill.run();
    const byTool = Object.fromEntries(metrics.recent().map((r) => [r.identifier, r.harness]));
    expect(byTool).toEqual({ Read: "claude", Bash: "codex" });
  });

  it("carries the subagent that made the call", async () => {
    await makeChat("c1");
    await toolRow("c1", "t1", "Read", { subagentType: "Explore" });
    await backfill.run();
    expect(metrics.recent()[0]?.subagent).toBe("Explore");
  });

  it("skips rows that aren't tool calls", async () => {
    await makeChat("c1");
    await store.appendMessage({
      id: "m1",
      chatId: "c1",
      ts: NOW,
      kind: "assistant",
      text: "hi",
    } as ChatMessage);
    await toolRow("c1", "t1", "Read");
    const res = await backfill.run();
    expect(res.rows).toBe(1);
  });

  it("walks every chat, not just the first", async () => {
    await makeChat("c1");
    await makeChat("c2", { projectId: "p2" });
    await toolRow("c1", "t1", "Read");
    await toolRow("c2", "t1", "Read");
    const res = await backfill.run();
    expect(res).toMatchObject({ chats: 2, rows: 2 });
  });
});

describe("MetricsBackfill — it must run once", () => {
  beforeEach(async () => {
    await makeChat("c1");
    await toolRow("c1", "t1", "Read");
    await toolRow("c1", "t2", "Bash");
  });

  it("guard 1: a completed watermark skips the walk entirely", async () => {
    await backfill.run();
    const again = await backfill.run();
    expect(again).toEqual({ ran: false, chats: 0, rows: 0, scanned: 0 });
    expect(metrics.stats().rows).toBe(2);
  });

  it("records the watermark it will later read", async () => {
    await backfill.run();
    const mark = JSON.parse(metrics.getMeta(BACKFILL_META_KEY)!) as Record<string, number>;
    expect(mark).toMatchObject({ version: BACKFILL_VERSION, chats: 1, rows: 2, completedAt: NOW });
  });

  it("guard 2: two concurrent runs are one run", async () => {
    const [a, b] = await Promise.all([backfill.run(), backfill.run()]);
    expect(a).toBe(b); // the same in-flight promise, not two walks
    expect(metrics.stats().rows).toBe(2);
  });

  it("guard 3: even a FORCED re-run cannot double the history", async () => {
    await backfill.run();
    // The guard that actually makes this idempotent: `toolUseId` keys the row,
    // so re-importing converges on the same two rows rather than four.
    const forced = await backfill.run({ force: true });
    expect(forced.ran).toBe(true);
    expect(forced.scanned).toBe(2); // offered again…
    expect(forced.rows).toBe(0); // …and deduped away
    expect(metrics.stats().rows).toBe(2);
  });

  it("guard 3 again: a LOST watermark re-imports to the same rows", async () => {
    await backfill.run();
    metrics.setMeta(BACKFILL_META_KEY, "{ not json");
    const again = await backfill.run();
    expect(again.ran).toBe(true); // an unreadable mark reads as "never ran"
    expect(metrics.stats().rows).toBe(2);
  });

  it("re-runs when the classifier version is bumped, still without doubling", async () => {
    metrics.setMeta(BACKFILL_META_KEY, JSON.stringify({ version: BACKFILL_VERSION - 1 }));
    const res = await backfill.run();
    expect(res.ran).toBe(true);
    expect(metrics.stats().rows).toBe(2);
  });

  it("does not double-count a call the live session already recorded", async () => {
    // The real race: the broker records a call from a live turn while the import
    // is walking the transcript that same call was just written to.
    metrics.record({
      ts: NOW - 1000,
      category: "tool",
      identifier: "Read",
      chatId: "c1",
      toolUseId: "t1",
    });
    metrics.flush();
    await backfill.run();
    expect(metrics.stats().rows).toBe(2);
    // The live row wins — it was there first, and OR IGNORE keeps the original.
    expect(metrics.recent().find((r) => r.identifier === "Read")?.source).toBe("live");
  });

  it("keeps going when one chat's transcript is unreadable", async () => {
    await makeChat("c2");
    await toolRow("c2", "t1", "Edit");
    const real = store.chatTranscriptPath.bind(store);
    store.chatTranscriptPath = (id: string) =>
      // A directory, not a file: `createReadStream` fails on it the way a
      // permission error or a bad sector would.
      id === "c1" ? dir : real(id);
    const res = await backfill.run();
    // c1 is lost, c2 is not — one bad file must not cost the whole import.
    expect(res.rows).toBe(1);
    expect(metrics.recent()[0]?.identifier).toBe("Edit");
  });

  it("skips a malformed line instead of failing the chat", async () => {
    // A torn final append, plus a `tool_result` whose CONTENT quotes a
    // transcript — the substring pre-filter matches it, so the parsed row's own
    // `kind` is what has to reject it.
    await appendRaw("c1", '{"kind":"tool_use","toolUseId":"t9","name":"Read"');
    await appendRaw(
      "c1",
      JSON.stringify({
        id: "m-q",
        chatId: "c1",
        ts: NOW,
        kind: "tool_result",
        toolUseId: "t1",
        ok: true,
        content: 'the log said {"kind":"tool_use","name":"Bash"}',
      }),
    );
    const res = await backfill.run();
    expect(res.rows).toBe(2); // the two real tool calls, and nothing else
  });
});
