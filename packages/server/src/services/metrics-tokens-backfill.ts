/**
 * One-time token import — so the Tokens tab has history on the day it ships.
 *
 * Every result row a transcript ever recorded carries that turn's `usage`, so
 * the TOKENS are recoverable exactly. Two things are not, and this says so
 * rather than pretending:
 *
 *   - THE MODEL. A result row has none. The closest main-loop assistant row
 *     before it does, which is right for the main loop — but a historical
 *     turn's subagent spend on another model is booked under the main one.
 *     Live rows split by model (see `SessionBroker.bookTokens`); history can't.
 *   - THE ACCOUNT. Only the chat's CURRENT account survives on its record. An
 *     imported turn is booked to that account (its pin, else the provider's
 *     current default), which is wrong for exactly the chats that were moved
 *     by a fallback or a manual switch — and right for every other one.
 *
 * Codex transcripts import nothing: its turn-end never carried token counts
 * until this ledger started capturing them.
 *
 * Guards mirror `MetricsBackfill`: a versioned watermark in `metric_meta`, an
 * in-process latch, and the ledger's UNIQUE `usage_key`, which is the guard
 * that actually makes a re-run converge. Its OWN watermark, not a bump of the
 * event import's — that one would re-walk every transcript for tool calls too.
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { figuresOfUsage, subscriptionFor, type HarnessKind } from "@dispatch/shared";
import type { Store } from "../store/index.js";
import type { MetricsService } from "./metrics.js";
import type { TokenLedger, TokenLine } from "./metrics-tokens.js";

export const TOKEN_BACKFILL_VERSION = 1;
export const TOKEN_BACKFILL_META_KEY = "backfill.tokens";

/** Cheap pre-filters before paying for JSON.parse; see MetricsBackfill. */
const RESULT_MARKER = '"kind":"result"';
const ASSISTANT_MARKER = '"kind":"assistant"';

interface Line {
  id?: string;
  kind?: string;
  ts?: number;
  turn?: number;
  sessionId?: string;
  harness?: string;
  model?: string;
  subagentType?: string;
  usage?: unknown;
  costUsd?: number;
  turnCostUsd?: number;
}

export interface TokenBackfillResult {
  ran: boolean;
  chats: number;
  rows: number;
}

export class TokenBackfill {
  private running: Promise<TokenBackfillResult> | null = null;

  constructor(
    private readonly deps: {
      store: Store;
      metrics: MetricsService;
      tokens: TokenLedger;
      now?: () => number;
    },
  ) {}

  async run(opts: { force?: boolean } = {}): Promise<TokenBackfillResult> {
    if (this.running) return this.running;
    if (!opts.force && this.done()) return { ran: false, chats: 0, rows: 0 };
    this.running = this.doRun().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private done(): boolean {
    try {
      const raw = this.deps.metrics.getMeta(TOKEN_BACKFILL_META_KEY);
      return !!raw && (JSON.parse(raw) as { version?: number }).version === TOKEN_BACKFILL_VERSION;
    } catch {
      return false;
    }
  }

  private async doRun(): Promise<TokenBackfillResult> {
    const { store, metrics, tokens } = this.deps;
    const settings = await store.getSettings().catch(() => null);
    const chats = await store.listChats();
    let rows = 0;
    for (const chat of chats) {
      try {
        const harness = (chat.harness ?? "claude") as HarnessKind;
        const subscriptionId = subscriptionFor(settings, harness, chat.subscriptionId).id;
        rows += tokens.record(
          await this.linesForChat(chat.id, {
            projectId: chat.projectId,
            model: chat.model,
            harness,
            subscriptionId,
          }),
        );
      } catch (err) {
        console.error(`[Dispatch] metrics: token backfill skipped chat ${chat.id}:`, err);
      }
      // Off the boot path: yield between every chat (see MetricsBackfill).
      await new Promise((resolve) => setImmediate(resolve));
    }
    metrics.setMeta(
      TOKEN_BACKFILL_META_KEY,
      JSON.stringify({
        version: TOKEN_BACKFILL_VERSION,
        completedAt: (this.deps.now ?? Date.now)(),
        chats: chats.length,
        rows,
      }),
    );
    return { ran: true, chats: chats.length, rows };
  }

  private async linesForChat(
    chatId: string,
    chat: {
      projectId?: string;
      model?: string;
      harness: HarnessKind;
      subscriptionId: string;
    },
  ): Promise<TokenLine[]> {
    const path = this.deps.store.chatTranscriptPath(chatId);
    if (!existsSync(path)) return [];
    const out: TokenLine[] = [];
    const booked = this.deps.tokens.bookedResults(chatId);
    let model = chat.model;
    // Per native session: older result rows predate `turnCostUsd` and carry only
    // the provider's running total, which has to be diffed here instead.
    const lastCost = new Map<string, number>();
    const lines = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    try {
      for await (const text of lines) {
        const isResult = text.includes(RESULT_MARKER);
        if (!isResult && !text.includes(ASSISTANT_MARKER)) continue;
        let row: Line;
        try {
          row = JSON.parse(text) as Line;
        } catch {
          continue;
        }
        if (row.kind === "assistant") {
          // Main loop only: a subagent's model is not the turn's model.
          if (row.model && !row.subagentType) model = row.model;
          continue;
        }
        if (row.kind !== "result" || !row.id || typeof row.ts !== "number" || row.ts <= 0) continue;
        let cost = row.turnCostUsd;
        if (cost === undefined && typeof row.costUsd === "number") {
          const key = row.sessionId ?? "-";
          const prev = lastCost.get(key);
          cost = prev === undefined || row.costUsd < prev ? row.costUsd : row.costUsd - prev;
        }
        if (typeof row.costUsd === "number") lastCost.set(row.sessionId ?? "-", row.costUsd);
        const figures = figuresOfUsage(row.usage);
        if (!figures || booked.has(row.id)) continue;
        out.push({
          ...figures,
          costUsd: cost,
          ts: row.ts,
          resultId: row.id,
          chatId,
          projectId: chat.projectId,
          harness: row.harness ?? chat.harness,
          subscriptionId: chat.subscriptionId,
          model,
          turn: row.turn,
          source: "backfill",
        });
      }
    } finally {
      lines.close();
    }
    return out;
  }
}
