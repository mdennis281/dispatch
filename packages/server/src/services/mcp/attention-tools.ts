/**
 * The ATTENTION QUEUE as tools — `attention_list` for a caller with no chat of
 * its own (the integration mount).
 *
 * A session never needs these: its human already sees the queue in the
 * sidebar, and every item on it is somebody's card. An integration is the
 * other case — the owner talking to a bot in a car — and "what's waiting on
 * me?" is the first thing it gets asked. The REST twin is
 * `GET /api/integration/attention`; both go through the same binding, so a
 * token reads the queue exactly as far as its allowlist reaches.
 *
 * Kept out of manager-mcp.ts, which only registers them: that file is already
 * the size where every addition costs a reviewer a scroll.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import {
  AttentionItemSchema,
  DISMISSIBLE_ATTENTION_KINDS,
  formatLocalTime,
  type AttentionItem,
  type PermissionRequest,
} from "@dispatch/shared";
import type { ManagerToolArgs, ManagerToolDefinition } from "./manager-mcp.js";

/** One question on a question-kind card, as a caller needs it to answer. */
export interface AttentionQuestion {
  /** `questionIndex` when answering several at once. */
  index: number;
  header?: string;
  question: string;
  multiSelect: boolean;
  /** Pass a `label` as the answer. Empty → free text only. */
  options: { label: string; description?: string }[];
}

/** A queue item plus what a caller needs to act on it without opening the app. */
export interface AttentionEntry extends AttentionItem {
  /** `createdAt` as text with its zone, e.g. `2026-10-29 14:03:12 CDT`. */
  createdAtLocal: string;
  chatTitle?: string;
  /** Whether `attention_dismiss` takes it by default (idle/done/review). */
  dismissible: boolean;
  /** For `question` items still pending: what is being asked. */
  questions?: AttentionQuestion[];
  /** For `permission` items: the tool waiting on approval. */
  permissionTool?: string;
}

export interface AttentionListQuery {
  kinds?: AttentionItem["kind"][];
  project?: string;
  chatId?: string;
}

/**
 * The queue (omitted → no attention tools). Integration-only, bound for a
 * token holding `attention:read`. Applies the token's project allowlist itself.
 */
export interface AttentionDismissQuery {
  /** Named items — removed whatever their kind. */
  ids?: string[];
  /** Without ids: the kinds to sweep (default idle/done/review). */
  kinds?: AttentionItem["kind"][];
  project?: string;
  chatId?: string;
}

export interface AttentionDismissResult {
  dismissed: { id: string; kind: AttentionItem["kind"]; chatId: string; summary: string }[];
  /** Ids named that are not (or no longer) in the queue. */
  missing: string[];
}

export interface ManagerMcpAttention {
  list(q: AttentionListQuery): Promise<AttentionEntry[]>;
  /** Present for a token holding `attention:answer` (omitted → no `attention_dismiss`). */
  dismiss?(q: AttentionDismissQuery): Promise<AttentionDismissResult>;
}

/**
 * Normalize a pending question request's `input.questions` — the
 * AskUserQuestion shape every harness reports — into {@link AttentionQuestion}s.
 * Lenient on purpose: a malformed entry is skipped, never fatal to the list.
 */
export function questionsFromInput(input: Record<string, unknown>): AttentionQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
  return raw.flatMap((q, index) => {
    if (!q || typeof q !== "object") return [];
    const rec = q as Record<string, unknown>;
    const question = str(rec.question) ?? str(rec.prompt) ?? str(rec.header);
    if (!question) return [];
    const options = (Array.isArray(rec.options) ? rec.options : []).flatMap((o) => {
      const label = o && typeof o === "object" ? str((o as Record<string, unknown>).label) : str(o);
      if (!label) return [];
      const description = o && typeof o === "object" ? str((o as Record<string, unknown>).description) : undefined;
      return [{ label, ...(description ? { description } : {}) }];
    });
    return [{ index, ...(str(rec.header) ? { header: str(rec.header) } : {}), question, multiSelect: rec.multiSelect === true, options }];
  });
}

/**
 * Enrich raw queue items into {@link AttentionEntry}s. Shared by the MCP
 * binding and `GET /api/integration/attention`, so the two never disagree.
 * `pending` is the broker's live permission snapshot: a question item whose
 * request is gone (answered a moment ago) simply has no `questions`.
 */
export async function buildAttentionEntries(
  items: readonly AttentionItem[],
  deps: { pending: readonly PermissionRequest[]; chatTitle?: (chatId: string) => Promise<string | undefined> },
): Promise<AttentionEntry[]> {
  const byId = new Map(deps.pending.map((p) => [p.id, p]));
  const dismissible = new Set<string>(DISMISSIBLE_ATTENTION_KINDS);
  const titles = new Map<string, Promise<string | undefined>>();
  return Promise.all(
    items.map(async (item) => {
      const req = item.permissionRequestId ? byId.get(item.permissionRequestId) : undefined;
      if (!titles.has(item.chatId)) titles.set(item.chatId, deps.chatTitle?.(item.chatId).catch(() => undefined) ?? Promise.resolve(undefined));
      const chatTitle = await titles.get(item.chatId);
      const questions = item.kind === "question" && req ? questionsFromInput(req.input) : undefined;
      return {
        ...item,
        createdAtLocal: formatLocalTime(item.createdAt),
        ...(chatTitle ? { chatTitle } : {}),
        dismissible: dismissible.has(item.kind),
        ...(questions?.length ? { questions } : {}),
        ...(item.kind === "permission" && req ? { permissionTool: req.displayName ?? req.toolName } : {}),
      };
    }),
  );
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

function tool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Shape,
  handler: (args: ManagerToolArgs<Shape>) => Promise<CallToolResult>,
): ManagerToolDefinition<Shape> {
  return { name, description, inputSchema, handler };
}

/** One entry as scannable text; the JSON after the list carries everything. */
function renderEntry(e: AttentionEntry): string {
  const head =
    `  • ${e.id} [${e.kind}] ${e.createdAtLocal} chat=${e.chatId}` +
    `${e.chatTitle ? ` "${e.chatTitle}"` : ""} — ${e.summary}` +
    (e.prNumber !== undefined ? ` (PR #${e.prNumber})` : "");
  const qs = (e.questions ?? []).map(
    (q) =>
      `      Q${q.index}${q.multiSelect ? " (multi)" : ""}: ${q.question}` +
      (q.options.length ? ` — options: ${q.options.map((o) => o.label).join(" | ")}` : ""),
  );
  return [head, ...qs].join("\n");
}

export function createAttentionTools(ctx: { attention?: ManagerMcpAttention }) {
  const attentionList = tool(
    "attention_list",
    "The global ATTENTION QUEUE — everything across every chat waiting on the human, most " +
      "urgent first: permission (a tool call needs approval), question (an agent asked " +
      "something; the question text and options are included), review (PR activity: failed " +
      "check, review comment), idle / done (a turn finished). Each item has its chat, project, " +
      "time, and whether it is dismissible by default.",
    {
      kinds: z.array(AttentionItemSchema.shape.kind).optional().describe("Only these kinds."),
      project: z.string().optional().describe("Only items in this project (id)."),
      chatId: z.string().optional().describe("Only items for this chat."),
    },
    async (args) => {
      if (!ctx.attention) return textResult("The attention_list tool is not available in this session.", true);
      try {
        const items = await ctx.attention.list({
          ...(args.kinds?.length ? { kinds: args.kinds } : {}),
          ...(args.project?.trim() ? { project: args.project.trim() } : {}),
          ...(args.chatId?.trim() ? { chatId: args.chatId.trim() } : {}),
        });
        return textResult(
          (items.length
            ? `${items.length} item${items.length === 1 ? "" : "s"} waiting:\n${items.map(renderEntry).join("\n")}`
            : "Nothing is waiting on the human.") + `\n${JSON.stringify({ items })}`,
        );
      } catch (err) {
        return textResult(`Could not list attention: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  );
  const attentionDismiss = tool(
    "attention_dismiss",
    "Dismiss items from the ATTENTION QUEUE (see attention_list). With no ids it clears the " +
      "retrospective kinds — idle, done, review — optionally narrowed by chat or project. A " +
      "permission or question item is a blocked agent, not clutter: it is dismissed only when " +
      "you name it, by id or by passing its kind. Dismissing never answers or denies anything; " +
      "to answer a question use attention_answer.",
    {
      ids: z.array(z.string().min(1)).optional().describe("Exact item ids from attention_list."),
      kinds: z
        .array(AttentionItemSchema.shape.kind)
        .optional()
        .describe("Without ids: kinds to clear (default idle, done, review)."),
      project: z.string().optional().describe("Without ids: only this project (id)."),
      chatId: z.string().optional().describe("Without ids: only this chat."),
    },
    async (args) => {
      if (!ctx.attention?.dismiss) return textResult("The attention_dismiss tool is not available in this session.", true);
      const ids = (args.ids ?? []).map((i) => i.trim()).filter(Boolean);
      if (ids.length && (args.kinds?.length || args.project || args.chatId)) {
        return textResult("Pass either ids, or kinds/project/chatId to sweep — not both.", true);
      }
      try {
        const r = await ctx.attention.dismiss({
          ...(ids.length ? { ids } : {}),
          ...(args.kinds?.length ? { kinds: args.kinds } : {}),
          ...(args.project?.trim() ? { project: args.project.trim() } : {}),
          ...(args.chatId?.trim() ? { chatId: args.chatId.trim() } : {}),
        });
        const lines = r.dismissed.map((d) => `  • ${d.id} [${d.kind}] chat=${d.chatId} — ${d.summary}`);
        return textResult(
          `Dismissed ${r.dismissed.length} item${r.dismissed.length === 1 ? "" : "s"}.` +
            (lines.length ? `\n${lines.join("\n")}` : "") +
            (r.missing.length ? `\nNot in the queue (already resolved, or unknown): ${r.missing.join(", ")}` : "") +
            `\n${JSON.stringify(r)}`,
        );
      } catch (err) {
        return textResult(`Could not dismiss: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  );
  return { attentionList, attentionDismiss };
}
