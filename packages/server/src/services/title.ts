/**
 * TitleService — cheap, best-effort AI chat titles.
 *
 * After a chat's FIRST turn completes (wired in the container off the `result`
 * transcript row) we generate a short title (aim ~35 chars) from the opening
 * user message via a ONE-SHOT Agent SDK `query()` on the cheapest model
 * (`claude-haiku-4-5`), with `settingSources: []` + `maxTurns: 1` so it never
 * loads repo settings / MCP and never turns into a real agent loop. The result
 * is sanitized to a short title, saved to `chat.title`, and broadcast via
 * `chat-update`. Everything is fire-and-forget: any failure leaves the chat on
 * its default "New chat" title.
 *
 * `regenerate(chatId)` re-runs the same generator from the chat's recent USER
 * messages (ignoring the default-title gate) so a user can force a fresh title.
 * Both flows read ONLY user messages — assistant output never seeds a title.
 *
 * Each generation spawns a `claude` subprocess, so the failure mode that
 * actually bit was contention, not the model: finish a few turns at once and
 * several title queries race the real chats' own spawns, every one of them
 * blows a short deadline, and the user gets a row of "Title generation skipped
 * (Operation aborted)" notices — the SDK's message for OUR timeout firing. So
 * generations are gated to {@link TITLE_CONCURRENCY} at a time, get a wall-clock
 * budget a cold Windows spawn can actually fit in, and retry before giving up.
 * A notice is emitted only once the whole budget is spent.
 *
 * The `query` fn, `now` and `sleep` are injectable so tests script a fake stream
 * without a `claude` subprocess, the network, or real backoff waits.
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { stripTitleMarks, titlePrefixOf, withTitlePrefix } from "@dispatch/shared";
import type { Chat, ChatMessage } from "@dispatch/shared";
import type { Store } from "../store/index.js";
import type { EventBus } from "../bus.js";
import { claudeExecutableOption } from "./runtime.js";

/** The default title a chat is born with — the gate for auto-generation. */
export const DEFAULT_CHAT_TITLE = "New chat";

/** Cheapest model — titles never justify Opus/Sonnet spend. */
export const TITLE_MODEL = "claude-haiku-4-5";

/**
 * Max wall-clock ONE attempt may take before we abandon it. Generous on
 * purpose: nothing waits on a title, and the old 20s couldn't cover a cold
 * `claude` spawn on Windows while the machine was busy starting a real turn —
 * which is precisely when a title is generated.
 */
const TITLE_TIMEOUT_MS = 60_000;

/** Attempts one generation gets. A spawn that lost a race deserves a rerun. */
const TITLE_ATTEMPTS = 3;

/** Backoff before attempt 2, 3, … — let the contention that killed us clear. */
const TITLE_RETRY_DELAY_MS = [2_000, 6_000];

/**
 * How many title queries may be in flight across ALL chats. Each is a `claude`
 * subprocess; letting eight fire at once is how they starve each other into the
 * timeout. Queued generations don't start their clock until they run.
 */
const TITLE_CONCURRENCY = 2;

/** The subset of the SDK `query` signature this service calls (single-shot). */
export type TitleQueryFn = (params: {
  prompt: string;
  options?: Options;
}) => Query;

export interface TitleServiceOptions {
  store: Store;
  bus: EventBus;
  query?: TitleQueryFn;
  now?: () => number;
  /** Backoff waiter — tests pass a no-op so retries don't cost real seconds. */
  sleep?: (ms: number) => Promise<void>;
}

/* --------------------------------------------------------------- helpers */

/** Collapse whitespace + drop wrapping quotes/backticks/`Title:` prefixes. */
function sanitizeTitle(raw: string): string {
  let t = (raw ?? "").replace(/\r/g, "").trim();
  if (!t) return "";
  // Model sometimes narrates ("Here's a title:\n...") — take the last non-empty
  // line, which is where the bare title lands.
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  t = lines.length ? lines[lines.length - 1]! : t;
  t = t.replace(/^(?:title|chat title)\s*[:\-–]\s*/i, "");
  // Strip a single layer of surrounding quotes/backticks/asterisks.
  t = t.replace(/^["'`*_]+/, "").replace(/["'`*_]+$/, "");
  t = t.replace(/\s+/g, " ").trim();
  // Drop trailing sentence punctuation.
  t = t.replace(/[.!?,;:]+$/, "").trim();
  if (!t) return "";
  // No hard word/short-char cap: we ASK the model to aim for ~35 chars but allow
  // a longer title when it's genuinely clearer. Only guard against a runaway
  // paragraph, trimming back to a word boundary so we never cut mid-word.
  if (t.length > 80) {
    t = t.slice(0, 80);
    const lastSpace = t.lastIndexOf(" ");
    if (lastSpace > 40) t = t.slice(0, lastSpace);
    t = t.trim();
  }
  return t;
}

/** Pull the assistant/result text out of a one-shot query stream. */
function collectText(msg: SDKMessage, acc: { text: string; result: string }): void {
  const m = msg as unknown as Record<string, unknown> & { type?: string };
  if (m.type === "assistant") {
    const content = (m.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
          acc.text += String((b as { text?: unknown }).text ?? "");
        }
      }
    }
  } else if (m.type === "result" && typeof (m as { result?: unknown }).result === "string") {
    acc.result = (m as { result: string }).result;
  }
}

/**
 * The HUMAN's words in a user row.
 *
 * A composed turn's `text` is mostly Dispatch's: a launched task sends a
 * briefing of house rules and paths with the human's one sentence buried in it,
 * and titling from that produces "Add MCP Server To Dispatch Config" for every
 * config chat ever launched — the boilerplate, not the ask. When the row carries
 * an authorship breakdown we read only the parts the human actually wrote;
 * rows without one are unchanged, and a row that is ALL briefing (a sweep
 * launched with no instructions) contributes nothing rather than its briefing.
 */
function humanText(m: ChatMessage): string {
  if (m.kind !== "user") return "";
  const parts = m.parts;
  if (parts?.length) {
    return parts
      .filter((p) => p.kind === "text" || p.kind === "instructions")
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join("\n");
  }
  return typeof m.text === "string" ? m.text.trim() : "";
}

/** First user message text (the seed for the initial title). */
function firstUserText(messages: ChatMessage[]): string {
  for (const m of messages) {
    const text = humanText(m);
    if (text) return text;
  }
  return "";
}

/**
 * Recent USER message text — the seed for regeneration. We deliberately IGNORE
 * assistant/AI output: the title should describe what the user is working on,
 * not how the AI narrated its work (that's how you get useless titles like
 * "Three PRs Shipped"). Messages come in oldest→newest within the recent
 * window, so the tail is the most recent thing the user asked for.
 */
function recentUserText(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = humanText(m);
    if (text) parts.push(text);
  }
  return parts.join("\n").slice(0, 2_000);
}

/** Build the one-shot title prompt from some user-request context. */
function titlePrompt(source: string): string {
  return [
    "Generate a short chat title naming the topic or feature the user is working on,",
    "based only on the user's requests below.",
    "Aim for under 35 characters (a few words). A little longer is fine when it's",
    "genuinely needed for clarity — but don't pad it, and never write a full sentence.",
    "Rules: Title Case, no surrounding quotes, no trailing punctuation, no preamble.",
    "Respond with ONLY the title.",
    "",
    source.slice(0, 2_000),
  ].join("\n");
}

/* =============================================================== TitleService */

export class TitleService {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly query: TitleQueryFn;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /**
   * In-flight generation per chatId — dedupes concurrent triggers. Holds the
   * PROMISE, not just the id, so a user-initiated regenerate can wait for the
   * automatic run it collided with instead of being silently dropped.
   */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Free slots in the global gate; waiters queue in `slotWaiters`. */
  private slots = TITLE_CONCURRENCY;
  private readonly slotWaiters: Array<() => void> = [];

  constructor(opts: TitleServiceOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.query = opts.query ?? (sdkQuery as unknown as TitleQueryFn);
    this.now = opts.now ?? (() => Date.now());
    this.sleep =
      opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Generate an initial title IFF the chat is still on its default title.
   * Called after the first turn completes. Best-effort + idempotent.
   */
  async maybeGenerateInitialTitle(chatId: string): Promise<void> {
    const chat = await this.store.getChat(chatId).catch(() => null);
    if (!chat || chat.title.trim() !== DEFAULT_CHAT_TITLE) return;
    const messages = await this.store.readMessages(chatId).catch(() => []);
    const seed = firstUserText(messages);
    if (!seed) return;
    await this.generate(chatId, titlePrompt(seed), { requireDefaultTitle: true });
  }

  /**
   * Force a fresh title from the chat's recent messages, ignoring the default
   * gate (the `regenerate-title` action). Best-effort.
   */
  async regenerate(chatId: string): Promise<void> {
    const chat = await this.store.getChat(chatId).catch(() => null);
    if (!chat) return;
    const messages = await this.store.readMessages(chatId, { limit: 12 }).catch(() => []);
    // Recent user turns only — a regenerate means "the current title is stale,
    // reflect what I'm doing now", so we weight the latest user requests.
    const seed = recentUserText(messages) || firstUserText(messages);
    if (!seed.trim()) return;
    // A spawned chat's title leads with an emphasized category (`**sweep**: …`)
    // that names WHERE the chat came from — something the transcript can't tell
    // the model and regeneration would therefore drop. Carry it across.
    await this.generate(chatId, titlePrompt(seed), {
      prefix: titlePrefixOf(chat.title),
      userInitiated: true,
    });
  }

  /**
   * Run the one-shot query, sanitize, and persist + broadcast the new title.
   *
   * A collision with an already-running generation means one of two things. An
   * AUTOMATIC trigger (we fire on every user/result row until the chat is named)
   * is redundant, so it's dropped. A USER-initiated regenerate is a request we
   * owe an answer to — dropping it is why "clicked Regenerate, nothing
   * happened" — so it waits for the run in flight and then takes its own turn.
   */
  private async generate(
    chatId: string,
    prompt: string,
    opts: {
      prefix?: string | null;
      userInitiated?: boolean;
      /** Abandon the result if the chat stopped being default-titled meanwhile. */
      requireDefaultTitle?: boolean;
    } = {},
  ): Promise<void> {
    const running = this.inFlight.get(chatId);
    if (running) {
      if (!opts.userInitiated) return;
      await running.catch(() => {});
      // Whoever we waited on may have been another regenerate that already
      // started a third; one hand-off is enough to avoid an unbounded chain.
      if (this.inFlight.has(chatId)) return;
    }
    const run = this.runGeneration(chatId, prompt, opts.prefix ?? null, {
      requireDefaultTitle: opts.requireDefaultTitle === true,
    });
    this.inFlight.set(chatId, run);
    try {
      await run;
    } finally {
      // Only clear OUR entry — a regenerate that queued behind us may have
      // installed its own by now.
      if (this.inFlight.get(chatId) === run) this.inFlight.delete(chatId);
    }
  }

  /** One generation, retries and all. Never throws — a title is best-effort. */
  private async runGeneration(
    chatId: string,
    prompt: string,
    prefix: string | null,
    guard: { requireDefaultTitle: boolean },
  ): Promise<void> {
    let lastError = "";
    for (let attempt = 0; attempt < TITLE_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await this.sleep(TITLE_RETRY_DELAY_MS[attempt - 1] ?? 6_000);
      }
      try {
        // Marks are ours to add, never the model's: a stray `**…**` in generated
        // prose would accent an arbitrary word and read as a category that isn't
        // one. Only the prefix below may emphasize.
        const generated = stripTitleMarks(sanitizeTitle(await this.gated(prompt)));
        // An empty answer is as useless as a thrown one, and just as likely to
        // be a truncated stream — worth another attempt rather than a silent
        // no-op that leaves the chat on "New chat".
        if (!generated) {
          lastError = "the model returned an empty title";
          continue;
        }
        const title = prefix ? withTitlePrefix(prefix, generated) : generated;
        // Re-read so we never clobber a title the user renamed while we ran, and
        // to patch onto the freshest chat record. The window is wide now —
        // retries can span minutes — so the automatic path re-checks the gate it
        // was admitted through rather than trusting the read from before.
        const chat = await this.store.getChat(chatId).catch(() => null);
        if (!chat) return;
        if (guard.requireDefaultTitle && chat.title.trim() !== DEFAULT_CHAT_TITLE) return;
        const updated: Chat = { ...chat, title, updatedAt: this.now() };
        const saved = await this.store.saveChat(updated);
        this.bus.publish({ type: "chat-update", chat: saved });
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    // Every attempt spent. Best-effort: a title is a nicety, never a chat error
    // — but say how to get one rather than leaving a dead end.
    this.bus.publish({
      type: "notice",
      chatId,
      level: "info",
      text: `Title generation skipped after ${TITLE_ATTEMPTS} tries (${lastError}). Chat menu → Regenerate title to retry.`,
    });
  }

  /** Run a query under the global concurrency gate. */
  private async gated(prompt: string): Promise<string> {
    if (this.slots > 0) this.slots--;
    else await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    try {
      return await this.runQuery(prompt);
    } finally {
      const next = this.slotWaiters.shift();
      // Hand the slot straight to the next waiter rather than releasing it —
      // releasing would let a newly-arriving generation jump the queue.
      if (next) next();
      else this.slots++;
    }
  }

  private async runQuery(prompt: string): Promise<string> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TITLE_TIMEOUT_MS);
    const acc = { text: "", result: "" };
    try {
      const q = this.query({
        prompt,
        options: {
          model: TITLE_MODEL,
          settingSources: [],
          maxTurns: 1,
          abortController: abort,
          ...claudeExecutableOption(),
        },
      });
      for await (const msg of q) collectText(msg, acc);
    } catch (err) {
      // The SDK reports OUR abort as a bare "Operation aborted", which reads as
      // if something cancelled the chat. Name the actual cause — but only when
      // we're the ones who aborted; a partial answer still beats an error.
      if (abort.signal.aborted) {
        const text = acc.text.trim() || acc.result.trim();
        if (text) return text;
        throw new Error(`timed out after ${Math.round(TITLE_TIMEOUT_MS / 1000)}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return acc.text.trim() || acc.result.trim();
  }
}

/**
 * A deterministic, in-process stand-in for the one-shot title query, gated by
 * `DISPATCH_FAKE_SDK=1` (see container.ts) so E2E never spawns a `claude` subprocess
 * for titles. Derives a short title from the prompt's seed line.
 */
export function makeFakeTitleQuery(): TitleQueryFn {
  return ({ prompt }) => {
    async function* gen(): AsyncGenerator<unknown, void> {
      const lines = prompt.split("\n").map((l) => l.trim()).filter(Boolean);
      const seed = lines.length ? lines[lines.length - 1]! : "New Chat";
      const title = seed.split(/\s+/).slice(0, 4).join(" ") || "New Chat";
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: title }] },
      };
      yield { type: "result", subtype: "success", is_error: false, result: title };
    }
    const g = gen() as unknown as Record<string, unknown>;
    g.interrupt = async () => {};
    g.setModel = async () => {};
    g.setPermissionMode = async () => {};
    g.setMaxThinkingTokens = async () => {};
    return g as unknown as Query;
  };
}
