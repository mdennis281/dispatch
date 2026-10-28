/**
 * Summarize a chat with a Dispatch-run model — `chat_summarize` on the manager
 * MCP (agents and integrations alike) and `GET /api/integration/chats/:id/summary`.
 *
 * Runs on the CHAT'S OWN provider and account, the way titles do: a summary of
 * a Codex chat on a second subscription must not draw down somebody else's
 * Claude budget, and a chat whose provider is switched off gets an honest
 * "unavailable" rather than a silent fallback (#426).
 *
 * THREE THINGS KEEP IT CHEAP, because the caller is often a bot in a loop:
 *
 *   - CACHED per chat until a new row lands. "Summarize" on an idle chat twice
 *     is one model call; the second answer says `cached: true`.
 *   - ONE in flight per chat. Two callers asking at once share the call.
 *   - RATE-LIMITED per caller (`limit` calls per rolling hour). A cache hit is
 *     free and never counts — the limit is on model calls, not on answers.
 *
 * The transcript sent is what a reader of the chat would read: what the human
 * (or a peer, or an integration) wrote, and what the agent SAID — no tool
 * payloads, no subagent internals, no thinking. Long chats keep their opening
 * ask and their most recent stretch; the middle is elided and the model is told.
 */
import type { ChatMessage, HarnessKind } from "@dispatch/shared";
import type { Store } from "../store/index.js";
import { ProviderUnavailableError, type HarnessRegistry } from "../harness/index.js";
import { accountOf, chatSubscription } from "./subscriptions.js";

/** Characters of transcript sent to the model. Head keeps the ask; tail keeps where it ended up. */
const HEAD_CHARS = 6_000;
const TAIL_CHARS = 30_000;
const HOUR = 3_600_000;

export interface ChatSummary {
  chatId: string;
  title: string;
  summary: string;
  /** The newest row the summary covers — a later row invalidates it. */
  upToRowId?: string;
  generatedAt: number;
  provider: HarnessKind;
  /** Served from the cache: no model call was made for this answer. */
  cached: boolean;
}

export type SummarizeFn = (input: { chat: { harness?: HarnessKind; subscriptionId?: string }; prompt: string }) => Promise<string>;

export interface ChatSummaryServiceOptions {
  store: Pick<Store, "getChat" | "readMessages" | "getSettings">;
  harnesses?: HarnessRegistry;
  /** Test seam / fake-SDK seam; overrides `harnesses`. */
  generate?: SummarizeFn;
  /** Model calls per caller per rolling hour. */
  limitPerHour?: number;
  now?: () => number;
}

export class SummaryRateLimitError extends Error {
  constructor(
    readonly retryAfterMs: number,
    limit: number,
  ) {
    super(`Summary limit reached (${limit} per hour) — try again in ${Math.ceil(retryAfterMs / 60_000)} min, or re-ask about a chat that has not changed (cached answers are free).`);
    this.name = "SummaryRateLimitError";
  }
}

/** The text a reader of the transcript would see for one row; empty for everything else. */
function readable(m: ChatMessage): string {
  if (m.kind === "user") {
    const who =
      m.origin === "peer"
        ? `[agent ${m.peer?.title ?? m.peer?.chatId ?? "peer"}]`
        : m.origin === "channel"
          ? `[${m.channel?.name ?? "integration"}]`
          : "[human]";
    const text = m.parts?.length
      ? m.parts.filter((p) => p.kind === "text" || p.kind === "instructions").map((p) => p.text).join("\n")
      : (m.text ?? "");
    return text.trim() ? `${who} ${text.trim()}` : "";
  }
  // Subagent chatter and tool payloads are how the agent worked, not what it said.
  if (m.kind === "assistant" && !m.parentToolUseId && m.text.trim()) return `[agent] ${m.text.trim()}`;
  return "";
}

/** The transcript as text: the opening, an elision marker, and the recent tail. */
export function summarySource(messages: ChatMessage[]): string {
  const lines = messages.map(readable).filter(Boolean);
  const all = lines.join("\n\n");
  if (all.length <= HEAD_CHARS + TAIL_CHARS) return all;
  return `${all.slice(0, HEAD_CHARS)}\n\n[… ${all.length - HEAD_CHARS - TAIL_CHARS} characters of the middle of the chat omitted …]\n\n${all.slice(-TAIL_CHARS)}`;
}

function summaryPrompt(title: string, source: string, focus?: string): string {
  return [
    `Summarize this Dispatch chat titled "${title}" for someone who has not read it.`,
    "Lead with what was asked and where it stands now (done, in progress, blocked — and on what).",
    "Then the decisions made and anything left open or waiting on a person. Name files, PRs and errors when they matter.",
    "Under 200 words. Plain prose or a short list; no preamble, no headings.",
    ...(focus ? [`The reader specifically wants to know: ${focus}`] : []),
    "Lines are tagged [human], [agent], or the name of an integration or agent that sent them.",
    "",
    "<transcript>",
    source,
    "</transcript>",
  ].join("\n");
}

export class ChatSummaryService {
  private readonly cache = new Map<string, ChatSummary & { focus?: string }>();
  private readonly inFlight = new Map<string, Promise<ChatSummary>>();
  /** Per caller: timestamps of model calls in the last hour. */
  private readonly calls = new Map<string, number[]>();
  private readonly generate: SummarizeFn;
  private readonly limit: number;
  private readonly now: () => number;

  constructor(private readonly opts: ChatSummaryServiceOptions) {
    this.limit = opts.limitPerHour ?? 30;
    this.now = opts.now ?? Date.now;
    if (opts.generate) this.generate = opts.generate;
    else if (opts.harnesses) {
      const harnesses = opts.harnesses;
      this.generate = async ({ chat, prompt }) => {
        const resolved = harnesses.resolve(chat.harness);
        if (!resolved.ok) throw new ProviderUnavailableError(resolved.unavailable);
        const settings = await opts.store.getSettings().catch(() => null);
        const account = accountOf(chatSubscription(settings, { harness: resolved.harness.kind, subscriptionId: chat.subscriptionId }));
        return resolved.harness.generateText({ prompt, purpose: "summary", maxOutput: 600, timeoutMs: 90_000, account });
      };
    } else throw new Error("ChatSummaryService requires harnesses or generate");
  }

  /**
   * `caller` is who the rate limit counts against — `channel:<token name>` for
   * an integration, `chat:<id>` for an agent.
   */
  async summarize(chatId: string, opts: { caller: string; focus?: string }): Promise<ChatSummary> {
    const chat = await this.opts.store.getChat(chatId);
    if (!chat) throw new Error(`No chat "${chatId}" exists.`);
    const messages = await this.opts.store.readMessages(chatId);
    const last = messages.at(-1)?.id;
    const focus = opts.focus?.trim() || undefined;
    const hit = this.cache.get(chatId);
    if (hit && hit.upToRowId === last && hit.focus === focus) return { ...hit, title: chat.title, cached: true };

    const key = `${chatId}\0${last ?? ""}\0${focus ?? ""}`;
    const running = this.inFlight.get(key);
    if (running) return running;

    // Answered before `charge`: no model call is made, and a bot polling a chat
    // it just created would otherwise spend its hour on "nothing yet".
    const source = summarySource(messages);
    if (!source.trim()) {
      return { chatId, title: chat.title, summary: "Nothing has been said in this chat yet.", ...(last ? { upToRowId: last } : {}), generatedAt: this.now(), provider: chat.harness ?? ("unknown" as HarnessKind), cached: false };
    }

    const refund = this.charge(opts.caller);
    const job = (async (): Promise<ChatSummary> => {
      let generated: string;
      try {
        generated = await this.generate({ chat, prompt: summaryPrompt(chat.title, source, focus) });
      } catch (err) {
        // A timeout or a provider error returned nothing — it does not count.
        refund();
        throw err;
      }
      const text = generated.trim();
      const result: ChatSummary = {
        chatId,
        title: chat.title,
        summary: text || "(the model returned an empty summary)",
        ...(last ? { upToRowId: last } : {}),
        generatedAt: this.now(),
        provider: chat.harness ?? ("unknown" as HarnessKind),
        cached: false,
      };
      this.cache.set(chatId, { ...result, ...(focus ? { focus } : {}) });
      return result;
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }

  /** Count a model call against `caller`, or refuse it. Returns the refund. */
  private charge(caller: string): () => void {
    const now = this.now();
    const recent = (this.calls.get(caller) ?? []).filter((t) => now - t < HOUR);
    if (recent.length >= this.limit) throw new SummaryRateLimitError(HOUR - (now - recent[0]!), this.limit);
    recent.push(now);
    this.calls.set(caller, recent);
    return () => {
      const list = this.calls.get(caller);
      const at = list?.indexOf(now) ?? -1;
      if (list && at >= 0) list.splice(at, 1);
    };
  }
}
