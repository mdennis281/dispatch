/**
 * WebSocket wire protocol. Everything the client receives is a WsServerEvent;
 * everything the client sends is a WsClientAction. Both are discriminated on
 * `type` and tagged with `chatId` where a chat is involved. Zod schemas double
 * as the inbound validator at the WS boundary.
 */
import * as z from "zod";
import {
  ChatStatusSchema,
  AgentActivitySchema,
  EffortSchema,
  ImageRefSchema,
  PermissionDecisionSchema,
} from "./common.js";
import {
  ChatSchema,
  ProjectSchema,
  RunnerInstanceSchema,
  PRInfoSchema,
  WorkflowRunSchema,
  WorktreeInfoSchema,
  TerminalInfoSchema,
  ProjectMemorySchema,
} from "./domain.js";
import {
  ChatMessageSchema,
  PermissionRequestSchema,
  AttentionItemSchema,
} from "./messages.js";
import { ProjectConfigSchema, ProjectConfigErrorSchema } from "./project-config.js";
import { UsageSnapshotSchema } from "./usage.js";

/* =============================================================== server → client */

/** Initial handshake after WS connect. */
export const HelloEventSchema = z.object({
  type: z.literal("hello"),
  serverTime: z.number().int(),
  version: z.string().optional(),
});

/** A newly-appended transcript row for a chat. */
export const ChatMessageEventSchema = z.object({
  type: z.literal("chat-message"),
  chatId: z.string(),
  message: ChatMessageSchema,
});

/** Token-level streaming delta for an in-flight assistant/thinking message. */
export const MessageChunkEventSchema = z.object({
  type: z.literal("message-chunk"),
  chatId: z.string(),
  messageId: z.string(),
  delta: z.string(),
  channel: z.enum(["text", "thinking"]),
});

/** Live status + derived activity for a chat (drives the "working…" header). */
export const ChatStatusEventSchema = z.object({
  type: z.literal("chat-status"),
  chatId: z.string(),
  status: ChatStatusSchema,
  activity: AgentActivitySchema.optional(),
  /**
   * Steering/queued messages submitted while the turn is running that the agent
   * hasn't consumed yet. Drives the composer's "N queued" chip off server truth,
   * so it clears the instant the message is injected — not only at turn end.
   */
  queued: z.number().int().nonnegative().optional(),
  /**
   * A `watch_pr` on this chat has run to a terminal state (the PR merged/closed)
   * and hasn't been superseded by a new user message. Lets the sidebar render a
   * settled chat's dot green ("PR done") instead of the neutral idle gray — it
   * only reads as green once `status` is also back to `idle` (no active agent).
   */
  prSettled: z.boolean().optional(),
});

/** A permission decision is required (from canUseTool). */
export const PermissionRequestEventSchema = z.object({
  type: z.literal("permission-request"),
  chatId: z.string(),
  request: PermissionRequestSchema,
});

/** A previously-open permission request was resolved. */
export const PermissionResolvedEventSchema = z.object({
  type: z.literal("permission-resolved"),
  chatId: z.string(),
  requestId: z.string(),
  decision: PermissionDecisionSchema,
});

/** Add an item to the global Attention Queue. */
export const AttentionAddEventSchema = z.object({
  type: z.literal("attention-add"),
  item: AttentionItemSchema,
});

/** Remove/resolve an Attention Queue item. */
export const AttentionResolveEventSchema = z.object({
  type: z.literal("attention-resolve"),
  id: z.string(),
  chatId: z.string().optional(),
});

/** A line of subApp runner output. */
export const RunnerLogEventSchema = z.object({
  type: z.literal("runner-log"),
  runnerId: z.string(),
  stream: z.enum(["stdout", "stderr"]),
  line: z.string(),
  ts: z.number().int(),
});

/** A runner instance's state changed. */
export const RunnerUpdateEventSchema = z.object({
  type: z.literal("runner-update"),
  runner: RunnerInstanceSchema,
});

/** A PR's rich status changed. */
export const PrUpdateEventSchema = z.object({
  type: z.literal("pr-update"),
  chatId: z.string().optional(),
  pr: PRInfoSchema,
});

/** A GitHub Actions run's state changed. */
export const WorkflowUpdateEventSchema = z.object({
  type: z.literal("workflow-update"),
  chatId: z.string().optional(),
  run: WorkflowRunSchema,
});

/** A worktree was created / its diff-vs-base stats changed. */
export const WorktreeUpdateEventSchema = z.object({
  type: z.literal("worktree-update"),
  chatId: z.string().optional(),
  worktree: WorktreeInfoSchema,
});

/** A persistent terminal was created / changed state (cwd/status/busy). */
export const TerminalUpdateEventSchema = z.object({
  type: z.literal("terminal-update"),
  terminal: TerminalInfoSchema,
});

/** A line (or chunk) of terminal I/O for the live read-only view. `command` is
 *  the agent-issued command line echoed by the manager (shells run with stdin
 *  piped and no prompt echo); stdout/stderr are the shell's real streams. */
export const TerminalOutputEventSchema = z.object({
  type: z.literal("terminal-output"),
  terminalId: z.string(),
  chatId: z.string(),
  stream: z.enum(["command", "stdout", "stderr"]),
  chunk: z.string(),
  ts: z.number().int(),
});

/** A terminal was torn down (chat deleted / cap teardown / shell exit). */
export const TerminalClosedEventSchema = z.object({
  type: z.literal("terminal-closed"),
  terminalId: z.string(),
  chatId: z.string(),
});

/** A per-turn rollback checkpoint was written. */
export const CheckpointEventSchema = z.object({
  type: z.literal("checkpoint"),
  chatId: z.string(),
  messageId: z.string(),
  ref: z.string(),
});

/** Chat metadata changed (title/mode/effort/sessionId/worktrees/prs). */
export const ChatUpdateEventSchema = z.object({
  type: z.literal("chat-update"),
  chat: ChatSchema,
});

/** A chat was deleted (its record + live session are gone). Every client drops
 *  it from the sidebar + Attention Queue; deletion is thus authoritative over the
 *  bus, not just a REST side effect on the initiating tab. */
export const ChatDeletedEventSchema = z.object({
  type: z.literal("chat-deleted"),
  chatId: z.string(),
  projectId: z.string().optional(),
});

/** Project config changed. */
export const ProjectUpdateEventSchema = z.object({
  type: z.literal("project-update"),
  project: ProjectSchema,
});

/**
 * A project's authored `.dispatch/` config was (re)loaded — on discovery,
 * a watcher-triggered reload, or an explicit reload request. Carries the source
 * dir (null when the project has no `.dispatch/`), the normalized config
 * (null on none / an unparseable manifest), and any structured load errors.
 */
export const ProjectConfigUpdateEventSchema = z.object({
  type: z.literal("project-config-update"),
  projectId: z.string(),
  sourceDir: z.string().nullable(),
  config: ProjectConfigSchema.nullable(),
  errors: z.array(ProjectConfigErrorSchema).default([]),
});

/** A project memory was created or updated (agent `remember` or panel edit). */
export const MemoryUpdateEventSchema = z.object({
  type: z.literal("memory-update"),
  projectId: z.string(),
  memory: ProjectMemorySchema,
});

/** A project memory was deleted (agent `forget` or panel delete). */
export const MemoryDeletedEventSchema = z.object({
  type: z.literal("memory-deleted"),
  projectId: z.string(),
  name: z.string(),
});

/** Account usage (5h + weekly) refreshed — drives the header usage meter. Global
 *  (no chatId): the server polls once and fans the snapshot out to every client. */
export const UsageUpdateEventSchema = z.object({
  type: z.literal("usage-update"),
  usage: UsageSnapshotSchema,
});

/** A transient toast/notice. */
export const NoticeEventSchema = z.object({
  type: z.literal("notice"),
  chatId: z.string().optional(),
  level: z.enum(["info", "warn", "error"]),
  text: z.string(),
});

/** An error surfaced to the client. */
export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  chatId: z.string().optional(),
  message: z.string(),
  detail: z.string().optional(),
});

export const WsServerEventSchema = z.discriminatedUnion("type", [
  HelloEventSchema,
  ChatMessageEventSchema,
  MessageChunkEventSchema,
  ChatStatusEventSchema,
  PermissionRequestEventSchema,
  PermissionResolvedEventSchema,
  AttentionAddEventSchema,
  AttentionResolveEventSchema,
  RunnerLogEventSchema,
  RunnerUpdateEventSchema,
  PrUpdateEventSchema,
  WorkflowUpdateEventSchema,
  WorktreeUpdateEventSchema,
  TerminalUpdateEventSchema,
  TerminalOutputEventSchema,
  TerminalClosedEventSchema,
  CheckpointEventSchema,
  ChatUpdateEventSchema,
  ChatDeletedEventSchema,
  ProjectUpdateEventSchema,
  ProjectConfigUpdateEventSchema,
  MemoryUpdateEventSchema,
  MemoryDeletedEventSchema,
  UsageUpdateEventSchema,
  NoticeEventSchema,
  ErrorEventSchema,
]);
export type WsServerEvent = z.infer<typeof WsServerEventSchema>;
export type WsServerEventType = WsServerEvent["type"];

/* =============================================================== client → server */

/** Start a new chat under a project. */
export const CreateChatActionSchema = z.object({
  type: z.literal("create-chat"),
  projectId: z.string(),
  title: z.string().optional(),
  modeId: z.string().optional(),
  agentId: z.string().optional(),
  effort: EffortSchema.optional(),
});

/** Subscribe / unsubscribe a socket to a chat's fine-grained stream. */
export const SubscribeActionSchema = z.object({
  type: z.literal("subscribe"),
  chatId: z.string(),
});
export const UnsubscribeActionSchema = z.object({
  type: z.literal("unsubscribe"),
  chatId: z.string(),
});

/** Send a user message (starts/continues a turn). */
export const SendMessageActionSchema = z.object({
  type: z.literal("send-message"),
  chatId: z.string(),
  text: z.string().optional(),
  images: z.array(ImageRefSchema).optional(),
  effort: EffortSchema.optional(),
  priority: z.enum(["now", "next", "later"]).optional(),
});

/** Queue a steering message while a turn is running. */
export const SteerActionSchema = z.object({
  type: z.literal("steer"),
  chatId: z.string(),
  text: z.string(),
  priority: z.enum(["now", "next", "later"]).optional(),
});

/** Answer a permission card. */
export const AnswerPermissionActionSchema = z.object({
  type: z.literal("answer-permission"),
  chatId: z.string(),
  requestId: z.string(),
  decision: PermissionDecisionSchema,
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  /** Deny reason. */
  message: z.string().optional(),
  /** Persist an "always allow" rule. */
  remember: z.boolean().optional(),
});

/** One question's answer within a multi-question AskUserQuestion. */
export const QuestionAnswerSchema = z.object({
  /** Index into the tool input's `questions[]`. */
  questionIndex: z.number().int(),
  optionId: z.string().optional(),
  answer: z.string().optional(),
  /**
   * Extra instructions typed alongside the chosen option. Unlike `answer` (which
   * REPLACES the selection when the user types a custom answer), notes travel
   * WITH the choice — "this option, but also…". Folded into the answer string
   * server-side; see buildQuestionAnswer for why it can't ride its own field.
   */
  notes: z.string().optional(),
});
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

/** Answer an AskUserQuestion prompt. */
export const AnswerQuestionActionSchema = z.object({
  type: z.literal("answer-question"),
  chatId: z.string(),
  requestId: z.string(),
  /** Single-question shape (kept for the common case). */
  optionId: z.string().optional(),
  answer: z.string().optional(),
  /** Extra instructions accompanying the single-question choice. */
  notes: z.string().optional(),
  /** Multi-question shape — one entry per question; supersedes optionId/answer. */
  answers: z.array(QuestionAnswerSchema).optional(),
});

/** Decline an AskUserQuestion prompt without answering it. */
export const DeclineQuestionActionSchema = z.object({
  type: z.literal("decline-question"),
  chatId: z.string(),
  requestId: z.string(),
});

/** Switch the chat's mode mid-run. */
export const SetModeActionSchema = z.object({
  type: z.literal("set-mode"),
  chatId: z.string(),
  modeId: z.string(),
});

/** Switch the chat's agent. */
export const SetAgentActionSchema = z.object({
  type: z.literal("set-agent"),
  chatId: z.string(),
  agentId: z.string().nullable(),
});

/** Set the chat's reasoning effort. */
export const SetEffortActionSchema = z.object({
  type: z.literal("set-effort"),
  chatId: z.string(),
  effort: EffortSchema,
});

/** Switch the model backing the chat's session (applies live + persists). */
export const SetModelActionSchema = z.object({
  type: z.literal("set-model"),
  chatId: z.string(),
  /** SDK model id, e.g. "claude-opus-4-8" / "claude-sonnet-4-6" / "claude-haiku-4-5". */
  model: z.string(),
});

/** (Re)generate the chat's AI title from its recent messages. */
export const RegenerateTitleActionSchema = z.object({
  type: z.literal("regenerate-title"),
  chatId: z.string(),
});

/** Set an explicit chat title (rename); persists + emits `chat-update`. */
export const SetTitleActionSchema = z.object({
  type: z.literal("set-title"),
  chatId: z.string(),
  title: z.string(),
});

/** Interrupt the running turn. */
export const InterruptActionSchema = z.object({
  type: z.literal("interrupt"),
  chatId: z.string(),
});

/** Compact the model's context in place (native SDK `/compact`). */
export const CompactContextActionSchema = z.object({
  type: z.literal("compact-context"),
  chatId: z.string(),
});

/** Clear the model's context (native SDK `/clear`); the transcript is kept. */
export const ClearContextActionSchema = z.object({
  type: z.literal("clear-context"),
  chatId: z.string(),
});

/** Roll back the chat (code + conversation) to a given message. */
export const RollbackActionSchema = z.object({
  type: z.literal("rollback"),
  chatId: z.string(),
  messageId: z.string(),
});

/** Start a subApp runner in a worktree. */
export const StartRunnerActionSchema = z.object({
  type: z.literal("start-runner"),
  projectId: z.string().optional(),
  chatId: z.string().optional(),
  /** Explicit worktree/dir to run in. Omit to resolve one from `branch`. */
  worktreePath: z.string().optional(),
  /** Branch to run on — resolves to (or creates) a worktree when no path given. */
  branch: z.string().optional(),
  subAppId: z.string(),
});

/** Stop a subApp runner (tree-kill). */
export const StopRunnerActionSchema = z.object({
  type: z.literal("stop-runner"),
  runnerId: z.string(),
});

/** Create a git worktree for a chat/branch. */
export const CreateWorktreeActionSchema = z.object({
  type: z.literal("create-worktree"),
  chatId: z.string(),
  projectId: z.string(),
  branch: z.string(),
});

/** Remove a git worktree. */
export const RemoveWorktreeActionSchema = z.object({
  type: z.literal("remove-worktree"),
  chatId: z.string().optional(),
  worktreePath: z.string(),
});

/** Detach a worktree from a chat's ATTRIBUTION only — unlink the record without
 *  deleting the worktree on disk. Lets the user fix a mis-attributed worktree row
 *  (a sibling task's worktree wrongly shown under this chat). */
export const DetachWorktreeActionSchema = z.object({
  type: z.literal("detach-worktree"),
  chatId: z.string(),
  worktreePath: z.string(),
});

/** A GitHub control-plane operation (PRs + Actions). */
export const GhActionSchema = z.object({
  type: z.literal("gh-action"),
  chatId: z.string().optional(),
  projectId: z.string().optional(),
  op: z.enum([
    "ship",
    "refresh",
    "merge",
    "hold",
    "unhold",
    "label",
    "unlabel",
    "rerun",
    "resolve-thread",
    "review",
    "dispatch",
  ]),
  prNumber: z.number().int().optional(),
  /** For label/unlabel. */
  label: z.string().optional(),
  /** For resolve-thread. */
  threadId: z.string().optional(),
  /** For dispatch: workflow file/name + ref + inputs. */
  workflow: z.string().optional(),
  ref: z.string().optional(),
  inputs: z.record(z.string(), z.string()).optional(),
});

export const WsClientActionSchema = z.discriminatedUnion("type", [
  CreateChatActionSchema,
  SubscribeActionSchema,
  UnsubscribeActionSchema,
  SendMessageActionSchema,
  SteerActionSchema,
  AnswerPermissionActionSchema,
  AnswerQuestionActionSchema,
  DeclineQuestionActionSchema,
  SetModeActionSchema,
  SetAgentActionSchema,
  SetEffortActionSchema,
  SetModelActionSchema,
  RegenerateTitleActionSchema,
  SetTitleActionSchema,
  InterruptActionSchema,
  CompactContextActionSchema,
  ClearContextActionSchema,
  RollbackActionSchema,
  StartRunnerActionSchema,
  StopRunnerActionSchema,
  CreateWorktreeActionSchema,
  RemoveWorktreeActionSchema,
  DetachWorktreeActionSchema,
  GhActionSchema,
]);
export type WsClientAction = z.infer<typeof WsClientActionSchema>;
export type WsClientActionType = WsClientAction["type"];
