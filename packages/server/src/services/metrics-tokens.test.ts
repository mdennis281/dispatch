import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat } from "@dispatch/shared";
import { figuresOfUsage } from "@dispatch/shared";
import { Store } from "../store/index.js";
import { MetricsService } from "./metrics.js";
import { TokenLedger, tokenLabeller, type TokenLine } from "./metrics-tokens.js";
import { TokenBackfill } from "./metrics-tokens-backfill.js";

let dir: string;
let store: Store;
let metrics: MetricsService;
let tokens: TokenLedger;

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const HOUR = 3_600_000;
const label = (_dim: string, key: string) => key || "(none)";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-tokens-"));
  store = new Store(dir);
  metrics = new MetricsService({
    db: store.stateDb,
    now: () => NOW,
    flushMs: 0,
  });
  tokens = new TokenLedger(store.stateDb, () => NOW);
});
afterEach(async () => {
  metrics.dispose();
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function line(over: Partial<TokenLine>): TokenLine {
  return {
    ts: NOW - HOUR,
    resultId: "r1",
    chatId: "c1",
    harness: "claude",
    subscriptionId: "claude1",
    model: "claude-opus-5-5",
    turn: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...over,
  };
}

describe("figuresOfUsage", () => {
  it("reads Anthropic's snake_case usage as-is", () => {
    expect(
      figuresOfUsage({
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 40,
      }),
    ).toEqual({ input: 10, output: 20, cacheRead: 300, cacheWrite: 40 });
  });

  it("takes Codex's cached tokens OUT of its input figure", () => {
    // OpenAI counts cached input inside `inputTokens`; Anthropic does not. Left
    // alone, "input" would mean two different things on two rows of one table.
    expect(
      figuresOfUsage({
        inputTokens: 1000,
        cachedInputTokens: 800,
        outputTokens: 50,
      }),
    ).toEqual({
      input: 200,
      output: 50,
      cacheRead: 800,
      cacheWrite: 0,
    });
  });

  it("returns undefined for a payload with no counters", () => {
    expect(figuresOfUsage({ input_tokens: 0, output_tokens: 0 })).toBeUndefined();
    expect(figuresOfUsage(undefined)).toBeUndefined();
  });
});

describe("TokenLedger", () => {
  it("dedups on (chat, result, model) so a re-record is a no-op", () => {
    expect(tokens.record([line({ input: 5 })])).toBe(1);
    expect(tokens.record([line({ input: 5 })])).toBe(0);
    expect(tokens.record([line({ input: 5, model: "claude-haiku-5-5" })])).toBe(1);
    expect(tokens.bookedResults("c1")).toEqual(new Set(["r1"]));
  });

  it("books a context-window variant under its base model", () => {
    tokens.record([
      line({ resultId: "a", input: 1, model: "claude-opus-5-5[1m]" }),
      line({ resultId: "b", input: 2 }),
    ]);
    expect(tokens.report({}, label).rows.map((r) => [r.model, r.total])).toEqual([
      ["claude-opus-5-5", 3],
    ]);
  });

  it("splits by account × model, and reports an unpriced group as null, not $0", () => {
    tokens.record([
      line({ resultId: "a", input: 100, output: 10, costUsd: 1 }),
      line({
        resultId: "b",
        input: 50,
        costUsd: 0.5,
        subscriptionId: "claude2",
      }),
      line({
        resultId: "c",
        input: 7,
        harness: "codex",
        subscriptionId: "codex",
        model: "gpt-5",
      }),
    ]);
    const r = tokens.report({ groupBy: "subscription" }, label);
    expect(r.totals.total).toBe(167);
    expect(r.totals.costUsd).toBeCloseTo(1.5);
    expect(r.rows.map((x) => [x.subscriptionId, x.model, x.total, x.costUsd])).toEqual([
      ["claude1", "claude-opus-5-5", 110, 1],
      ["claude2", "claude-opus-5-5", 50, 0.5],
      ["codex", "gpt-5", 7, null],
    ]);
    expect(r.series.map((s) => [s.key, s.total])).toEqual([
      ["claude1", 110],
      ["claude2", 50],
      ["codex", 7],
    ]);
    // Facets ignore their own filter, so picking one account keeps the others offered.
    const narrowed = tokens.report(
      { groupBy: "model", filter: { subscription: ["claude2"] } },
      label,
    );
    expect(narrowed.totals.total).toBe(50);
    expect(narrowed.facets.subscription?.map((f) => f.value).sort()).toEqual([
      "claude1",
      "claude2",
      "codex",
    ]);
  });

  it("plots the chosen measure", () => {
    tokens.record([line({ input: 100, output: 10, costUsd: 2 })]);
    expect(tokens.report({ measure: "output" }, label).series[0]?.total).toBe(10);
    expect(tokens.report({ measure: "cost" }, label).series[0]?.total).toBe(2);
  });
});

describe("tokenLabeller", () => {
  it("names an account by its current settings, and the implicit default by its provider", () => {
    // History booked under the implicit "claude" id before a named Claude
    // account was added: that id no longer resolves, but nothing was removed.
    const label = tokenLabeller({
      subscriptions: [{ id: "work", name: "Work Max", provider: "claude" }],
    });
    expect(label("subscription", "work")).toBe("Work Max");
    expect(label("subscription", "claude")).toBe("Claude");
    expect(label("subscription", "old-acct")).toBe("old-acct (removed)");
    expect(label("subscription", "")).toBe("(unknown account)");
  });
});

describe("TokenBackfill", () => {
  async function makeChat(id: string, over: Partial<Chat> = {}): Promise<Chat> {
    return store.saveChat({
      id,
      projectId: "p1",
      title: id,
      modeId: "default",
      effort: "medium",
      model: "claude-opus-5",
      harness: "claude",
      worktrees: [],
      prs: [],
      createdAt: 1,
      ...over,
    } as Chat);
  }
  const raw = (chatId: string, row: object) =>
    appendFile(store.chatTranscriptPath(chatId), `${JSON.stringify(row)}\n`, "utf8");

  it("imports result usage under the preceding main-loop model, and skips turns already booked live", async () => {
    await makeChat("c1");
    await raw("c1", {
      id: "a1",
      chatId: "c1",
      ts: NOW - 3 * HOUR,
      turn: 0,
      kind: "assistant",
      text: "",
      model: "claude-opus-5-5",
    });
    // A subagent's row must not steal the turn's model.
    await raw("c1", {
      id: "a2",
      chatId: "c1",
      ts: NOW - 3 * HOUR,
      turn: 0,
      kind: "assistant",
      text: "",
      model: "claude-haiku-5-5",
      subagentType: "Explore",
    });
    await raw("c1", {
      id: "r1",
      chatId: "c1",
      ts: NOW - 3 * HOUR,
      turn: 0,
      kind: "result",
      subtype: "success",
      isError: false,
      usage: { input_tokens: 10, output_tokens: 20 },
      costUsd: 4,
      sessionId: "s",
    });
    // Older rows carry only the running total; the import diffs it itself.
    await raw("c1", {
      id: "r2",
      chatId: "c1",
      ts: NOW - 2 * HOUR,
      turn: 1,
      kind: "result",
      subtype: "success",
      isError: false,
      usage: { input_tokens: 1, output_tokens: 2 },
      costUsd: 5.5,
      sessionId: "s",
    });
    await raw("c1", {
      id: "r3",
      chatId: "c1",
      ts: NOW - HOUR,
      turn: 2,
      kind: "result",
      subtype: "success",
      isError: false,
      usage: { input_tokens: 99, output_tokens: 99 },
      costUsd: 6,
      turnCostUsd: 0.5,
      sessionId: "s",
    });
    // r3 was already booked live, split across two models.
    tokens.record([
      line({ resultId: "r3", model: "claude-opus-5-5", input: 90 }),
      line({ resultId: "r3", model: "claude-haiku-5-5", input: 9 }),
    ]);

    const res = await new TokenBackfill({
      store,
      metrics,
      tokens,
      now: () => NOW,
    }).run();
    expect(res).toMatchObject({ ran: true, rows: 2 });
    const rows = store.stateDb
      .prepare(
        "SELECT usage_key, model, cost_usd, subscription_id, source FROM metric_tokens WHERE source = 'backfill' ORDER BY ts",
      )
      .all() as { model: string; cost_usd: number; subscription_id: string }[];
    expect(rows.map((r) => [r.model, r.cost_usd, r.subscription_id])).toEqual([
      ["claude-opus-5-5", 4, "claude"],
      ["claude-opus-5-5", 1.5, "claude"],
    ]);
    // Watermarked: a second run does nothing.
    expect((await new TokenBackfill({ store, metrics, tokens }).run()).ran).toBe(false);
  });
});
