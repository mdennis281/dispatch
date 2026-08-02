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
  AgentConfig,
  ModeConfig,
  McpServerConfig,
  SkillConfig,
  ContextUsage,
} from "@cm/shared";
import type { Store } from "../store/index.js";
import type { EventBus } from "../bus.js";
import type { TerminalService } from "./terminal.js";
import type { MemoryService } from "./memory.js";
import type { GitHubService } from "./github.js";
import type { RunnerService } from "./runner.js";
import type { WorktreeService } from "./worktree.js";
import { createManagerMcpServer, type ManagerMcpGitHub } from "./mcp/manager-mcp.js";
import { createMcpConfigEditor } from "./mcp/mcp-config-editor.js";
import { materializeSkills, cleanupMaterializedSkills } from "./skill-materializer.js";
import { bundledSkills } from "./bundled-skills.js";

/**
 * The always-injected "prefer the manager tools" directive. Lists only the
 * `mcp__manager__*` tools THIS session actually has (gated the same way the MCP
 * server offers them) and tells the agent to reach for them instead of
 * hand-rolling shell equivalents — the recurring failure mode where an agent
 * re-implements `watch_pr` as a `gh` sleep loop or a background Monitor task.
 */
export function buildManagerToolsDirective(caps: {
  github: boolean;
  terminals: boolean;
  memory: boolean;
  runner: boolean;
  mcpConfig?: boolean;
}): string {
  const lines = [
    "# Manager tools — prefer these over improvising",
    "",
    "You run inside Claude Manager, which gives you first-class `mcp__manager__*` " +
      "tools. Prefer them over hand-rolled shell equivalents: they are cheaper, they " +
      "cancel cleanly when the chat is stopped, and they surface live status in the UI.",
    "",
    "- `mcp__manager__wait` — pause yourself for a set time (e.g. let a build settle) " +
      "instead of a `sleep` loop.",
    "- `mcp__manager__wait_for_chat` — block until another chat is at rest, instead of polling it.",
    "- `mcp__manager__context_usage` — check how full your own context window is " +
      "(tokens, window size, percent, per-category breakdown) instead of guessing.",
    "- `mcp__manager__compact_context` — compact your own context in place when it's " +
      "filling up (past ~80%) and you have more work to do; the session continues " +
      "from a summarized, smaller window.",
  ];
  if (caps.github) {
    lines.push(
      "- `mcp__manager__watch_pr` — wait on AND react to a GitHub PR. It returns the " +
        "instant a CI check fails, a new review comment/thread appears, or the PR " +
        "merges/closes. Call it in a loop: fix what it reports, then call it again, " +
        "until it returns `done:true`. **Never** hand-roll `gh pr view` / `gh pr checks` " +
        "polling loops or a background Bash/Monitor task to watch a PR — `watch_pr` is " +
        "the supported way and, unlike a one-shot loop, keeps surfacing each NEW round " +
        "of review comments so you don't stop watching after the first fix.",
    );
  }
  if (caps.terminals) {
    lines.push(
      "- `mcp__manager__terminal` — a NAMED, persistent shell (cwd + env survive between " +
        "calls) for multi-step command sequences, instead of re-`cd`-ing in Bash each time.",
    );
  }
  if (caps.memory) {
    lines.push(
      "- `mcp__manager__remember` / `recall` / `forget` — durable project memory that " +
        "carries facts across chats; record anything a future session would need re-told.",
    );
  }
  if (caps.runner) {
    lines.push(
      "- `mcp__manager__run_subapp` — launch this project's app and get a live localhost " +
        "URL to actually SEE your change, instead of asking the user to run it.",
    );
  }
  if (caps.mcpConfig) {
    lines.push(
      "- `mcp__manager__mcp_list` / `mcp_add` / `mcp_remove` — read and edit the MCP servers " +
        "configured for this project.",
    );
    // The routing hint. An agent asked to "install the Linear MCP" will otherwise
    // reach for `.mcp.json` or `claude mcp add` from memory — neither of which
    // this harness reads. Naming the trigger conditions explicitly is what makes
    // the skill fire before the wrong file gets written, not after.
    lines.push(
      "",
      "## Setting up MCP servers",
      "",
      "The moment the conversation turns to MCP — installing or adding a server, connecting a " +
        "tool integration, a server that won't connect or whose tools aren't appearing, or " +
        "writing a new MCP server — **load the `mcp-setup` skill first**. It has this harness's " +
        "actual procedure, and the defaults you'd reach for otherwise are wrong here.",
      "",
      "The short version, so you don't get it wrong before the skill loads: this project's MCP " +
        "servers live in `.claude-manager/project.yaml`, edited via `mcp__manager__mcp_add` or " +
        "the `cm mcp add` CLI. **Never** hand-edit `project.yaml`, and never write `.mcp.json`, " +
        "`~/.claude.json`, or `.claude/settings.json` to configure a server — the manager does " +
        "not read those. Secrets go in as `${VAR}` placeholders, never literal keys: the file " +
        "is committed.",
    );
  }
  return lines.join("\n");
}

/**
 * Adapt a {@link GitHubService} into the narrow {@link ManagerMcpGitHub} surface
 * the manager MCP's `watch_pr` tool needs, bound to one session's `cwd`.
 * `prMergeState` lets `gh` auto-detect the repo from cwd; `prChecks` and
 * `reviewThreads` require an explicit `owner/name`, so we resolve it from cwd
 * lazily and cache the promise (a per-session one-shot). Any resolve/gh failure
 * on checks/threads degrades to `null` — the watcher treats that as "nothing new
 * this poll" rather than aborting. An explicit `repo` override always wins.
 */
function makeGithubBinding(github: GitHubService, cwd: string | undefined): ManagerMcpGitHub {
  let repoP: Promise<string | null> | undefined;
  const repoFor = async (override?: string): Promise<string | null> => {
    if (override) return override;
    if (!cwd) return null; // no launch dir → can't auto-resolve the repo
    return (repoP ??= github.resolveRepo(cwd).catch(() => null));
  };
  return {
    prMergeState: (n, repo) => github.prMergeState(n, { repo, cwd }),
    prChecks: async (n, repo) => {
      const r = await repoFor(repo);
      return r ? github.prChecks(r, n).catch(() => null) : null;
    },
    reviewThreads: async (n, repo) => {
      const r = await repoFor(repo);
      return r ? github.reviewThreads(r, n).catch(() => null) : null;
    },
  };
}

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

/**
 * The slice of {@link ProjectConfigService} the broker consumes: a managed
 * repo's self-contained `.claude-manager/` config as the SOURCE OF TRUTH for
 * authored agents, modes, and custom instructions. Config-sourced agents/modes
 * take precedence over `.data`-defined ones (resolved config-first, store-
 * fallback), and the authored instructions are injected into the session's
 * system prompt. A minimal interface keeps the dependency one-way + stubbable.
 */
export interface BrokerProjectConfig {
  /** A config-sourced agent by id, or null when none is authored. */
  getAgent(id: string): AgentConfig | null;
  /** A config-sourced mode by id (mapped to the store shape), or null. */
  getMode(id: string): ModeConfig | null;
  /** The bounded, delimited system-prompt append for a project's authored
   *  instructions, or null when it has none (inject nothing). */
  buildInstructionsInjection(projectId: string): string | null;
  /** A project's config-sourced external MCP servers (name → config), or `{}`.
   *  Merged into the session's `Options.mcpServers` alongside `manager`. */
  getMcpServers(projectId: string): Record<string, McpServerConfig>;
  /** A project's config-sourced skills (from `.claude-manager/skills/`), or `[]`.
   *  Materialized into the session cwd's `.claude/skills/` so the SDK finds them. */
  getSkills(projectId: string): SkillConfig[];
}

export interface SessionBrokerOptions {
  store: Store;
  bus: EventBus;
  /** Max concurrently-active sessions (running + awaiting-input). Default 6. */
  maxActiveSessions?: number;
  /** Persistent-terminal service exposed to sessions as `mcp__manager__terminal`. */
  terminals?: TerminalService;
  /** Per-project agent memory: injected at start + exposed as `mcp__manager__remember|recall|forget`. */
  memory?: MemoryService;
  /** GitHub control plane: backs `mcp__manager__watch_pr`'s checks/threads/merge polls. */
  github?: GitHubService;
  /** SubApp runner: backs `mcp__manager__run_subapp` (launch apps + get a URL). */
  runner?: RunnerService;
  /** Worktrees: resolve/create a launch dir for run_subapp + list branches. */
  worktrees?: WorktreeService;
  /** Self-contained `.claude-manager/` config: source of truth for authored
   *  agents/modes/instructions (config wins over `.data` on id collision). */
  projectConfig?: BrokerProjectConfig;
  /**
   * Called when a turn ends in ERROR, with the SDK's message. The broker doesn't
   * interpret it — the ResumeScheduler decides whether it was a usage limit and
   * schedules the chat to continue itself (see services/resume-scheduler.ts).
   */
  onTurnError?: (chatId: string, reason: string | undefined) => void;
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

/**
 * Tokens a single request occupies in the context window: its whole input side
 * (fresh + cache-read + cache-creation) plus the generated output. Reads one
 * assistant message's OWN `usage` (per-request, not the session-cumulative usage
 * on the result). Returns null when usage is absent/empty.
 */
function contextTokensOf(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  const sum =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.output_tokens ?? 0);
  return sum > 0 ? sum : null;
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
  /**
   * Auto-surfaced project-memory context (a `<system-reminder>` block) prepended
   * to the SDK message ONLY — never emitted on the visible transcript row. Set
   * when the turn's text matched relevant, not-yet-surfaced memories.
   */
  memoryContext?: string;
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
  /**
   * A `watch_pr` this turn reached a terminal PR state (merged/closed). Sticky
   * until the next user message resets it, so the chat's dot can read green
   * ("PR done") once the agent settles back to idle. Purely a display signal.
   */
  prWatchSettled?: boolean;
  started: boolean;
  input?: InputChannel;
  query?: Query;
  abortController?: AbortController;
  runLoop?: Promise<void>;
  outbox: OutboxItem[];
  pendingPermissions: Map<string, PendingPermission>;
  /**
   * Id shared by the in-flight MAIN-LOOP assistant message's token chunks AND
   * its finalized transcript row. Allocated when the message's stream begins
   * (`message_start` / first delta), consumed + cleared when its finalized
   * `assistant` row is emitted, so the client swaps the streaming buffer for
   * the persisted row in place (no duplicate).
   *
   * Deliberately main-loop-only: subagents run CONCURRENTLY (with the main loop
   * and each other) and their partials interleave, so sharing this single slot
   * with them would let a subagent `message_start` clobber the main loop's id
   * and orphan its buffer as a stuck ●●● StreamingRow. The stream_event handler
   * skips subagent partials, and subagent finalize never touches this slot.
   */
  streamAssistantId?: string;
  /**
   * Context-window occupancy (tokens) of the most recent MAIN-LOOP request this
   * turn — the last top-level assistant message's own `usage` (input + cache +
   * output), NOT the cumulative session usage on the result. Stamped onto the
   * `result` row so the composer's context meter reflects "how full is the
   * window right now", which is what auto-compaction watches.
   */
  lastContextTokens?: number;
  /**
   * The model's context-window size (tokens) for this session, learned from the
   * SDK's `getContextUsage()` control (`maxTokens`) at init and after a model
   * switch. Stamped onto each `result` row so the composer meter divides by the
   * correct window — the 1M variant reports 1M here, a 200k model reports 200k —
   * instead of a hardcoded constant. Undefined until the first refresh lands.
   */
  contextWindow?: number;
  /** Per-session serialized transcript write chain. */
  writeChain: Promise<void>;
  turn: number;
  idleAttentionId?: string;
  stopping: boolean;
  /** One-shot resume/fork config consumed at the next query start. */
  resumeSessionId?: string;
  forkAtUuid?: string;
  fork: boolean;
  /** Skill dirs materialized into `<cwd>/.claude/skills/` for this query (the
   *  ones WE created), removed on teardown so a repo-owned skill is never touched. */
  materializedSkillDirs?: string[];
  /**
   * Names of project memories already auto-surfaced into this session, so a
   * relevant memory is injected once (not re-pushed every matching turn). Reset
   * only with the session; the agent still has the memory in-context after.
   */
  surfacedMemories: Set<string>;
}

/* =============================================================== SessionBroker */

export class SessionBroker {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly cap: number;
  private readonly terminals?: TerminalService;
  private readonly memory?: MemoryService;
  private readonly github?: GitHubService;
  private readonly runner?: RunnerService;
  private readonly worktrees?: WorktreeService;
  private readonly projectConfig?: BrokerProjectConfig;
  /** Settable after construction — the scheduler is built after the broker. */
  onTurnError?: (chatId: string, reason: string | undefined) => void;
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
    this.memory = opts.memory;
    this.github = opts.github;
    this.runner = opts.runner;
    this.worktrees = opts.worktrees;
    this.projectConfig = opts.projectConfig;
    this.onTurnError = opts.onTurnError;
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
        surfacedMemories: new Set(),
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

    // A fresh user message supersedes any completed PR watch: the green "PR done"
    // dot resets so the chat reads as active again (the imminent turn flips it to
    // the pulsing running state).
    session.prWatchSettled = false;

    // A message sent while a question is pending is an implicit decline: unblock
    // the AskUserQuestion(s) so this message can be consumed as the real reply.
    this.declinePendingQuestions(
      session,
      "The user dismissed this question and replied with a message instead.",
    );

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

    // Auto-surface the durable memories most relevant to THIS turn as an invisible
    // <system-reminder> prepended to the SDK message (never on the transcript row
    // emitted above). Once-per-session per memory, best-effort — a lookup failure
    // must never block the turn.
    const memoryContext = await this.surfaceMemory(session, text);

    this.resolveIdleAttention(session);
    session.outbox.push({
      id,
      text,
      images: o.images,
      imageSources,
      memoryContext,
      priority: o.priority ?? "next",
    });
    this.schedule(session);
  }

  /**
   * Rank this project's durable memories against a turn's text and return an
   * invisible `<system-reminder>` block for the SDK message when relevant,
   * not-yet-surfaced ones clear the bar. Records what it surfaced on the session
   * so a memory pushes at most once per session. Best-effort: any failure (or no
   * memory service / no project) yields undefined and the turn proceeds normally.
   */
  private async surfaceMemory(
    session: LiveSession,
    text: string,
  ): Promise<string | undefined> {
    if (!this.memory || !session.projectId || !text.trim()) return undefined;
    try {
      const surfaced = await this.memory.surfaceFor(session.projectId, text, {
        exclude: session.surfacedMemories,
      });
      if (!surfaced) return undefined;
      for (const name of surfaced.names) session.surfacedMemories.add(name);
      return surfaced.block;
    } catch {
      return undefined;
    }
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

  /**
   * Decline an AskUserQuestion without answering. Resolves the pending request
   * as a DENY so the CLI tool reports it declined and the model continues on its
   * own judgement, rather than acting on a fabricated selection. Returns false if
   * no pending request matches `requestId`.
   */
  declineQuestion(requestId: string, message?: string): boolean {
    for (const session of this.sessions.values()) {
      if (!session.pendingPermissions.has(requestId)) continue;
      return this.resolvePermission(requestId, {
        decision: "deny",
        message: message ?? "The user declined to answer this question.",
      });
    }
    return false;
  }

  /**
   * Implicitly decline every pending AskUserQuestion on this session. A new user
   * message is itself a form of declining: the blocked question(s) must resolve
   * for the turn to consume the message, and answering-by-message would be a lie.
   * Non-question permission gates are left untouched.
   */
  private declinePendingQuestions(session: LiveSession, message: string): void {
    for (const [requestId, p] of session.pendingPermissions) {
      if (p.toolName !== "AskUserQuestion") continue;
      this.resolvePermission(requestId, { decision: "deny", message });
    }
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
    // A model switch can change the context window (e.g. 200k ↔ 1M variant);
    // relearn it so the meter's denominator follows the new model.
    if (session.query) void this.refreshContextWindow(session);
  }

  /**
   * The live context-window breakdown for a chat — the SDK's `getContextUsage()`
   * control: total/max tokens, percentage, model, and per-category token counts
   * (system prompt, tools, MCP tools, memory files, messages…). Powers the meter
   * dropup's detail view. Returns null when the session isn't live (never started
   * this process, or torn down) or the SDK build predates the control.
   */
  async getContextUsage(chatId: string): Promise<ContextUsage | null> {
    const session = this.sessions.get(chatId);
    const q = session?.query;
    if (!q?.getContextUsage) return null;
    try {
      const u = await q.getContextUsage();
      // Cache the window off this fresh read so idle meters stay correct too.
      if (session && typeof u.maxTokens === "number") session.contextWindow = u.maxTokens;
      return u as ContextUsage;
    } catch (err) {
      this.bus.publish({
        type: "error",
        chatId,
        message: "context usage query failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Compact the session's context in place via the SDK's native `/compact`
   * command (summarize-and-continue, keeping the session id). Runs as a turn on
   * the existing subprocess; a notice marks it in the transcript. No-op guard is
   * unnecessary — an empty context compacts to nothing harmlessly.
   */
  compact(chatId: string): void {
    const session = this.mustGet(chatId);
    void this.emit(session, {
      kind: "notice",
      id: this.genId(),
      chatId,
      ts: this.now(),
      sessionId: session.sessionId,
      level: "info",
      text: "Compacting context…",
    });
    session.outbox.push({ id: this.genId(), text: "/compact", priority: "next" });
    this.schedule(session);
  }

  /**
   * Record that a `watch_pr` on this chat reached a terminal PR state. Sets the
   * sticky display flag so the chat's dot turns green ("PR done") the moment the
   * agent settles back to idle; a new user message (or fork/clear) clears it.
   */
  markPrWatched(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session) session.prWatchSettled = true;
  }

  /**
   * Clear the model's context via the SDK's native `/clear` command — starts the
   * next turn fresh. The persisted transcript (messages.jsonl) is intentionally
   * left intact; only the model's working context is reset. A notice records it.
   */
  clearContext(chatId: string): void {
    const session = this.mustGet(chatId);
    void this.emit(session, {
      kind: "notice",
      id: this.genId(),
      chatId,
      ts: this.now(),
      sessionId: session.sessionId,
      level: "info",
      text: "Cleared the model's context (transcript kept).",
    });
    session.outbox.push({ id: this.genId(), text: "/clear", priority: "next" });
    this.schedule(session);
  }

  /**
   * Learn the model's context-window size from the SDK and cache it on the
   * session so subsequent `result` rows carry the right denominator. Fire-and-
   * forget: any failure (no live query, older SDK, transport hiccup) leaves the
   * last known window in place and never disrupts a turn.
   */
  private async refreshContextWindow(session: LiveSession): Promise<void> {
    const q = session.query;
    if (!q?.getContextUsage) return;
    try {
      const u = await q.getContextUsage();
      if (typeof u.maxTokens === "number" && u.maxTokens > 0) {
        session.contextWindow = u.maxTokens;
      }
    } catch {
      /* best-effort — keep whatever window we already had */
    }
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
      // Re-publish the current status so the client's "N queued" chip reflects the
      // just-injected message immediately (it decrements again as the SDK consumes).
      this.setStatus(session, session.status);
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
          // Learn this model's context window now that the subprocess is live, so
          // the very next result row carries the correct meter denominator.
          void this.refreshContextWindow(session);
        }
        // A backgrounded task (async `Agent` spawn, backgrounded `Bash`) settled.
        // This is the ONLY per-task completion signal in the stream — the task's
        // tool call answered with a launch ack long ago — so persist it as a row
        // keyed to the launching tool_use. Without it the client can only ask
        // "is the parent turn still running", which gives every background task
        // the same status (see shared TaskStatusRowSchema).
        if (subtype === "task_notification") {
          const usage = (m as { usage?: Record<string, unknown> }).usage;
          const raw = String((m as { status?: unknown }).status ?? "completed");
          const num = (v: unknown): number | undefined =>
            typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;
          await this.emit(session, {
            kind: "task_status",
            id: this.genId(),
            chatId: session.chatId,
            ts: this.now(),
            turn: session.turn,
            sessionId: session.sessionId,
            taskId: String((m as { task_id?: unknown }).task_id ?? ""),
            toolUseId:
              typeof (m as { tool_use_id?: unknown }).tool_use_id === "string"
                ? ((m as { tool_use_id?: string }).tool_use_id as string)
                : undefined,
            status: raw === "failed" || raw === "stopped" ? raw : "completed",
            summary:
              typeof (m as { summary?: unknown }).summary === "string"
                ? ((m as { summary?: string }).summary as string)
                : undefined,
            totalTokens: num(usage?.total_tokens),
            toolUses: num(usage?.tool_uses),
            durationMs: num(usage?.duration_ms),
          });
        }
        return;
      }
      case "assistant": {
        // A subagent (spawned via the Task tool) tags every message it emits with
        // the spawning tool_use id + its own type. Capture both so the finalized
        // rows carry the nesting key the client groups on.
        const parentToolUseId =
          (m as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
        const subagentType = (m as { subagent_type?: string }).subagent_type;
        // Track the main-loop context occupancy from this request's OWN usage
        // (subagent messages have their own separate context, so ignore them).
        if (parentToolUseId === null) {
          const ctx = contextTokensOf((m as { message?: { usage?: unknown } }).message?.usage);
          if (ctx !== null) session.lastContextTokens = ctx;
        }
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
        // Correlate this finalized row with the buffer its chunks streamed into.
        // Only the MAIN loop streams (subagent partials are skipped — see the
        // stream_event handler), so a main-loop row reuses the exact id its chunks
        // published under (`streamAssistantId`) — that's what lets the client swap
        // the live buffer for the persisted row in place. A subagent row NEVER
        // reads or clears that slot: doing so would let it adopt the main loop's
        // live buffer id and orphan it (a stuck ●●● StreamingRow + duplicate text).
        const apiMessageId = (m as { message?: { id?: string } }).message?.id;
        const isMainLoop = parentToolUseId === null;
        const assistantId = isMainLoop
          ? session.streamAssistantId ?? apiMessageId ?? this.genId()
          : apiMessageId ?? this.genId();
        // The main loop is sequential — at most one message streams at a time — so
        // consuming its slot on finalize is unconditional (no-op when nothing
        // streamed, e.g. a tool-only message).
        if (isMainLoop) session.streamAssistantId = undefined;
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
            subagentType,
            parentToolUseId,
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
            parentToolUseId,
            subagentType,
            uuid: (m as { uuid?: string }).uuid,
          });
        }
        return;
      }
      case "user": {
        // A subagent's tool_result rides a `user` message tagged with the spawning
        // Task tool_use id — carry that (and the subagent type) onto the row so it
        // nests under the same Task card as the subagent's assistant/tool_use rows.
        const parentToolUseId =
          (m as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
        const subagentType = (m as { subagent_type?: string }).subagent_type;
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
            parentToolUseId,
            subagentType,
          });
        }
        return;
      }
      case "stream_event": {
        // Token-level partials (only with includePartialMessages). Forward text /
        // thinking deltas as `message-chunk` so the client types out the reply,
        // then supersedes the buffer with the finalized `assistant` row (same id).
        //
        // Only the MAIN loop streams live. Subagents run concurrently (with the
        // main loop and each other) and their partials interleave; honoring them
        // would let a subagent `message_start` clobber the single streamAssistantId
        // slot and orphan the main loop's buffer as a stuck ●●● StreamingRow. A
        // subagent's text still renders from its finalized (nested) `assistant` row.
        const parentToolUseId =
          (m as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
        if (parentToolUseId !== null) return;
        const event = (m as { event?: Record<string, unknown> }).event;
        if (!event || typeof event !== "object") return;
        const et = String((event as { type?: unknown }).type ?? "");
        if (et === "message_start") {
          // A new assistant message begins its token stream → adopt the SDK message
          // id its chunks and finalized row will share (so the two correlate even
          // when a subagent message finalizes in between). Fall back to a fresh id
          // only if the SDK omits it.
          const startId = (event as { message?: { id?: string } }).message?.id;
          session.streamAssistantId = startId ?? this.genId();
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
        const isError = Boolean((m as { is_error?: unknown }).is_error);
        const resultText =
          typeof (m as { result?: unknown }).result === "string"
            ? ((m as { result?: string }).result as string)
            : undefined;
        await this.emit(session, {
          kind: "result",
          id: this.genId(),
          chatId: session.chatId,
          ts: this.now(),
          turn: session.turn,
          sessionId: session.sessionId,
          subtype: String((m as { subtype?: unknown }).subtype ?? "success"),
          isError,
          numTurns: (m as { num_turns?: number }).num_turns,
          durationMs: (m as { duration_ms?: number }).duration_ms,
          result: resultText,
          usage: (m as { usage?: unknown }).usage,
          contextTokens: session.lastContextTokens,
          contextWindow: session.contextWindow,
          costUsd: (m as { total_cost_usd?: number }).total_cost_usd,
        });
        session.turn += 1;
        // A turn that ended in error may have hit a usage limit — hand the
        // message off so the chat can schedule itself to continue.
        if (isError) this.onTurnError?.(session.chatId, resultText);
        // Relearn the window off-loop for the next turn's row (cheap; the model
        // — hence window — can shift mid-session on a switch or fallback).
        void this.refreshContextWindow(session);
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
    this.bus.publish({
      type: "chat-status",
      chatId: session.chatId,
      status,
      activity,
      queued: this.queuedCount(session),
      prSettled: session.prWatchSettled || undefined,
    });
  }

  /** Steering messages submitted but not yet consumed by the SDK (outbox + input). */
  private queuedCount(session: LiveSession): number {
    return session.outbox.length + (session.input?.pending() ?? 0);
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
    this.cleanupSkills(session);
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
      // Deliberate stop/fork abort — settle as a clean done (which cleans skills).
      this.onDone(session);
      return;
    }
    this.cleanupSkills(session);
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
    const mode = await this.resolveMode(modeId);
    if (mode) return mode.permissionMode;
    return BUILTIN_MODE_PERMISSION[modeId] ?? "default";
  }

  /**
   * Resolve a mode by id, config-first: a `.claude-manager/`-authored mode
   * (the source of truth) wins over a `.data`-defined one on id collision.
   */
  private async resolveMode(modeId: string): Promise<ModeConfig | null> {
    return (
      this.projectConfig?.getMode(modeId) ??
      (await this.store.getMode(modeId).catch(() => null))
    );
  }

  /**
   * Resolve an agent by id, config-first: a `.claude-manager/`-authored agent
   * (the source of truth) wins over a `.data`-defined one on id collision.
   */
  private async resolveAgent(agentId: string): Promise<AgentConfig | null> {
    return (
      this.projectConfig?.getAgent(agentId) ??
      (await this.store.getAgent(agentId).catch(() => null))
    );
  }

  /** The project owning a chat (for the run_subapp MCP binding). Null on any miss. */
  private async projectForChat(chatId: string): Promise<Project | null> {
    const chat = await this.store.getChat(chatId).catch(() => null);
    if (!chat) return null;
    return this.store.getProject(chat.projectId).catch(() => null);
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

    // Native auto-compaction (SDK `Settings` layer): keep it ON by default so a
    // session summarizes itself and continues when the window fills, instead of
    // erroring — this is the "auto-clean at the limit" behavior. A global setting
    // can disable it or override the compaction reserve window.
    const appSettings = await this.store.getSettings().catch(() => undefined);
    const ac = appSettings?.autoCompact;
    options.settings = {
      autoCompactEnabled: ac?.enabled ?? true,
      ...(ac?.window ? { autoCompactWindow: ac.window } : {}),
    };

    // Config-sourced agents/modes (the `.claude-manager/` source of truth) win
    // over `.data`-defined ones on id collision.
    const mode = await this.resolveMode(session.modeId);
    const agent = session.agentId ? await this.resolveAgent(session.agentId) : null;

    const appends: string[] = [];
    // Lead with the manager-tools directive so EVERY session (any project)
    // discovers the `mcp__manager__*` tools it has and is steered to prefer them
    // over hand-rolled shell equivalents (the #1 way agents waste effort here).
    appends.push(
      buildManagerToolsDirective({
        github: Boolean(this.github),
        terminals: Boolean(this.terminals),
        memory: Boolean(this.memory && session.projectId),
        runner: Boolean(this.runner && this.worktrees),
        mcpConfig: Boolean(session.projectId),
      }),
    );
    if (mode?.instructions) appends.push(mode.instructions);

    // Inject the project's authored custom instructions from its
    // `.claude-manager/` config — a clearly-delimited, bounded section alongside
    // the mode overlay + memory. Empty (no config / no instructions) → nothing,
    // and it never clobbers the existing appends.
    if (this.projectConfig && session.projectId) {
      const instructions = this.projectConfig.buildInstructionsInjection(session.projectId);
      if (instructions) appends.push(instructions);
    }

    // Read-at-start: inject the project's durable memory (index + one-line
    // descriptions, bounded — never full bodies) so every session begins knowing
    // the team's recorded facts. Empty project → nothing injected. Best-effort: a
    // read failure must never block a turn from starting.
    if (this.memory && session.projectId) {
      try {
        const injection = await this.memory.buildInjection(session.projectId);
        if (injection) appends.push(injection);
      } catch {
        /* no memory injection this turn */
      }
    }

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
    const memory = this.memory;
    const github = this.github;
    const runner = this.runner;
    const worktrees = this.worktrees;
    const projectId = session.projectId;
    // The managed repo's `.claude-manager/` config is the SOURCE OF TRUTH for
    // external MCP servers: layer the config-sourced servers OVER the `.data`
    // record (config wins per-name, a `.data`-only server survives), then apply
    // `manager` LAST so it's never clobbered (even by a config server named
    // "manager"). Consulting the config directly (not just the store-synced copy)
    // keeps a live watcher edit effective for this session.
    const configMcp = (
      this.projectConfig && projectId ? this.projectConfig.getMcpServers(projectId) : {}
    ) as unknown as Record<string, SdkMcpServerConfig>;
    options.mcpServers = {
      ...(project?.mcpServers as unknown as Record<string, SdkMcpServerConfig> | undefined),
      ...configMcp,
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
        // Bind the memory runner to this session's project, so remember/recall/
        // forget just name the fact (scoped to the chat's project).
        memory:
          memory && projectId
            ? {
                remember: (input) => memory.write(projectId, input),
                recall: (query, opts) => memory.recall(projectId, query, opts),
                forget: (name) => memory.delete(projectId, name),
                findSimilar: (candidate) => memory.findSimilar(projectId, candidate),
              }
            : undefined,
        // Bind the PR watcher to this session's default cwd. `prMergeState` lets
        // `gh` auto-detect the repo from cwd; `prChecks`/`reviewThreads` need an
        // explicit owner/name, so resolve it from cwd ONCE (cached) and reuse it.
        // The agent may still pass an explicit repo override on any call.
        github: github ? makeGithubBinding(github, cwd) : undefined,
        // Bind the subApp launcher to this session's project so `run_subapp` can
        // list/start/stop apps and resolve (or create) a worktree per branch.
        runner:
          runner && worktrees
            ? {
                overview: async (chatId) => {
                  const proj = await this.projectForChat(chatId);
                  if (!proj) return { subApps: [], running: [], branches: [] };
                  const all = await runner.list();
                  const running = all
                    .filter((r) => r.projectId === proj.id)
                    .map((r) => ({
                      subAppId: r.subAppId,
                      status: r.status,
                      url: r.url,
                      branch: r.branch,
                      port: r.port,
                    }));
                  const branches = (await worktrees.listBranches(proj)).map((b) => ({
                    name: b.name,
                    current: !!b.isCurrent,
                    hasWorktree: !!b.worktreePath,
                  }));
                  return {
                    subApps: (proj.subApps ?? []).map((s) => ({
                      id: s.id,
                      name: s.name,
                      ports: s.ports,
                    })),
                    running,
                    branches,
                  };
                },
                launch: async ({ chatId, subAppId, branch }) => {
                  const proj = await this.projectForChat(chatId);
                  if (!proj) throw new Error("no project for this chat");
                  const subApp = (proj.subApps ?? []).find((s) => s.id === subAppId);
                  if (!subApp) throw new Error(`subApp "${subAppId}" not found`);
                  const b = branch || proj.defaultBranch || "main";
                  const path = await worktrees.resolveLaunchPath(proj, b);
                  const inst = await runner.start(path, subApp, {
                    projectId: proj.id,
                    chatId,
                    branch: b,
                  });
                  return {
                    subAppId: inst.subAppId,
                    status: inst.status,
                    url: inst.url,
                    branch: inst.branch,
                    port: inst.port,
                  };
                },
                stop: async ({ chatId, subAppId, branch }) => {
                  const proj = await this.projectForChat(chatId);
                  if (!proj) return false;
                  const all = await runner.list();
                  const match = all.find(
                    (r) =>
                      r.projectId === proj.id &&
                      r.subAppId === subAppId &&
                      (!branch || r.branch === branch) &&
                      (r.status === "starting" || r.status === "running"),
                  );
                  if (!match) return false;
                  await runner.stop(match.id);
                  return true;
                },
              }
            : undefined,
        // Bind the MCP-config editor to the project's MAIN repo path, NOT this
        // session's cwd: `.claude-manager/` is committed config, so a server the
        // agent adds while working in a throwaway worktree has to land in the
        // real working copy or it vanishes with the worktree.
        mcpConfig: project?.repoPath ? createMcpConfigEditor(project.repoPath) : undefined,
        signal: session.abortController?.signal,
        now: this.now,
      }),
    };
    // Skills: the managed repo's `.claude-manager/skills/` is the SOURCE OF TRUTH,
    // but the SDK only DISCOVERS `<cwd>/.claude/skills/` (there's no option to
    // point it elsewhere). So materialize the config skills into the session cwd's
    // `.claude/skills/` — a MERGE that never clobbers a skill the repo already
    // ships — then flip `skills: 'all'` so every discovered skill (the repo's own
    // AND the config-authored ones) is enabled. Tracked dirs are removed on
    // teardown.
    //
    // Two sources are merged, PROJECT FIRST so it wins: the project's authored
    // skills, then the manager's own bundled skills (how MCP config works here,
    // etc. — see `bundled-skills.ts`). Because materialization skips any target
    // dir that already exists, a project or repo skill of the same name silently
    // overrides the bundled one rather than fighting it.
    if (cwd) {
      const projectSkills =
        this.projectConfig && projectId ? this.projectConfig.getSkills(projectId) : [];
      const skills = [...projectSkills, ...bundledSkills()];
      if (skills.length) {
        try {
          session.materializedSkillDirs = await materializeSkills(cwd, skills);
        } catch {
          /* best-effort: a copy failure must never block a turn from starting */
        }
        options.skills = "all";
      }
    }
    if (session.fork) {
      if (session.resumeSessionId) options.resume = session.resumeSessionId;
      if (session.forkAtUuid) options.resumeSessionAt = session.forkAtUuid;
      options.forkSession = true;
    } else if (session.resumeSessionId) {
      options.resume = session.resumeSessionId;
    }
    return options;
  }

  /** Remove ONLY the skill dirs we materialized for this session's query (never a
   *  repo-owned skill). Idempotent — clears the tracked list so it runs once. */
  private cleanupSkills(session: LiveSession): void {
    const dirs = session.materializedSkillDirs;
    session.materializedSkillDirs = undefined;
    if (dirs?.length) void cleanupMaterializedSkills(dirs);
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
    // Auto-surfaced memory rides in front of the user's text (SDK-only; the
    // transcript row keeps just item.text) so the agent sees the fact in context.
    const prefix = item.memoryContext ? `${item.memoryContext}\n\n` : "";
    let content: unknown = `${prefix}${item.text}`;
    const sources =
      item.imageSources && item.imageSources.length > 0
        ? item.imageSources
        : (item.images ?? [])
            .map((img) => this.imageSource(img))
            .filter((s): s is Record<string, unknown> => !!s);
    if (sources.length > 0) {
      const blocks: unknown[] = [];
      if (item.memoryContext) blocks.push({ type: "text", text: item.memoryContext });
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
