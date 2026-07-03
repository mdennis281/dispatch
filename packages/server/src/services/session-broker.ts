/**
 * SessionBroker — the CORE of claude-manager.
 *
 * Owns `Map<chatId, LiveSession>`. Each LiveSession wraps a single Agent SDK
 * `query()` in STREAMING INPUT mode (the InputChannel push/close pattern proven
 * in `spikes/streaming-input.ts`), so N chats run out-of-process and Node stays
 * responsive. Per chat we run a small state machine:
 *
 *     idle → running → awaiting-input → running → done/error
 *              ↑___________(next turn)___________|
 *
 * Responsibilities:
 *  - Feed + steer a live session (per-chat FIFO input queue, mid-run injection).
 *  - Route SDK `canUseTool` prompts to the host as `permission-request` events +
 *    a global AttentionItem, and block the tool until `resolvePermission(...)`.
 *  - Forward stream messages (assistant text/thinking, tool_use, tool_result,
 *    result) as WsServerEvents AND persist them to the Store JSONL transcript.
 *  - Map UI mode/effort → SDK permissionMode / thinking budget.
 *  - Enforce a configurable cap on concurrently-ACTIVE sessions (default 6); over
 *    the cap, new turns park in a visible `queued` state and drain in FIFO order.
 *  - Emit AttentionItems when a turn completes (idle) or the session ends (done).
 *
 * The SDK `query` function, id generator, and clock are injectable so tests can
 * script an async iterator + capture the canUseTool callback without the real
 * subprocess or network.
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  PermissionResult,
  AgentDefinition,
  McpServerConfig as SdkMcpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { nanoid } from "nanoid";
import type {
  Chat,
  Project,
  PermissionMode,
  Effort,
  ChatStatus,
  AgentActivity,
  PermissionDecision,
  PermissionRequest,
  ChatMessage,
  ImageRef,
} from "@cm/shared";
import type { Store } from "../store/index.js";
import type { EventBus } from "../bus.js";
import type { TerminalService } from "./terminal.js";
import { createManagerMcpServer } from "./mcp/manager-mcp.js";

/* ------------------------------------------------------------------ deps */

/** The subset of the SDK `query` signature the broker calls. */
export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage> | string;
  options?: Options;
}) => Query;

/** Injectable seams (all default to the real implementations). */
export interface SessionBrokerDeps {
  query?: QueryFn;
  genId?: () => string;
  now?: () => number;
}

export interface SessionBrokerOptions {
  store: Store;
  bus: EventBus;
  /** Max concurrently-active sessions (running + awaiting-input). Default 6. */
  maxActiveSessions?: number;
  /** Persistent-terminal service exposed to sessions as `mcp__manager__terminal`. */
  terminals?: TerminalService;
  deps?: SessionBrokerDeps;
}

/** Steering priority forwarded to `SDKUserMessage.priority`. */
export type MessagePriority = "now" | "next" | "later";

/** Options for a single user/steering message. */
export interface SendOptions {
  priority?: MessagePriority;
  images?: ImageRef[];
  /** Per-message effort override (also updates the chat's effort going forward). */
  effort?: Effort;
}

/** Host answer to a `permission-request`. */
export interface PermissionResolution {
  decision: PermissionDecision; // "allow" | "deny"
  /** Replace the tool input on allow. */
  updatedInput?: Record<string, unknown>;
  /** Deny reason / allow note. */
  message?: string;
}

/** Read-only view of a session for callers/tests. */
export interface SessionView {
  chatId: string;
  projectId: string;
  status: ChatStatus;
  modeId: string;
  effort: Effort;
  agentId?: string;
  sessionId?: string;
  started: boolean;
  pendingPermissionIds: string[];
}

/* -------------------------------------------------------- mode / effort maps */

/** Built-in mode-id → SDK permissionMode fallback (used when no ModeConfig). */
export const BUILTIN_MODE_PERMISSION: Record<string, PermissionMode> = {
  default: "default",
  ask: "default",
  plan: "plan",
  edit: "acceptEdits",
  acceptEdits: "acceptEdits",
  auto: "auto",
  yolo: "bypassPermissions",
  bypass: "bypassPermissions",
  bypassPermissions: "bypassPermissions",
  dontAsk: "dontAsk",
};

/** Effort → thinking-token budget (the SDK "effort" lever). */
export const EFFORT_THINKING_TOKENS: Record<Effort, number> = {
  low: 2_000,
  medium: 8_000,
  high: 16_000,
  xhigh: 32_000,
  max: 60_000,
};

/** Effort → SDK ThinkingConfig for the initial query options. */
export function effortToThinking(effort: Effort): Options["thinking"] {
  return { type: "enabled", budgetTokens: EFFORT_THINKING_TOKENS[effort] };
}

/** Max time `stop()`/`dispose()` waits for a subprocess consume loop to unwind. */
const STOP_TIMEOUT_MS = 5_000;

/* ------------------------------------------------------- internal helpers */

/** Parse `mcp__<server>__<tool>` → server id. */
function parseMcpServer(name: string): string | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice("mcp__".length);
  const i = rest.indexOf("__");
  return i >= 0 ? rest.slice(0, i) : rest;
}

/** Pick a file extension for a stored asset from its media type (inverse of
 *  {@link mediaTypeFromName}); defaults to `.png` for anything unrecognized. */
function extFromMediaType(mime: string | undefined): string {
  switch ((mime ?? "").toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/avif":
      return ".avif";
    case "image/bmp":
      return ".bmp";
    default:
      return ".png";
  }
}

/** Guess an image media type from a stored asset filename. */
function mediaTypeFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  switch (dot >= 0 ? name.slice(dot).toLowerCase() : "") {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".avif":
      return "image/avif";
    default:
      return "image/png";
  }
}

/** Best-effort "what is the tool acting on" for the working-state label. */
function deriveTarget(input: Record<string, unknown>): string | undefined {
  const fp = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof fp === "string") return fp;
  const cmd = input.command;
  if (typeof cmd === "string") return cmd.length > 48 ? `${cmd.slice(0, 48)}…` : cmd;
  return undefined;
}

/**
 * Best-effort one-line summary of an AskUserQuestion payload for the triage
 * list. The tool input isn't schema-guaranteed, so probe the common shapes
 * (`{ questions: [{ question }] }` or a flat `{ question | prompt | header }`).
 */
function questionSummary(input: Record<string, unknown>): string {
  const first =
    Array.isArray(input.questions) && input.questions.length
      ? (input.questions[0] as Record<string, unknown>)
      : input;
  const pick = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const text =
    pick(first.question) ??
    pick(first.prompt) ??
    pick(first.header) ??
    pick(first.title) ??
    pick(input.question);
  if (!text) return "Claude has a question";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** One answer within a (possibly multi-question) AskUserQuestion response. */
interface QuestionAnswerOpt {
  questionIndex?: number;
  optionId?: string;
  answer?: string;
}

function pickStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Resolve one answer's chosen value against its question's options. */
function resolveAnswerValue(
  question: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
  opt: { optionId?: string; answer?: string },
): string | undefined {
  let value = pickStr(opt.answer);
  if (!value && opt.optionId) {
    const options =
      question && Array.isArray(question.options)
        ? question.options
        : Array.isArray(input.options)
          ? input.options
          : [];
    const match = options.find(
      (o): o is Record<string, unknown> =>
        !!o &&
        typeof o === "object" &&
        ((o as Record<string, unknown>).label === opt.optionId ||
          (o as Record<string, unknown>).id === opt.optionId),
    );
    value = pickStr(match?.label) ?? pickStr(opt.optionId);
  }
  return value;
}

function questionTextOf(
  question: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): string | undefined {
  return (
    pickStr(question?.question) ??
    pickStr(question?.prompt) ??
    pickStr(input.question) ??
    pickStr(question?.header)
  );
}

/**
 * Build the `updatedInput` that answers an AskUserQuestion tool call, plus a
 * human-readable summary for the persisted permission row.
 *
 * AskUserQuestion rides the `canUseTool` channel and the chosen answer is fed
 * back to the model as the tool's ALLOW result: the CLI tool reads
 * `input.answers` — a map of question text → chosen answer string — and, when
 * an entry is absent, hands the model "The user did not answer the questions."
 * (verified live against the bundled 0.3.199 CLI runtime). A single ask carries
 * one `questions[0]`; the model can also ask MANY at once (`questions[1..]`), so
 * we map EVERY answered question's text → its chosen value, keyed by index. The
 * client sends the human-readable label(s) as `answer` (comma-joined for
 * multi-select, or free text); `optionId` is a label fallback.
 */
function buildQuestionAnswer(
  input: Record<string, unknown>,
  opts: { optionId?: string; answer?: string; answers?: QuestionAnswerOpt[] },
): { updatedInput: Record<string, unknown>; message?: string } {
  const questions = Array.isArray(input.questions)
    ? (input.questions as Record<string, unknown>[])
    : null;

  // Normalize to a list of per-question answers. The single-question shape
  // (optionId/answer, no index) targets questions[0].
  const list: QuestionAnswerOpt[] =
    opts.answers && opts.answers.length
      ? opts.answers
      : [{ questionIndex: 0, optionId: opts.optionId, answer: opts.answer }];

  const answers: Record<string, string> = {};
  const summary: string[] = [];
  for (const a of list) {
    const q = questions ? questions[a.questionIndex ?? 0] : undefined;
    const key = questionTextOf(q, input);
    const value = resolveAnswerValue(q, input, a);
    if (key && value) {
      answers[key] = value;
      const header = pickStr(q?.header);
      summary.push(header && list.length > 1 ? `${header}: ${value}` : value);
    }
  }

  return {
    updatedInput: { ...input, answers },
    message: summary.length ? summary.join(" · ") : undefined,
  };
}

/** Pull display text out of an SDKUserMessage (string content or text blocks). */
function extractUserText(msg: SDKUserMessage): string {
  const content = (msg as { message?: { content?: unknown } }).message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        !!b && typeof b === "object" && (b as { type?: string }).type === "text",
      )
      .map((b) => b.text)
      .join("");
  }
  return "";
}

/**
 * An async-iterable input channel we push user messages into over time and
 * close when the session ends. Exactly the shape the SDK consumes as `prompt`.
 */
class InputChannel implements AsyncIterable<SDKUserMessage> {
  private queued: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(msg: SDKUserMessage): void {
    const w = this.waiting.shift();
    if (w) w({ value: msg, done: false });
    else this.queued.push(msg);
  }

  /** Buffered-but-not-yet-consumed count (used to detect chained turns). */
  pending(): number {
    return this.queued.length;
  }

  close(): void {
    this.closed = true;
    let w: ((r: IteratorResult<SDKUserMessage>) => void) | undefined;
    while ((w = this.waiting.shift())) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.queued.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<SDKUserMessage>>((res) => this.waiting.push(res));
      },
    };
  }
}

interface OutboxItem {
  id: string;
  text: string;
  /** Original refs (persisted on the transcript row, kept small). */
  images?: ImageRef[];
  /** Pre-resolved SDK image sources (local asset files inlined as base64). */
  imageSources?: Record<string, unknown>[];
  priority: MessagePriority;
}

interface PendingPermission {
  resolve: (r: PermissionResult) => void;
  toolName: string;
  input: Record<string, unknown>;
  request: PermissionRequest;
  attentionId: string;
}

interface LiveSession {
  chatId: string;
  projectId: string;
  project: Project | null;
  worktreeCwd?: string;
  modeId: string;
  agentId?: string;
  effort: Effort;
  sessionId?: string;
  /** Model the SDK reported for the live session (display only). */
  model?: string;
  /** Model explicitly chosen by the user (pins new/resumed queries via options.model). */
  modelOverride?: string;
  status: ChatStatus;
  started: boolean;
  input?: InputChannel;
  query?: Query;
  abortController?: AbortController;
  runLoop?: Promise<void>;
  outbox: OutboxItem[];
  pendingPermissions: Map<string, PendingPermission>;
  /**
   * Id shared by the in-flight assistant message's token chunks AND its
   * finalized transcript row. Allocated when the message's stream begins
   * (`message_start` / first delta), consumed + cleared when its finalized
   * `assistant` row is emitted, so the client swaps the streaming buffer for
   * the persisted row in place (no duplicate).
   */
  streamAssistantId?: string;
  /** Per-session serialized transcript write chain. */
  writeChain: Promise<void>;
  turn: number;
  idleAttentionId?: string;
  stopping: boolean;
  /** One-shot resume/fork config consumed at the next query start. */
  resumeSessionId?: string;
  forkAtUuid?: string;
  fork: boolean;
}

/* =============================================================== SessionBroker */

export class SessionBroker {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly cap: number;
  private readonly terminals?: TerminalService;
  private readonly query: QueryFn;
  private readonly genId: () => string;
  private readonly now: () => number;

  private readonly sessions = new Map<string, LiveSession>();
  /** FIFO of chatIds parked in `queued` waiting for an active slot. */
  private queueOrder: string[] = [];

  constructor(opts: SessionBrokerOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.cap = Math.max(1, opts.maxActiveSessions ?? 6);
    this.terminals = opts.terminals;
    this.query = opts.deps?.query ?? (sdkQuery as unknown as QueryFn);
    this.genId = opts.deps?.genId ?? (() => nanoid());
    this.now = opts.deps?.now ?? (() => Date.now());
  }

  /* --------------------------------------------------------- public API */

  /** Register (lazily) a live session for a chat. Idempotent. */
  create(chat: Chat, project?: Project | null, worktreeCwd?: string): SessionView {
    let session = this.sessions.get(chat.id);
    if (!session) {
      session = {
        chatId: chat.id,
        projectId: chat.projectId,
        project: project ?? null,
        worktreeCwd,
        modeId: chat.modeId,
        agentId: chat.agentId,
        effort: chat.effort,
        sessionId: chat.sessionId,
        model: chat.model,
        modelOverride: chat.model,
        status: "idle",
        started: false,
        outbox: [],
        pendingPermissions: new Map(),
        writeChain: Promise.resolve(),
        turn: 0,
        stopping: false,
        fork: false,
      };
      this.sessions.set(chat.id, session);
    }
    return this.view(session);
  }

  /** Re-create a session pointing at the chat's persisted SDK session for resume. */
  resume(chat: Chat, project?: Project | null, worktreeCwd?: string): SessionView {
    this.create(chat, project, worktreeCwd);
    const session = this.sessions.get(chat.id)!;
    if (chat.sessionId) session.resumeSessionId = chat.sessionId;
    return this.view(session);
  }

  /**
   * Send a user message. Starts a turn if the session is idle (subject to the
   * active-session cap → `queued`); injects as steering if a turn is running.
   */
  async sendMessage(
    chatId: string,
    text: string,
    opts: SendOptions | MessagePriority = {},
  ): Promise<void> {
    const session = this.mustGet(chatId);
    const o: SendOptions = typeof opts === "string" ? { priority: opts } : opts;
    if (o.effort) this.applyEffort(session, o.effort);

    const steering = this.isActive(session);
    const id = this.genId();
    await this.emit(session, {
      kind: "user",
      id,
      chatId,
      ts: this.now(),
      turn: session.turn,
      sessionId: session.sessionId,
      text,
      images: o.images,
      effort: session.effort,
      steering: steering || undefined,
    });

    // Resolve any local asset images to inline SDK sources before queueing (the
    // transcript row above keeps the small relative refs; the SDK gets bytes).
    // No images → no extra await, so the text-only fast path is unchanged.
    const imageSources = o.images?.length
      ? await this.resolveImageSources(chatId, o.images)
      : undefined;

    this.resolveIdleAttention(session);
    session.outbox.push({
      id,
      text,
      images: o.images,
      imageSources,
      priority: o.priority ?? "next",
    });
    this.schedule(session);
  }

  /**
   * Turn each ImageRef into an SDK image source. `data:`/`http(s)` refs pass
   * straight through; a relative/local path is read from the chat's assets dir
   * and inlined as base64 (so an uploaded sprite is usable in send-message).
   */
  private async resolveImageSources(
    chatId: string,
    images?: ImageRef[],
  ): Promise<Record<string, unknown>[]> {
    if (!images?.length) return [];
    const out: Record<string, unknown>[] = [];
    for (const img of images) {
      const direct = this.imageSource(img);
      if (direct) {
        out.push(direct);
        continue;
      }
      try {
        const name = img.path.split(/[\\/]/).pop() ?? img.path;
        const buf = await this.store.readChatAsset(chatId, name);
        if (buf) {
          out.push({
            type: "base64",
            media_type: img.mimeType ?? mediaTypeFromName(name),
            data: buf.toString("base64"),
          });
        }
      } catch {
        /* unreadable asset → skip; the text still sends */
      }
    }
    return out;
  }

  /** Answer a permission request; resolves the blocked `canUseTool` promise. */
  resolvePermission(requestId: string, resolution: PermissionResolution): boolean {
    for (const session of this.sessions.values()) {
      const pending = session.pendingPermissions.get(requestId);
      if (!pending) continue;
      session.pendingPermissions.delete(requestId);

      const result: PermissionResult =
        resolution.decision === "allow"
          ? { behavior: "allow", updatedInput: resolution.updatedInput ?? pending.input }
          : { behavior: "deny", message: resolution.message ?? "Denied by user." };
      pending.resolve(result);

      void this.emit(session, {
        kind: "permission",
        id: this.genId(),
        chatId: session.chatId,
        ts: this.now(),
        sessionId: session.sessionId,
        requestId,
        toolName: pending.toolName,
        input: pending.input,
        decision: resolution.decision,
        displayName: pending.request.displayName,
        title: pending.request.title,
        description: pending.request.description,
        message: resolution.message,
      });
      this.bus.publish({
        type: "permission-resolved",
        chatId: session.chatId,
        requestId,
        decision: resolution.decision,
      });
      this.bus.publish({
        type: "attention-resolve",
        id: pending.attentionId,
        chatId: session.chatId,
      });

      if (session.pendingPermissions.size === 0 && session.status === "awaiting-input") {
        this.setStatus(session, "running", {
          state: resolution.decision === "allow" ? "tool" : "responding",
        });
      }
      return true;
    }
    return false;
  }

  /**
   * Answer an AskUserQuestion prompt. AskUserQuestion arrives over the same
   * `canUseTool` channel as a permission, but the answer must ride back as the
   * tool's ALLOW result with an `answers` map merged onto the original input
   * (see {@link buildQuestionAnswer}) — otherwise the CLI tool reports the
   * question as unanswered and the model can't act on the choice. Returns false
   * if no pending request matches `requestId`.
   */
  answerQuestion(
    requestId: string,
    answer: {
      optionId?: string;
      answer?: string;
      answers?: { questionIndex: number; optionId?: string; answer?: string }[];
    },
  ): boolean {
    for (const session of this.sessions.values()) {
      const pending = session.pendingPermissions.get(requestId);
      if (!pending) continue;
      const { updatedInput, message } = buildQuestionAnswer(pending.input, answer);
      return this.resolvePermission(requestId, {
        decision: "allow",
        updatedInput,
        message: message ?? answer.answer,
      });
    }
    return false;
  }

  /** Interrupt the running turn (streaming-input only). */
  async interrupt(chatId: string): Promise<boolean> {
    const session = this.sessions.get(chatId);
    if (!session?.query) return false;
    try {
      await session.query.interrupt();
      // Interrupting abandons any tool blocked on a permission answer; clear the
      // pending prompts (+ their cards / attention items) so they don't strand.
      this.drainPendingPermissions(session, "Interrupted.");
      this.bus.publish({ type: "notice", chatId, level: "info", text: "Interrupted." });
      return true;
    } catch (err) {
      this.bus.publish({
        type: "error",
        chatId,
        message: "interrupt failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Switch the chat's mode; applies live via `setPermissionMode` if running. */
  async setMode(chatId: string, modeId: string): Promise<PermissionMode> {
    const session = this.mustGet(chatId);
    session.modeId = modeId;
    const mode = await this.resolvePermissionMode(modeId);
    if (session.query) {
      try {
        await session.query.setPermissionMode(mode);
      } catch (err) {
        this.bus.publish({
          type: "error",
          chatId,
          message: "setMode failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    void this.patchChat(chatId, { modeId });
    return mode;
  }

  /** Set reasoning effort; applies live via `setMaxThinkingTokens` if running. */
  async setEffort(chatId: string, effort: Effort): Promise<void> {
    const session = this.mustGet(chatId);
    this.applyEffort(session, effort);
    void this.patchChat(chatId, { effort });
  }

  /** Switch the active agent (applies to the next turn / restart). */
  async setAgent(chatId: string, agentId: string | null): Promise<void> {
    const session = this.mustGet(chatId);
    session.agentId = agentId ?? undefined;
    void this.patchChat(chatId, { agentId: agentId ?? undefined });
  }

  /**
   * Switch the model backing the chat. Applies live via `Query.setModel` when a
   * turn is running, pins new/resumed queries via `options.model`, and persists
   * `chat.model` (emitting `chat-update`). Passing an empty string clears the
   * override, reverting to the SDK/subscription default on the next query.
   */
  async setModel(chatId: string, model: string): Promise<void> {
    const session = this.mustGet(chatId);
    const next = model.trim() || undefined;
    session.modelOverride = next;
    session.model = next; // reflect the choice on subsequent transcript rows
    if (session.query) {
      try {
        await session.query.setModel(next);
      } catch (err) {
        this.bus.publish({
          type: "error",
          chatId,
          message: "setModel failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    void this.patchChat(chatId, { model: next });
  }

  /** Stop the live subprocess (tree-kill via abort) but keep the chat record. */
  async stop(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) return;
    // Already terminal — nothing to tear down. Never re-run onDone (that would
    // emit a duplicate "Session ended" attention item, e.g. from dispose()).
    if (session.status === "done" || session.status === "error") {
      this.queueOrder = this.queueOrder.filter((x) => x !== chatId);
      return;
    }
    this.drainPendingPermissions(session, "Session stopped.");
    session.outbox = [];
    this.queueOrder = this.queueOrder.filter((x) => x !== chatId);

    if (session.started && session.input) {
      session.stopping = true;
      try {
        session.input.close();
      } catch {
        /* ignore */
      }
      try {
        session.abortController?.abort();
      } catch {
        /* ignore */
      }
      // Wait for the consume loop to unwind so onDone fires (status/attention
      // events settle) BEFORE we return — dispose() then never clears the map
      // while a subprocess is still emitting against a removed session.
      await this.awaitLoop(session.runLoop, STOP_TIMEOUT_MS);
    } else {
      this.onDone(session);
    }
  }

  /**
   * Fork the SDK session at a past message uuid (rollback). Ends the current
   * live query if any and arms a forked start for the next `sendMessage`.
   */
  async fork(chatId: string, atMessageUuid: string): Promise<SessionView | null> {
    const session = this.sessions.get(chatId);
    if (!session) return null;
    // Abandon any in-flight permission prompt (+ its card / attention item); the
    // forked turn starts fresh, so a stranded "allow?" would never resolve.
    this.drainPendingPermissions(session, "Session forked.");
    if (session.started && session.input) {
      session.stopping = true;
      try {
        session.input.close();
      } catch {
        /* ignore */
      }
      try {
        session.abortController?.abort();
      } catch {
        /* ignore */
      }
    }
    session.started = false;
    session.query = undefined;
    session.input = undefined;
    session.resumeSessionId = session.sessionId;
    session.forkAtUuid = atMessageUuid;
    session.fork = true;
    session.status = "idle";
    return this.view(session);
  }

  /**
   * Forget a session entirely (the chat was DELETED). Unlike `stop()` — which
   * tears the subprocess down but keeps the entry so a worktree rebind / resume
   * can reuse it — `drop()` removes it from the map so a create→delete cycle
   * can't leak `LiveSession` objects. Call AFTER `stop()` has settled.
   */
  drop(chatId: string): boolean {
    this.queueOrder = this.queueOrder.filter((x) => x !== chatId);
    // Tear down the chat's persistent shells alongside its session — a deleted
    // chat must not leak live powershell processes.
    this.terminals?.killChat(chatId);
    return this.sessions.delete(chatId);
  }

  /* ------------------------------------------------------ introspection */

  has(chatId: string): boolean {
    return this.sessions.has(chatId);
  }

  getStatus(chatId: string): ChatStatus | undefined {
    return this.sessions.get(chatId)?.status;
  }

  getSession(chatId: string): SessionView | undefined {
    const s = this.sessions.get(chatId);
    return s ? this.view(s) : undefined;
  }

  list(): SessionView[] {
    return [...this.sessions.values()].map((s) => this.view(s));
  }

  /**
   * Every still-open permission request across all live sessions. A permission
   * card is synthesized client-side from the transient `permission-request`
   * event and is only persisted once resolved, so a (re)connecting client
   * re-materializes its open cards from this snapshot — otherwise a reconnect
   * mid-tool leaves a badge whose card is gone and the tool unanswerable.
   */
  pendingPermissionSnapshot(): PermissionRequest[] {
    const out: PermissionRequest[] = [];
    for (const session of this.sessions.values()) {
      for (const p of session.pendingPermissions.values()) out.push(p.request);
    }
    return out;
  }

  /** Count of sessions holding an active slot (running or awaiting-input). */
  activeCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (this.isActive(s)) n += 1;
    return n;
  }

  /** Resolve when a chat reaches `status` via a future event (test helper). */
  waitFor(chatId: string, status: ChatStatus, timeoutMs = 2_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const off = this.bus.on("chat-status", (e) => {
        if (e.chatId === chatId && e.status === status) {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timeout waiting for ${chatId} → ${status}`));
      }, timeoutMs);
    });
  }

  /** Tear down every session (process teardown). */
  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
    this.sessions.clear();
    this.queueOrder = [];
  }

  /* -------------------------------------------------------- scheduling */

  private isActive(s: LiveSession): boolean {
    return s.status === "running" || s.status === "awaiting-input";
  }

  private schedule(session: LiveSession): void {
    // A turn is already active → inject the buffered message(s) as steering.
    if (session.started && this.isActive(session)) {
      this.flushOutbox(session);
      return;
    }
    // Otherwise this message must START a turn → needs a free active slot.
    if (this.activeCount() < this.cap) {
      this.startTurn(session);
    } else {
      if (!this.queueOrder.includes(session.chatId)) this.queueOrder.push(session.chatId);
      this.setStatus(session, "queued");
    }
  }

  private startTurn(session: LiveSession): void {
    this.queueOrder = this.queueOrder.filter((id) => id !== session.chatId);
    if (!session.started) {
      // Lazy-start the SDK subprocess. Sets input/started synchronously before
      // its first await, so concurrent steering pushes land safely.
      void this.startQuery(session);
    } else {
      // Alive but idle → begin a fresh turn on the existing subprocess.
      this.flushOutbox(session);
    }
    this.setStatus(session, "running", { state: "thinking", label: "thinking…" });
  }

  private async startQuery(session: LiveSession): Promise<void> {
    session.input = new InputChannel();
    session.abortController = new AbortController();
    session.started = true;
    let options: Options;
    try {
      options = await this.buildOptions(session);
    } catch (err) {
      this.onError(session, err);
      return;
    }
    // Consume one-shot resume/fork config.
    session.resumeSessionId = undefined;
    session.forkAtUuid = undefined;
    session.fork = false;

    try {
      session.query = this.query({ prompt: session.input, options });
    } catch (err) {
      this.onError(session, err);
      return;
    }
    this.flushOutbox(session);
    session.runLoop = this.consume(session);
  }

  private flushOutbox(session: LiveSession): void {
    if (!session.input) return;
    for (const item of session.outbox) session.input.push(this.toSdkUserMessage(item));
    session.outbox = [];
  }

  private pump(): void {
    while (this.activeCount() < this.cap && this.queueOrder.length > 0) {
      const id = this.queueOrder[0]!;
      const session = this.sessions.get(id);
      if (!session || session.status !== "queued") {
        this.queueOrder.shift();
        continue;
      }
      this.queueOrder.shift();
      this.startTurn(session);
    }
  }

  /* ---------------------------------------------------------- consume */

  private async consume(session: LiveSession): Promise<void> {
    const q = session.query;
    if (!q) return;
    try {
      for await (const msg of q) {
        await this.handleMessage(session, msg);
      }
      this.onDone(session);
    } catch (err) {
      this.onError(session, err);
    }
  }

  private async handleMessage(session: LiveSession, raw: SDKMessage): Promise<void> {
    // The SDK message union is vast; access fields pragmatically (spike pattern).
    const m = raw as unknown as Record<string, unknown> & { type: string };
    switch (m.type) {
      case "system": {
        const subtype = String((m as { subtype?: unknown }).subtype ?? "system");
        if (subtype === "init") {
          const sid = (m as { session_id?: string }).session_id;
          if (sid && sid !== session.sessionId) {
            session.sessionId = sid;
            void this.patchChat(session.chatId, { sessionId: sid });
          }
          session.model = (m as { model?: string }).model;
          await this.emit(session, {
            kind: "system",
            id: this.genId(),
            chatId: session.chatId,
            ts: this.now(),
            sessionId: session.sessionId,
            subtype: "init",
            data: {
              model: (m as { model?: unknown }).model,
              permissionMode: (m as { permissionMode?: unknown }).permissionMode,
              tools: (m as { tools?: unknown }).tools,
              mcpServers: (m as { mcp_servers?: unknown }).mcp_servers,
            },
          });
        }
        return;
      }
      case "assistant": {
        const blocks = this.contentBlocks(m);
        let text = "";
        let thinking = "";
        const toolBlocks: Record<string, unknown>[] = [];
        for (const b of blocks) {
          const t = b.type;
          if (t === "text") text += String(b.text ?? "");
          else if (t === "thinking") thinking += String(b.thinking ?? "");
          else if (t === "tool_use") toolBlocks.push(b);
        }
        // The finalized row reuses the id its streamed chunks carried (allocated
        // at `message_start`); a tool-only message still consumes + clears it so
        // the id never leaks into the next assistant message.
        const assistantId = session.streamAssistantId ?? this.genId();
        session.streamAssistantId = undefined;
        if (text || thinking) {
          this.setStatus(session, "running", { state: "responding", label: "responding" });
          await this.emit(session, {
            kind: "assistant",
            id: assistantId,
            chatId: session.chatId,
            ts: this.now(),
            turn: session.turn,
            sessionId: session.sessionId,
            text,
            thinking: thinking || undefined,
            model: session.model,
            uuid: (m as { uuid?: string }).uuid,
            subagentType: (m as { subagent_type?: string }).subagent_type,
          });
        }
        for (const tb of toolBlocks) {
          const name = String(tb.name ?? "");
          const input = (tb.input ?? {}) as Record<string, unknown>;
          // AskUserQuestion is surfaced as an interactive QuestionCard via the
          // `canUseTool` → permission-request path; suppress the redundant
          // generic tool_use row so the transcript shows one canonical question
          // surface (and no orphan "running AskUserQuestion" tool card).
          if (name === "AskUserQuestion") continue;
          this.setStatus(session, "running", {
            state: "tool",
            label: `running ${name}`,
            toolName: name,
            target: deriveTarget(input),
          });
          await this.emit(session, {
            kind: "tool_use",
            id: this.genId(),
            chatId: session.chatId,
            ts: this.now(),
            turn: session.turn,
            sessionId: session.sessionId,
            toolUseId: String(tb.id ?? this.genId()),
            name,
            input,
            server: parseMcpServer(name),
            parentToolUseId: ((m as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null),
            uuid: (m as { uuid?: string }).uuid,
          });
        }
        return;
      }
      case "user": {
        // Surface tool_result blocks; ignore plain echoes of our own input.
        for (const b of this.contentBlocks(m)) {
          if (b.type !== "tool_result") continue;
          // Persist any image content the tool returned (e.g. a Claude-in-Chrome
          // screenshot) to the chat's assets dir and hand the client small
          // ImageRefs; the enriched `tool_result` row IS the render event (fanned
          // out as `chat-message`, drawn inline in the ToolCallCard).
          const { images, content } = await this.persistContentImages(session, b.content);
          await this.emit(session, {
            kind: "tool_result",
            id: this.genId(),
            chatId: session.chatId,
            ts: this.now(),
            turn: session.turn,
            sessionId: session.sessionId,
            toolUseId: String(b.tool_use_id ?? ""),
            ok: !b.is_error,
            isError: b.is_error ? true : undefined,
            content,
            images: images.length ? images : undefined,
          });
        }
        return;
      }
      case "stream_event": {
        // Token-level partials (only with includePartialMessages). Forward text /
        // thinking deltas as `message-chunk` so the client types out the reply,
        // then supersedes the buffer with the finalized `assistant` row (same id).
        const event = (m as { event?: Record<string, unknown> }).event;
        if (!event || typeof event !== "object") return;
        const et = String((event as { type?: unknown }).type ?? "");
        if (et === "message_start") {
          // A new assistant message begins its token stream → allocate the id its
          // chunks and its finalized row will share.
          session.streamAssistantId = this.genId();
          return;
        }
        if (et !== "content_block_delta") return;
        const delta = (event as { delta?: Record<string, unknown> }).delta;
        const dt = String((delta as { type?: unknown } | undefined)?.type ?? "");
        let channel: "text" | "thinking" | undefined;
        let piece = "";
        if (dt === "text_delta") {
          channel = "text";
          piece = String((delta as { text?: unknown }).text ?? "");
        } else if (dt === "thinking_delta") {
          channel = "thinking";
          piece = String((delta as { thinking?: unknown }).thinking ?? "");
        }
        if (!channel || !piece) return;
        // Defensive: if `message_start` was missed, allocate on the first delta so
        // the id still correlates with the finalized row.
        if (!session.streamAssistantId) session.streamAssistantId = this.genId();
        this.bus.publish({
          type: "message-chunk",
          chatId: session.chatId,
          messageId: session.streamAssistantId,
          delta: piece,
          channel,
        });
        return;
      }
      case "result": {
        await this.emit(session, {
          kind: "result",
          id: this.genId(),
          chatId: session.chatId,
          ts: this.now(),
          turn: session.turn,
          sessionId: session.sessionId,
          subtype: String((m as { subtype?: unknown }).subtype ?? "success"),
          isError: Boolean((m as { is_error?: unknown }).is_error),
          numTurns: (m as { num_turns?: number }).num_turns,
          durationMs: (m as { duration_ms?: number }).duration_ms,
          result:
            typeof (m as { result?: unknown }).result === "string"
              ? ((m as { result?: unknown }).result as string)
              : undefined,
          usage: (m as { usage?: unknown }).usage,
          costUsd: (m as { total_cost_usd?: number }).total_cost_usd,
        });
        session.turn += 1;
        // Chained turn buffered? Stay running; otherwise the turn is complete.
        if (session.input && session.input.pending() > 0) {
          this.setStatus(session, "running", { state: "thinking" });
        } else {
          this.onTurnEnd(session);
        }
        return;
      }
      default:
        return;
    }
  }

  private contentBlocks(m: Record<string, unknown>): Record<string, unknown>[] {
    const content = (m.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return [];
    return content.filter(
      (b): b is Record<string, unknown> => !!b && typeof b === "object",
    );
  }

  /**
   * Scan a tool_result's `content` for image blocks the agent received, persist
   * any inline base64 image to the chat's assets dir, and return the resulting
   * ImageRefs plus a sanitized copy of the content. The bulky base64 payload is
   * stripped from the persisted block (replaced with a lightweight `asset` ref)
   * so the JSONL transcript stays small and the text/JSON result view never
   * dumps megabytes. A remote `url` image source becomes an ImageRef pointing at
   * the URL and passes through untouched. Kept general: ANY MCP that returns
   * image content blocks (Claude-in-Chrome screenshots and beyond) renders
   * inline with no per-tool wiring.
   */
  private async persistContentImages(
    session: LiveSession,
    content: unknown,
  ): Promise<{ images: ImageRef[]; content: unknown }> {
    if (!Array.isArray(content)) return { images: [], content };
    const images: ImageRef[] = [];
    const out: unknown[] = [];
    for (const raw of content) {
      const block = raw as Record<string, unknown> | null;
      if (!block || typeof block !== "object" || block.type !== "image") {
        out.push(raw);
        continue;
      }
      const source = block.source as Record<string, unknown> | undefined;
      const srcType = source ? String(source.type ?? "") : "";
      if (srcType === "base64" && typeof source?.data === "string") {
        const mime =
          typeof source.media_type === "string" ? source.media_type : "image/png";
        try {
          const name = `${this.genId()}${extFromMediaType(mime)}`;
          const buf = Buffer.from(source.data, "base64");
          const relPath = await this.store.writeChatAsset(session.chatId, name, buf);
          images.push({ id: this.genId(), path: relPath, mimeType: mime });
          out.push({ type: "image", media_type: mime, asset: relPath });
        } catch {
          // Persist failed (bad base64 / disk) → keep the raw block, no ref.
          out.push(raw);
        }
      } else if (srcType === "url" && typeof source?.url === "string") {
        images.push({
          id: this.genId(),
          path: source.url,
          mimeType:
            typeof source.media_type === "string" ? source.media_type : undefined,
        });
        out.push(raw);
      } else {
        out.push(raw);
      }
    }
    return { images, content: out };
  }

  /* --------------------------------------------------------- permission */

  private handlePermission(
    session: LiveSession,
    toolName: string,
    input: Record<string, unknown>,
    opts: {
      title?: string;
      displayName?: string;
      description?: string;
    },
  ): Promise<PermissionResult> {
    const requestId = this.genId();
    const request: PermissionRequest = {
      id: requestId,
      chatId: session.chatId,
      toolName,
      input,
      displayName: opts?.displayName,
      title: opts?.title,
      description: opts?.description,
      createdAt: this.now(),
    };
    const attentionId = `att-perm-${requestId}`;

    // AskUserQuestion rides the same `canUseTool` channel but is a *question*,
    // not a scary permission gate — categorize it so the triage list shows the
    // question tone/label and the dedicated `question` branch is reachable.
    const isQuestion = toolName === "AskUserQuestion";
    const summary = isQuestion
      ? questionSummary(input)
      : (opts?.title ?? `Permission: ${toolName}`);

    this.setStatus(session, "awaiting-input", {
      state: "awaiting",
      label: isQuestion ? summary : (opts?.title ?? `Allow ${toolName}?`),
      toolName,
    });
    this.bus.publish({ type: "permission-request", chatId: session.chatId, request });
    this.bus.publish({
      type: "attention-add",
      item: {
        id: attentionId,
        chatId: session.chatId,
        kind: isQuestion ? "question" : "permission",
        summary,
        projectId: session.projectId || undefined,
        permissionRequestId: requestId,
        createdAt: this.now(),
      },
    });

    return new Promise<PermissionResult>((resolve) => {
      session.pendingPermissions.set(requestId, {
        resolve,
        toolName,
        input,
        request,
        attentionId,
      });
    });
  }

  /* ----------------------------------------------------- state helpers */

  private setStatus(session: LiveSession, status: ChatStatus, activity?: AgentActivity): void {
    session.status = status;
    this.bus.publish({ type: "chat-status", chatId: session.chatId, status, activity });
  }

  private onTurnEnd(session: LiveSession): void {
    this.setStatus(session, "idle", { state: "idle" });
    const id = `att-idle-${session.chatId}-${this.genId()}`;
    session.idleAttentionId = id;
    this.bus.publish({
      type: "attention-add",
      item: {
        id,
        chatId: session.chatId,
        kind: "idle",
        summary: "Turn complete — awaiting your input",
        projectId: session.projectId || undefined,
        createdAt: this.now(),
      },
    });
    this.pump();
  }

  private onDone(session: LiveSession): void {
    // Idempotent: a session that already settled must not emit a second "done".
    if (session.status === "done" || session.status === "error") return;
    session.started = false;
    session.query = undefined;
    session.input = undefined;
    session.stopping = false;
    this.resolveIdleAttention(session);
    this.setStatus(session, "done", { state: "idle" });
    this.bus.publish({
      type: "attention-add",
      item: {
        id: `att-done-${session.chatId}-${this.genId()}`,
        chatId: session.chatId,
        kind: "done",
        summary: "Session ended",
        projectId: session.projectId || undefined,
        createdAt: this.now(),
      },
    });
    this.queueOrder = this.queueOrder.filter((x) => x !== session.chatId);
    this.pump();
  }

  private onError(session: LiveSession, err: unknown): void {
    session.started = false;
    session.query = undefined;
    session.input = undefined;
    // A crash after a completed turn leaves a live "Turn complete" item; clear it.
    this.resolveIdleAttention(session);
    this.drainPendingPermissions(session, "Session ended.");

    if (session.stopping) {
      // Deliberate stop/fork abort — settle as a clean done.
      this.onDone(session);
      return;
    }
    this.setStatus(session, "error");
    const message = err instanceof Error ? err.message : String(err);
    this.bus.publish({ type: "error", chatId: session.chatId, message });
    void this.emit(session, {
      kind: "notice",
      id: this.genId(),
      chatId: session.chatId,
      ts: this.now(),
      level: "error",
      text: `Session error: ${message}`,
    });
    this.queueOrder = this.queueOrder.filter((x) => x !== session.chatId);
    this.pump();
  }

  private resolveIdleAttention(session: LiveSession): void {
    if (!session.idleAttentionId) return;
    this.bus.publish({
      type: "attention-resolve",
      id: session.idleAttentionId,
      chatId: session.chatId,
    });
    session.idleAttentionId = undefined;
  }

  /**
   * Deny + clear every pending permission on a teardown path (stop/fork/error/
   * interrupt). Unlike the normal `resolvePermission`, these are forced, so we
   * also publish the `permission-resolved` + `attention-resolve` UI events that
   * unstick the client's permission card and clear the global Attention Queue.
   */
  private drainPendingPermissions(session: LiveSession, message: string): void {
    for (const [requestId, p] of session.pendingPermissions) {
      p.resolve({ behavior: "deny", message });
      this.bus.publish({
        type: "permission-resolved",
        chatId: session.chatId,
        requestId,
        decision: "deny",
      });
      this.bus.publish({
        type: "attention-resolve",
        id: p.attentionId,
        chatId: session.chatId,
      });
    }
    session.pendingPermissions.clear();
  }

  /** Await a consume loop to unwind, capped by `timeoutMs` (never rejects). */
  private async awaitLoop(loop: Promise<void> | undefined, timeoutMs: number): Promise<void> {
    if (!loop) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((r) => {
      timer = setTimeout(r, timeoutMs);
    });
    try {
      await Promise.race([loop.catch(() => {}), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private applyEffort(session: LiveSession, effort: Effort): void {
    session.effort = effort;
    if (session.query) {
      void session.query
        .setMaxThinkingTokens(EFFORT_THINKING_TOKENS[effort])
        .catch((err: unknown) => {
          this.bus.publish({
            type: "error",
            chatId: session.chatId,
            message: "setEffort failed",
            detail: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }

  /* ---------------------------------------------------------- options */

  private async resolvePermissionMode(modeId: string): Promise<PermissionMode> {
    const mode = await this.store.getMode(modeId).catch(() => null);
    if (mode) return mode.permissionMode;
    return BUILTIN_MODE_PERMISSION[modeId] ?? "default";
  }

  private async buildOptions(session: LiveSession): Promise<Options> {
    const permissionMode = await this.resolvePermissionMode(session.modeId);
    const project =
      session.project ??
      (session.projectId
        ? await this.store.getProject(session.projectId).catch(() => null)
        : null);
    const cwd = session.worktreeCwd ?? project?.repoPath;

    const options: Options = {
      permissionMode,
      // Launch every session with the skip-permissions capability so the "Bypass"
      // posture is switchable mid-session. The SDK rejects
      // setPermissionMode("bypassPermissions") unless the session launched with this
      // flag. It only ENABLES bypass to be selected (user-controlled); canUseTool
      // still gates every other mode.
      allowDangerouslySkipPermissions: true,
      canUseTool: (name, input, o) => this.handlePermission(session, name, input, o),
      thinking: effortToThinking(session.effort),
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      abortController: session.abortController,
    };
    if (cwd) options.cwd = cwd;
    // A user-chosen model pins the query; unset falls back to the SDK default.
    // (Kept separate from `session.model`, which mirrors the model the SDK
    // *reports* at init and would otherwise feed the "[1m]" display id back in.)
    if (session.modelOverride) options.model = session.modelOverride;

    const mode = await this.store.getMode(session.modeId).catch(() => null);
    const agent = session.agentId
      ? await this.store.getAgent(session.agentId).catch(() => null)
      : null;

    const appends: string[] = [];
    if (mode?.instructions) appends.push(mode.instructions);

    if (agent) {
      const def: AgentDefinition = {
        description: agent.name || "Custom agent",
        prompt: agent.instructions,
        tools: agent.allowedTools,
        disallowedTools: agent.disallowedTools,
        model: agent.model,
        permissionMode: agent.permissionMode,
        effort: session.effort,
      };
      options.agents = { [agent.id]: def };
      options.agent = agent.id;
    }
    if (appends.length) {
      options.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: appends.join("\n\n"),
      };
    }
    // Register the in-process "manager" MCP on EVERY session so the agent can
    // self-pace (mcp__manager__wait / __wait_for_chat) and drive persistent
    // named shells (mcp__manager__terminal). Merge it alongside any
    // project-configured MCP servers; the session's abort signal cancels any
    // in-flight wait on stop/fork.
    const terminals = this.terminals;
    options.mcpServers = {
      ...(project?.mcpServers as unknown as Record<string, SdkMcpServerConfig> | undefined),
      manager: createManagerMcpServer({
        chatId: session.chatId,
        bus: this.bus,
        broker: this,
        // Bind the terminal runner to this session's chat + default cwd (its
        // worktree, else the repo root), so the agent just picks a name.
        terminals: terminals
          ? {
              run: (a) =>
                terminals.run({ chatId: session.chatId, cwd, ...a }),
            }
          : undefined,
        signal: session.abortController?.signal,
        now: this.now,
      }),
    };
    if (session.fork) {
      if (session.resumeSessionId) options.resume = session.resumeSessionId;
      if (session.forkAtUuid) options.resumeSessionAt = session.forkAtUuid;
      options.forkSession = true;
    } else if (session.resumeSessionId) {
      options.resume = session.resumeSessionId;
    }
    return options;
  }

  /* ------------------------------------------------------ persistence */

  private emit(session: LiveSession, msg: ChatMessage): Promise<void> {
    session.writeChain = session.writeChain
      .catch(() => {})
      .then(async () => {
        try {
          const saved = await this.store.appendMessage(msg);
          this.bus.publish({ type: "chat-message", chatId: saved.chatId, message: saved });
        } catch (err) {
          this.bus.publish({
            type: "error",
            chatId: session.chatId,
            message: "failed to persist message",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return session.writeChain;
  }

  private async patchChat(chatId: string, patch: Partial<Chat>): Promise<void> {
    try {
      const chat = await this.store.getChat(chatId);
      if (!chat) return;
      const updated = { ...chat, ...patch, updatedAt: this.now() };
      const saved = await this.store.saveChat(updated);
      this.bus.publish({ type: "chat-update", chat: saved });
    } catch (err) {
      this.bus.publish({
        type: "error",
        chatId,
        message: "failed to update chat",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /* ---------------------------------------------------------- helpers */

  private toSdkUserMessage(item: OutboxItem): SDKUserMessage {
    let content: unknown = item.text;
    const sources =
      item.imageSources && item.imageSources.length > 0
        ? item.imageSources
        : (item.images ?? [])
            .map((img) => this.imageSource(img))
            .filter((s): s is Record<string, unknown> => !!s);
    if (sources.length > 0) {
      const blocks: unknown[] = [];
      if (item.text) blocks.push({ type: "text", text: item.text });
      for (const source of sources) blocks.push({ type: "image", source });
      content = blocks;
    }
    return {
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content },
      priority: item.priority,
    } as unknown as SDKUserMessage;
  }

  private imageSource(img: ImageRef): Record<string, unknown> | undefined {
    if (img.path.startsWith("http://") || img.path.startsWith("https://")) {
      return { type: "url", url: img.path };
    }
    const dataMatch = /^data:([^;]+);base64,(.*)$/.exec(img.path);
    if (dataMatch) {
      return { type: "base64", media_type: dataMatch[1], data: dataMatch[2] };
    }
    // Local file paths are inlined by a higher layer; skip best-effort here.
    return undefined;
  }

  private mustGet(chatId: string): LiveSession {
    const session = this.sessions.get(chatId);
    if (!session) throw new Error(`No live session for chat ${chatId}`);
    return session;
  }

  private view(s: LiveSession): SessionView {
    return {
      chatId: s.chatId,
      projectId: s.projectId,
      status: s.status,
      modeId: s.modeId,
      effort: s.effort,
      agentId: s.agentId,
      sessionId: s.sessionId,
      started: s.started,
      pendingPermissionIds: [...s.pendingPermissions.keys()],
    };
  }
}
