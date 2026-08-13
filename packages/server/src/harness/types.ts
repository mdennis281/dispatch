/**
 * THE HARNESS INTERFACE.
 *
 * A "harness" is the agent runtime that actually executes a chat: Claude Code
 * (via the Agent SDK) or Codex (via `codex app-server`). Everything above this
 * file — the SessionBroker, the store, the wire protocol, the client — speaks
 * only the neutral vocabulary declared here. Everything below it is one
 * adapter's problem.
 *
 * WHY A SEAM AT ALL. Before this existed the broker imported the Agent SDK's
 * `Options` and `Query` types verbatim, switched on the SDK's raw message union,
 * and called SDK-only control methods (`setPermissionMode`, `supportedModels`).
 * Three different runtimes' worth of concepts were fused into one 2800-line
 * class, so "run this chat on something else" was not a configuration — it was a
 * rewrite.
 *
 * WHAT THE SEAM IS SHAPED LIKE. Both runtimes turn out to agree on the same
 * five nouns, which is what makes one interface honest rather than a lowest
 * common denominator:
 *
 *   session   a long-lived conversation with an id that can be resumed later
 *             (SDK session / Codex thread)
 *   turn      one user message and everything the agent does in response
 *   item      a thing that happened inside a turn — assistant text, a tool call,
 *             a tool result, reasoning
 *   ask       the agent blocking on the human: a permission prompt or a
 *             structured question
 *   budget    tokens spent, context remaining, and the account-level rate limit
 *             that can pause the whole thing
 *
 * So an adapter's whole job is: accept a {@link HarnessSessionSpec}, translate
 * it into its runtime's native launch config, and translate that runtime's
 * event stream into {@link HarnessEvent}. Nothing else leaks.
 *
 * WHAT IS DELIBERATELY *NOT* HERE. Dispatch policy — the manager-tools
 * directive, the workflow contract, memory injection, which mode maps to which
 * posture — stays in the broker and arrives as neutral input (system-prompt
 * appends, a permission posture, a tool-guard predicate). An adapter decides how
 * to *deliver* policy on its runtime; it never decides what the policy is.
 */
import type {
  Effort,
  PermissionMode,
  ModelOption,
  McpServerConfig,
  ImageRef,
  HarnessKind,
} from "@dispatch/shared";

export type { HarnessKind };

/* ------------------------------------------------------------- capabilities */

/**
 * What a given harness can actually do.
 *
 * Read by the UI so it can HIDE what a harness lacks rather than render a
 * control that silently does nothing. Every field is a real behavioral
 * difference we found in the two runtimes — not speculative future-proofing.
 */
export interface HarnessCapabilities {
  /**
   * Every tool call can be gated individually. Claude prompts per tool via
   * `canUseTool`; Codex only asks about command execution, file changes, and
   * permission escalations — an MCP tool call is not individually approvable.
   */
  toolPermissions: boolean;
  /** A structured multiple-choice question channel back to the human. */
  questions: boolean;
  /** Named subagents with their own prompt / model / effort. */
  subagents: boolean;
  /** Filesystem-discovered skills. */
  skills: boolean;
  /** In-band context compaction the host can trigger. */
  compaction: boolean;
  /** Fork a session at a chosen point into a new one. */
  fork: boolean;
  /** Account-level rate-limit reporting (see {@link Harness.readLimits}). */
  usageLimits: boolean;
  /** Switch model without restarting the session. */
  liveModelSwitch: boolean;
  /** Switch permission posture without restarting the session. */
  livePermissionSwitch: boolean;
  /**
   * Reasoning-effort levels this runtime accepts. Codex additionally offers
   * "ultra" on some models, which Dispatch's shared `Effort` enum has no member
   * for; the adapter clamps it. The UI renders only these.
   */
  efforts: Effort[];
  /**
   * True when the runtime can BLOCK a tool call before it runs on the strength
   * of a host-side predicate (Claude's PreToolUse hook). When false the
   * workflow guard degrades to deny-at-approval plus interrupt-on-sighting;
   * see the Codex adapter for exactly what that costs.
   */
  preToolGuard: boolean;
  /**
   * How this runtime wants Dispatch's own `mcp__manager__*` tools attached.
   *
   * The one place a runtime difference legitimately reaches the broker, because
   * the two answers need different things BUILT: "in-process" needs a live
   * server object wired to the real services, "http" needs a minted bearer
   * grant against the bridge. Pretending these are interchangeable would mean
   * constructing both every time. See services/mcp/manager-http.ts.
   */
  managerTransport: "in-process" | "http";
}

/* ------------------------------------------------------------------- limits */

/**
 * One rolling usage window, normalized across runtimes.
 *
 * Claude only tells us about a limit by ending a turn with an English sentence
 * ("You've hit your session limit · resets 4:50pm"), so its windows are
 * populated only at the moment of failure and `usedPercent` stays undefined.
 * Codex reports the same thing continuously and numerically. The shape is the
 * union of both so the UI can show a meter when there is one and fall back to
 * "paused until 4:50pm" when there isn't.
 */
export interface HarnessLimitWindow {
  /** 0–100, when the runtime reports it. */
  usedPercent?: number;
  /** Length of the rolling window in minutes, when known. */
  windowMinutes?: number;
  /** Epoch ms at which this window resets. */
  resetsAt?: number;
}

/** Account-level usage state, as far as the harness will tell us. */
export interface HarnessLimits {
  /** The shorter/primary window (Codex: `primary`). */
  primary?: HarnessLimitWindow;
  /** The longer/secondary window, when the plan has one. */
  secondary?: HarnessLimitWindow;
  /** Plan name the runtime reports, for display only. */
  planType?: string;
  /** True when the account is currently OUT of budget, not merely near it. */
  reached?: boolean;
  /** Machine-readable reason when `reached`, e.g. "usage_limit_reached". */
  reachedType?: string;
}

/**
 * A usage limit that ended a turn — the thing {@link ResumeScheduler} arms on.
 *
 * This is the ONE place the two runtimes differ in kind rather than degree:
 * Claude hands us prose we must parse, Codex hands us an error code plus an
 * exact reset timestamp. Normalizing here means the scheduler stopped owning a
 * regex, and the Codex path is strictly more reliable than the Claude one.
 */
export interface HarnessLimitHit {
  /** Epoch ms the window reopens; undefined when the runtime wouldn't say. */
  resetsAt?: number;
  /** Verbatim text to show on the paused card. */
  reason: string;
}

/* --------------------------------------------------------------- session in */

/** A subagent definition, neutral across runtimes. */
export interface HarnessAgentSpec {
  id: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  permissionMode?: PermissionMode;
  effort?: Effort;
}

/** A skill directory to expose to the session. */
export interface HarnessSkillSpec {
  /** Directory containing SKILL.md, already materialized on disk. */
  dir: string;
  name: string;
}

/**
 * A host-side veto on a tool call, evaluated BEFORE the call runs.
 *
 * This is how the workflow guard reaches into a runtime without the broker
 * knowing whether that runtime has hooks. Return a string to block with that
 * reason, or null to allow. Adapters wire it to the best mechanism they have
 * (Claude: a PreToolUse hook; Codex: auto-deny at the approval prompt and
 * interrupt on sighting) and advertise the difference via
 * {@link HarnessCapabilities.preToolGuard}.
 */
export type HarnessToolGuard = (
  toolName: string,
  input: Record<string, unknown>,
) => string | null;

/** Everything needed to open a session, in neutral terms. */
export interface HarnessSessionSpec {
  /** Working directory for the session. */
  cwd?: string;
  /** Starting permission posture. */
  permissionMode: PermissionMode;
  /** Starting reasoning effort. */
  effort: Effort;
  /** Model id from this harness's own picker, or undefined for its default. */
  model?: string;
  /**
   * Blocks appended to the runtime's stock system prompt, in order. The broker
   * builds these (manager tools, workflow contract, mode overlay, project
   * instructions, memory) with no idea which runtime receives them.
   */
  systemPromptAppends: string[];
  /** The single agent this session runs as, when one is pinned. */
  agent?: HarnessAgentSpec;
  /** External MCP servers to attach, by name. */
  mcpServers: Record<string, McpServerConfig>;
  /**
   * Dispatch's own manager tools, in whichever form this harness asked for via
   * {@link HarnessCapabilities.managerTransport}. Absent means don't attach
   * them (a probe session, or a harness that couldn't be granted).
   */
  managerMcp?:
    | { transport: "in-process"; server: unknown }
    | { transport: "http"; url: string; token: string; tokenEnvVar: string };
  /** Skills to expose. */
  skills: HarnessSkillSpec[];
  /** Resume this prior session id instead of starting fresh. */
  resumeSessionId?: string;
  /** When forking, the item id to fork at (inclusive). */
  forkAtId?: string;
  /** True when `resumeSessionId` should be forked rather than continued. */
  fork?: boolean;
  /** Host-side tool veto; see {@link HarnessToolGuard}. */
  toolGuard?: HarnessToolGuard;
  /** Auto-compact when the window fills (default true). */
  autoCompact?: boolean;
  /** Compaction reserve window, when the host pins one. */
  autoCompactWindow?: number;
  /** App-level ceiling for model context retained by one chat. */
  contextTokenLimit?: number;
  /** Aborts the session. */
  abortSignal?: AbortSignal;
}

/** A message pushed into a live session. */
export interface HarnessInput {
  text: string;
  images?: ImageRef[];
  /** Steering priority, where the runtime honors one. */
  priority?: "now" | "next" | "later";
  /** Per-message effort override. */
  effort?: Effort;
}

/**
 * A small, stateless text request owned by a harness.
 *
 * This is deliberately separate from {@link HarnessSession}: incidental app
 * features such as chat titles need one answer, not a persisted/resumable
 * agent with project tools. Each provider can choose its economical model and
 * the native way to suppress settings, tools, and history.
 */
export interface HarnessTextRequest {
  prompt: string;
  /** Lets an adapter choose a purpose-appropriate model and runtime posture. */
  purpose: "title";
  /** Wall-clock budget for the complete native request. */
  timeoutMs?: number;
}

/* -------------------------------------------------------------- session out */

/** The session handshake — emitted once the runtime is live. */
export interface HarnessInitEvent {
  type: "init";
  /** The runtime's own session id, persisted for later resume. */
  sessionId: string;
  model?: string;
  permissionMode?: string;
  tools?: unknown;
  mcpServers?: unknown;
  /** Context window in tokens, when the runtime states it up front. */
  contextWindow?: number;
}

/** A finalized assistant message. */
export interface HarnessAssistantEvent {
  type: "assistant";
  /** Correlates with any `delta` events that streamed it. */
  id: string;
  text: string;
  thinking?: string;
  model?: string;
  /** Runtime-native message uuid, for fork points. */
  uuid?: string;
  /** Set when this came from a subagent rather than the main loop. */
  parentToolUseId?: string | null;
  subagentType?: string;
  /** Effort the runtime actually ran this thread at, when it reports it. */
  effort?: Effort;
}

/** A token-level partial of an in-flight assistant message. */
export interface HarnessDeltaEvent {
  type: "delta";
  id: string;
  channel: "text" | "thinking";
  delta: string;
}

/** A tool call starting. */
export interface HarnessToolUseEvent {
  type: "tool-use";
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  /** MCP server name when this is an `mcp__server__tool` call. */
  server?: string;
  parentToolUseId?: string | null;
  subagentType?: string;
  effort?: Effort;
  uuid?: string;
}

/** A tool call's outcome. */
export interface HarnessToolResultEvent {
  type: "tool-result";
  toolUseId: string;
  ok: boolean;
  /** Runtime-native content blocks; the broker persists images out of these. */
  content: unknown;
  parentToolUseId?: string | null;
  subagentType?: string;
}

/**
 * The agent is blocked on permission to run a tool.
 *
 * Answered with {@link HarnessSession.resolvePermission}. The adapter owns
 * whatever plumbing the answer needs (returning from `canUseTool`, replying to
 * a JSON-RPC request) — the broker only decides allow or deny.
 */
export interface HarnessPermissionEvent {
  type: "permission-request";
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Why the runtime is asking, when it says. */
  reason?: string;
  /** Human-readable target ("src/app.ts", "git push"), when derivable. */
  target?: string;
  parentToolUseId?: string | null;
}

/** One question in a {@link HarnessQuestionEvent}. */
export interface HarnessQuestion {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  /** Free-text is an accepted answer. */
  allowOther: boolean;
  options: { label: string; description?: string }[];
}

/** The agent is blocked on a structured question. */
export interface HarnessQuestionEvent {
  type: "question-request";
  requestId: string;
  questions: HarnessQuestion[];
  parentToolUseId?: string | null;
}

/** A backgrounded task settled (async subagent, backgrounded shell). */
export interface HarnessTaskNotificationEvent {
  type: "task-notification";
  taskId: string;
  toolUseId?: string;
  status: "completed" | "failed" | "stopped";
  summary?: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

/** Rolling token accounting for the main loop. */
export interface HarnessUsageEvent {
  type: "usage";
  /** Tokens currently occupying the context window. */
  contextTokens?: number;
  /** Size of that window. */
  contextWindow?: number;
}

/** Something worth telling the user, outside the transcript's item flow. */
export interface HarnessNoticeEvent {
  type: "notice";
  level: "info" | "warn" | "error";
  text: string;
}

/** The session compacted its own context and continued. */
export interface HarnessCompactedEvent {
  type: "compacted";
}

/** A turn finished, successfully or not. */
export interface HarnessTurnEndEvent {
  type: "turn-end";
  ok: boolean;
  /** Runtime subtype ("success", "error_max_turns", "interrupted", …). */
  subtype: string;
  /** Final assistant text / error message. */
  result?: string;
  numTurns?: number;
  durationMs?: number;
  costUsd?: number;
  /** Raw usage payload, persisted for the usage view. */
  usage?: unknown;
  contextTokens?: number;
  contextWindow?: number;
  /** Set when this turn ended because the account ran out of budget. */
  limit?: HarnessLimitHit;
}

export type HarnessEvent =
  | HarnessInitEvent
  | HarnessAssistantEvent
  | HarnessDeltaEvent
  | HarnessToolUseEvent
  | HarnessToolResultEvent
  | HarnessPermissionEvent
  | HarnessQuestionEvent
  | HarnessTaskNotificationEvent
  | HarnessUsageEvent
  | HarnessNoticeEvent
  | HarnessCompactedEvent
  | HarnessTurnEndEvent;

/* ------------------------------------------------------------------ answers */

/** Host answer to a {@link HarnessPermissionEvent}. */
export interface HarnessPermissionResolution {
  decision: "allow" | "deny";
  /** Replace the tool input on allow, where the runtime supports it. */
  updatedInput?: Record<string, unknown>;
  /** Deny reason / allow note. */
  message?: string;
}

/** Host answer to one question of a {@link HarnessQuestionEvent}. */
export interface HarnessQuestionAnswer {
  questionId: string;
  /** Chosen option labels, or free text when the human typed their own. */
  selected: string[];
  /** Extra notes the human attached. */
  notes?: string;
}

/* ------------------------------------------------------------------ session */

/**
 * A live session. Created by {@link Harness.createSession}; the runtime is not
 * spawned until the first {@link HarnessSession.send}, so opening a session is
 * cheap and a queued chat costs nothing.
 */
export interface HarnessSession {
  /** The neutral event stream. Ends when the session is done or disposed. */
  events: AsyncIterable<HarnessEvent>;
  /** Queue a message. Starts the runtime on first call. */
  send(input: HarnessInput): void;
  /** How many queued messages the runtime has not consumed yet. */
  pending(): number;
  /** Stop the current turn but keep the session alive. */
  interrupt(): Promise<void>;
  /** Switch posture mid-session, where supported. */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Switch model mid-session, where supported. */
  setModel(model: string): Promise<void>;
  /** Switch effort mid-session. */
  setEffort(effort: Effort): Promise<void>;
  /** Compact the context in place, where supported. */
  compact(): Promise<void>;
  /** Answer a pending permission request. */
  resolvePermission(requestId: string, resolution: HarnessPermissionResolution): void;
  /** Answer a pending question. */
  resolveQuestion(requestId: string, answers: HarnessQuestionAnswer[]): void;
  /** The context window of the model currently running, when knowable. */
  contextWindow(): Promise<number | undefined>;
  /** Tear the runtime down and end the event stream. */
  dispose(): Promise<void>;
}

/* ------------------------------------------------------------------ harness */

/** Where a harness's executable came from, for the boot log. */
export interface HarnessRuntimeInfo {
  kind: HarnessKind;
  /** Path we spawn, or undefined when the runtime is bundled/in-process. */
  path?: string;
  version?: string;
  source: "override" | "installed" | "bundled" | "missing";
  /** False when the runtime isn't installed — the UI greys the option out. */
  available: boolean;
}

/** One agent runtime Dispatch can drive. */
export interface Harness {
  readonly kind: HarnessKind;
  readonly capabilities: HarnessCapabilities;
  /** Runtime resolution, for the boot log and the settings pane. */
  runtime(): HarnessRuntimeInfo;
  /** Models for the picker. Never throws — degrades to a static list. */
  listModels(opts?: { refresh?: boolean }): Promise<ModelOption[]>;
  /** Account usage state, or null when this harness can't report it. */
  readLimits(): Promise<HarnessLimits | null>;
  /** Run a stateless one-shot text request without opening a chat session. */
  generateText(request: HarnessTextRequest): Promise<string>;
  /** Open a session (lazily — nothing spawns until the first send). */
  createSession(spec: HarnessSessionSpec): HarnessSession;
  /** Release any shared process this harness holds. */
  dispose?(): Promise<void>;
}
