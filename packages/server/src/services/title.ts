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
 * The `query` fn + `now` are injectable so tests script a fake stream without a
 * `claude` subprocess or the network.
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Chat, ChatMessage } from "@cm/shared";
import type { Store } from "../store/index.js";
import type { EventBus } from "../bus.js";

/** The default title a chat is born with — the gate for auto-generation. */
export const DEFAULT_CHAT_TITLE = "New chat";

/** Cheapest model — titles never justify Opus/Sonnet spend. */
export const TITLE_MODEL = "claude-haiku-4-5";

/** Max wall-clock a single title generation may take before we abandon it. */
const TITLE_TIMEOUT_MS = 20_000;

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

/** First user message text (the seed for the initial title). */
function firstUserText(messages: ChatMessage[]): string {
  for (const m of messages) {
    if (m.kind === "user" && typeof m.text === "string" && m.text.trim()) {
      return m.text.trim();
    }
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
    if (m.kind === "user" && typeof m.text === "string" && m.text.trim()) {
      parts.push(m.text.trim());
    }
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
  /** chatIds with an in-flight generation — dedupes concurrent triggers. */
  private readonly inFlight = new Set<string>();

  constructor(opts: TitleServiceOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.query = opts.query ?? (sdkQuery as unknown as TitleQueryFn);
    this.now = opts.now ?? (() => Date.now());
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
    await this.generate(chatId, titlePrompt(seed));
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
    await this.generate(chatId, titlePrompt(seed));
  }

  /** Run the one-shot query, sanitize, and persist + broadcast the new title. */
  private async generate(chatId: string, prompt: string): Promise<void> {
    if (this.inFlight.has(chatId)) return;
    this.inFlight.add(chatId);
    try {
      const title = sanitizeTitle(await this.runQuery(prompt));
      if (!title) return;
      // Re-read so we never clobber a title the user renamed while we ran, and to
      // patch onto the freshest chat record.
      const chat = await this.store.getChat(chatId).catch(() => null);
      if (!chat) return;
      const updated: Chat = { ...chat, title, updatedAt: this.now() };
      const saved = await this.store.saveChat(updated);
      this.bus.publish({ type: "chat-update", chat: saved });
    } catch (err) {
      // Best-effort: a title is a nicety, never surface as a chat error.
      this.bus.publish({
        type: "notice",
        chatId,
        level: "info",
        text: `Title generation skipped (${err instanceof Error ? err.message : String(err)}).`,
      });
    } finally {
      this.inFlight.delete(chatId);
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
        },
      });
      for await (const msg of q) collectText(msg, acc);
    } finally {
      clearTimeout(timer);
    }
    return acc.text.trim() || acc.result.trim();
  }
}

/**
 * A deterministic, in-process stand-in for the one-shot title query, gated by
 * `CM_FAKE_SDK=1` (see container.ts) so E2E never spawns a `claude` subprocess
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
