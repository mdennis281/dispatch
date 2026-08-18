/**
 * One-time transcript import — so the Metrics page has history on the day it
 * ships instead of being an empty chart until you happen to use the app.
 *
 * Walks every chat's `messages.jsonl`, turns each `tool_use` row into a ledger
 * row, and marks itself done. It reconstructs only what a transcript actually
 * records: tool calls (which covers tools, MCP, manager endpoints, skills and
 * subagents). Memories and instruction injections are NOT addressable rows in a
 * transcript, so they only exist from the moment live recording started —
 * `source: "backfill"` is what lets a chart tell that apart from "nobody used
 * them".
 *
 * IT MUST RUN ONCE. Three independent guards, because "runs twice" here means
 * every historical number silently doubles:
 *
 *   1. A watermark in `metric_meta` — set on completion, checked on entry. The
 *      normal case: a restart skips the whole walk without opening a file.
 *   2. An in-process `running` latch, so two `start()`s in one process (a test,
 *      a re-entrant boot) can't overlap.
 *   3. The ledger's own UNIQUE `event_key`. Every tool call keys off its
 *      `toolUseId`, so even a watermark that got lost — a hand-edited row, a
 *      crash mid-import — re-imports to the SAME rows rather than to duplicates.
 *      This is the guard that actually makes the operation idempotent; the first
 *      two only make it cheap.
 *
 * The watermark records a VERSION, not a boolean, so a future fix to the
 * classifier can deliberately re-run the import (the UNIQUE key keeps that from
 * doubling anything) by bumping the constant.
 *
 * IT MUST ALSO STAY OFF THE BOOT PATH. This is kicked off from
 * `services.start()`, which is awaited BEFORE the server listens — so anything
 * it does without yielding is time the app is not answering requests. On a real
 * install that is ~300 chats and a couple of hundred megabytes of transcript.
 * Hence: stream each file line by line rather than slurping it, reject non-tool
 * rows with a substring test before paying for `JSON.parse`, and yield to the
 * event loop between every chat.
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Store } from "../store/index.js";
import type { MetricsService, MetricInput } from "./metrics.js";
import { classifyTool } from "./metrics-classify.js";

/**
 * Bump to re-run the import against every chat — e.g. after a classifier fix.
 * Re-running is safe (the UNIQUE `event_key` absorbs it); it only costs a walk.
 */
export const BACKFILL_VERSION = 1;

/** `metric_meta` key holding the completed import's watermark. */
export const BACKFILL_META_KEY = "backfill";

/**
 * The cheap pre-filter. A transcript is mostly `assistant` and `tool_result`
 * rows, and `tool_result` rows carry the bulk of the BYTES (whole file reads,
 * command output). Testing for this substring first means `JSON.parse` is only
 * paid for rows that can possibly matter — a small minority of lines, and a tiny
 * minority of bytes.
 *
 * It is a pre-filter, not the test: a `tool_result` quoting a transcript can
 * contain this string, so the PARSED row still has to say what it is.
 */
const TOOL_USE_MARKER = '"kind":"tool_use"';

/** What the watermark records, so a later run can decide whether to repeat. */
interface Watermark {
  version: number;
  completedAt: number;
  chats: number;
  rows: number;
}

export interface BackfillResult {
  /** False when the watermark said it was already done. */
  ran: boolean;
  chats: number;
  /** Rows actually written — duplicates the UNIQUE key absorbed aren't counted. */
  rows: number;
  /** Rows offered to the ledger, including any it deduped away. */
  scanned: number;
}

/** The transcript fields this import reads. Everything else is ignored. */
interface ToolUseLine {
  kind?: string;
  ts?: number;
  turn?: number;
  toolUseId?: string;
  name?: string;
  input?: Record<string, unknown>;
  subagentType?: string;
  harness?: string;
}

export interface MetricsBackfillDeps {
  store: Store;
  metrics: MetricsService;
  now?: () => number;
}

export class MetricsBackfill {
  private readonly store: Store;
  private readonly metrics: MetricsService;
  private readonly now: () => number;
  /** Guard 2: one import at a time within this process. */
  private running: Promise<BackfillResult> | null = null;

  constructor(deps: MetricsBackfillDeps) {
    this.store = deps.store;
    this.metrics = deps.metrics;
    this.now = deps.now ?? Date.now;
  }

  /** The completed import's watermark, or null if it never finished. */
  private watermark(): Watermark | null {
    const raw = this.metrics.getMeta(BACKFILL_META_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Watermark;
      return typeof parsed?.version === "number" ? parsed : null;
    } catch {
      // A corrupt watermark reads as "never ran". Re-importing is safe; treating
      // unreadable state as done would lose the history for good.
      return null;
    }
  }

  /**
   * Import if it hasn't been done at this version. `force` skips guard 1 only —
   * the UNIQUE `event_key` still makes a forced re-run converge on the same rows.
   */
  async run(opts: { force?: boolean } = {}): Promise<BackfillResult> {
    if (this.running) return this.running;
    if (!opts.force && this.watermark()?.version === BACKFILL_VERSION) {
      return { ran: false, chats: 0, rows: 0, scanned: 0 };
    }
    this.running = this.doRun().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doRun(): Promise<BackfillResult> {
    const chats = await this.store.listChats();
    let rows = 0;
    let scanned = 0;
    for (const chat of chats) {
      try {
        const batch = await this.rowsForChat(chat.id);
        scanned += batch.length;
        // BOTH halves count: a chat with more rows than the write buffer's size
        // cap flushes part-way through `recordMany`, and those writes are only
        // reported by its return value.
        rows += this.metrics.recordMany(batch);
        // Flush per chat rather than at the end: the buffer's overflow cap is
        // 20k rows and a long-lived install holds far more than that.
        rows += this.metrics.flush();
      } catch (err) {
        // One unreadable transcript must not abort the import of every other.
        console.error(`[Dispatch] metrics: backfill skipped chat ${chat.id}:`, err);
      }
      // Between EVERY chat, not every N: the server has not started listening
      // yet, and one large transcript is already long enough to notice.
      await new Promise((resolve) => setImmediate(resolve));
    }
    rows += this.metrics.flush();
    const mark: Watermark = {
      version: BACKFILL_VERSION,
      completedAt: this.now(),
      chats: chats.length,
      rows,
    };
    this.metrics.setMeta(BACKFILL_META_KEY, JSON.stringify(mark));
    return { ran: true, chats: chats.length, rows, scanned };
  }

  /**
   * A chat's transcript → its ledger rows, streamed.
   *
   * Parsed here rather than through `Store.readMessages`, which slurps the whole
   * file and zod-validates every row — correct for opening one chat, ruinous for
   * a sweep across every transcript in the store. That is precisely what
   * `chatTranscriptPath` exists for. Parsing is defensive instead: a row counts
   * only if it carries the fields that make it a tool call, so a torn final line
   * or a legacy shape is skipped rather than thrown.
   *
   * `harness` is stamped PER ROW in the transcript, so it survives a chat that
   * switched runtimes mid-history. `agent` and `model` are not — they exist only
   * on the chat record, so a chat whose agent changed later attributes its whole
   * history to the current one. That imprecision is inherent to reconstructing
   * history, and is exactly why live rows are stamped off the live session
   * instead of being re-derived from the chat.
   */
  private async rowsForChat(chatId: string): Promise<MetricInput[]> {
    const path = this.store.chatTranscriptPath(chatId);
    if (!existsSync(path)) return [];
    const chat = await this.store.getChat(chatId).catch(() => null);
    const out: MetricInput[] = [];
    const lines = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of lines) {
        if (!line.includes(TOOL_USE_MARKER)) continue;
        let row: ToolUseLine;
        try {
          row = JSON.parse(line) as ToolUseLine;
        } catch {
          continue; // a torn final append, or a line that isn't JSON
        }
        if (row.kind !== "tool_use" || !row.toolUseId || typeof row.name !== "string") continue;
        // A row with no usable timestamp is DROPPED, not dated. Both fallbacks
        // are worse than losing it: the epoch stretches every "all time" chart
        // across 56 years of empty buckets to show one point, and "now" files a
        // call from last year into today's bucket. `ts` is required on every row
        // the app has ever written, so this only ever catches corruption.
        if (typeof row.ts !== "number" || row.ts <= 0) continue;
        out.push({
          ts: row.ts,
          ...classifyTool(row.name, row.input),
          projectId: chat?.projectId,
          chatId,
          agent: chat?.agentId,
          subagent: row.subagentType,
          model: chat?.model,
          harness: row.harness ?? chat?.harness,
          turn: row.turn,
          source: "backfill",
          toolUseId: row.toolUseId,
        });
      }
    } finally {
      // Closing the interface destroys the underlying stream, so a throw can't
      // leave a file handle open — which on Windows blocks the data dir from
      // being removed, and is every store test's teardown.
      lines.close();
    }
    return out;
  }
}
