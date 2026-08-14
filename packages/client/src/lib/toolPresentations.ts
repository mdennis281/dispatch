import type { ChatMessage, ToolUseRow } from "@dispatch/shared";
import { parseMcpName, safeJson } from "./format.js";

export type ShellLanguage = "bash" | "powershell";

export interface ShellToolPresentation {
  kind: "shell";
  command: string;
  language: ShellLanguage;
  terminal?: string;
}

export type DispatchToolCategory = "wait" | "pr" | "terminal" | "preview" | "memory" | "chat" | "general";

export interface DispatchToolPresentation {
  kind: "dispatch";
  tool: string;
  title: string;
  activity: string;
  subject?: string;
  category: DispatchToolCategory;
  countdownSeconds?: number;
}

export type ToolPresentation = ShellToolPresentation | DispatchToolPresentation;

/**
 * A presentation handler translates one provider's tool shape into a UI concept.
 * Returning null is deliberate: unknown tools keep using ToolCallCard, which is
 * the compatibility surface for new providers and tools we have not styled yet.
 */
export interface ToolPresentationHandler {
  match(use: ToolUseRow): boolean;
  present(use: ToolUseRow): ToolPresentation | null;
}

function stringArg(use: ToolUseRow, key: string): string | undefined {
  const value = use.input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function inferredLanguage(use: ToolUseRow, fallback: ShellLanguage): ShellLanguage {
  const declared = (stringArg(use, "shell") ?? stringArg(use, "language"))?.toLowerCase();
  if (declared?.includes("powershell") || declared === "pwsh") return "powershell";
  if (declared?.includes("bash") || declared === "sh" || declared === "zsh") return "bash";

  const command = stringArg(use, "command") ?? stringArg(use, "cmd") ?? "";
  // Manager terminals use the host shell. These tokens are strong enough that
  // colouring them as PowerShell is more useful than trusting a generic name.
  if (/\$[A-Za-z_]\w*\s*=|\b(?:Get|Set|New|Remove|Invoke|Select|Where)-[A-Za-z]+\b|\|\s*ForEach-Object\b/.test(command)) {
    return "powershell";
  }
  return fallback;
}

const handlers: readonly ToolPresentationHandler[] = [
  {
    // Claude calls this Bash; Codex commandExecution is normalized to the same
    // provider-neutral shape by the server harness.
    match: (use) => use.name === "Bash",
    present: (use) => {
      const command = stringArg(use, "command");
      return command ? { kind: "shell", command, language: inferredLanguage(use, "bash") } : null;
    },
  },
  {
    // Direct tool APIs use several names, but share the command/cmd contract.
    match: (use) => /^(?:shell_command|exec_command|functions\.(?:shell_command|exec_command))$/.test(use.name),
    present: (use) => {
      const command = stringArg(use, "command") ?? stringArg(use, "cmd");
      return command ? { kind: "shell", command, language: inferredLanguage(use, "powershell") } : null;
    },
  },
  {
    // Dispatch's managed terminal is MCP-backed, so this adapter is intentionally
    // keyed through the parsed MCP identity instead of its rendered label.
    match: (use) => {
      const mcp = parseMcpName(use.name);
      return mcp?.server === "manager" && mcp.tool === "terminal";
    },
    present: (use) => {
      const command = stringArg(use, "command");
      if (!command) return null;
      return {
        kind: "shell",
        command,
        language: inferredLanguage(use, "powershell"),
        terminal: stringArg(use, "name"),
      };
    },
  },
  {
    // Every first-party manager tool gets a Dispatch-native presentation. The
    // handful with richer semantics map explicitly; newly added tools still get
    // a useful generic card instead of silently dropping to MCP wire formatting.
    match: (use) => parseMcpName(use.name)?.server === "manager",
    present: (use) => dispatchPresentation(use),
  },
];

function numberArg(use: ToolUseRow, key: string): number | undefined {
  const value = use.input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function subjectFor(use: ToolUseRow, tool: string): string | undefined {
  const pr = numberArg(use, "number");
  if (pr !== undefined) return `PR #${pr}`;
  const subApp = stringArg(use, "subApp");
  const branch = stringArg(use, "branch");
  if (subApp) return branch ? `${subApp} · ${branch}` : subApp;
  const name = stringArg(use, "name");
  if (name) return name;
  const query = stringArg(use, "query");
  if (query) return query;
  const chatId = stringArg(use, "chatId");
  if (chatId) return chatId;
  const threadId = stringArg(use, "threadId");
  if (threadId) return threadId;
  return undefined;
}

const DISPATCH_COPY: Record<string, { title: string; activity: string; category: DispatchToolCategory }> = {
  ask_user: { title: "Ask user", activity: "Waiting for an answer", category: "chat" },
  wait: { title: "Wait", activity: "Waiting", category: "wait" },
  wait_for_chat: { title: "Wait for chat", activity: "Watching chat", category: "wait" },
  terminal_output: { title: "Terminal output", activity: "Reading terminal", category: "terminal" },
  create_pr: { title: "Open pull request", activity: "Opening pull request", category: "pr" },
  watch_pr: { title: "Watch pull request", activity: "Watching pull request", category: "pr" },
  approve_pr: { title: "Approve and merge", activity: "Merging pull request", category: "pr" },
  resolve_thread: { title: "Resolve review thread", activity: "Resolving review thread", category: "pr" },
  request_review: { title: "Request review", activity: "Requesting review", category: "pr" },
  run_subapp: { title: "App preview", activity: "Starting app preview", category: "preview" },
  context_usage: { title: "Context usage", activity: "Measuring context", category: "chat" },
  compact_context: { title: "Compact context", activity: "Compacting context", category: "chat" },
  remember: { title: "Remember", activity: "Saving project memory", category: "memory" },
  recall: { title: "Recall", activity: "Searching project memory", category: "memory" },
  forget: { title: "Forget", activity: "Removing project memory", category: "memory" },
  memory_list: { title: "Memory index", activity: "Reading project memory", category: "memory" },
  memory_search: { title: "Memory search", activity: "Searching project memory", category: "memory" },
  create_worktree: { title: "Create worktree", activity: "Creating worktree", category: "general" },
};

function titleCaseTool(tool: string): string {
  return tool.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function dispatchPresentation(use: ToolUseRow): DispatchToolPresentation | null {
  const mcp = parseMcpName(use.name);
  if (!mcp || mcp.server !== "manager") return null;
  const copy = DISPATCH_COPY[mcp.tool] ?? {
    title: titleCaseTool(mcp.tool),
    activity: `${titleCaseTool(mcp.tool)} in progress`,
    category: "general" as const,
  };
  const seconds = mcp.tool === "wait" ? numberArg(use, "seconds") : undefined;
  return {
    kind: "dispatch",
    tool: mcp.tool,
    title: copy.title,
    activity: copy.activity,
    subject: subjectFor(use, mcp.tool),
    category: copy.category,
    countdownSeconds: seconds,
  };
}

export function toolPresentation(use: ToolUseRow): ToolPresentation | null {
  for (const handler of handlers) {
    if (!handler.match(use)) continue;
    try {
      return handler.present(use);
    } catch {
      return null;
    }
  }
  return null;
}

export interface TranscriptRowItem {
  kind: "row";
  row: ChatMessage;
}

export interface TranscriptShellItem {
  kind: "shell";
  rows: ToolUseRow[];
}

export type TranscriptItem = TranscriptRowItem | TranscriptShellItem;

/** Group adjacent terminal-style calls while leaving every unhandled row untouched. */
export function groupTranscriptRows(rows: ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let shell: ToolUseRow[] | null = null;

  const flush = () => {
    if (shell?.length) items.push({ kind: "shell", rows: shell });
    shell = null;
  };

  for (const row of rows) {
    // Results and task statuses are folded into their owning command. They do
    // not interrupt a run of commands, just as they did not create visible rows.
    if (row.kind === "tool_result" || row.kind === "task_status") continue;
    if (row.kind === "tool_use" && toolPresentation(row) !== null) {
      (shell ??= []).push(row);
      continue;
    }
    flush();
    items.push({ kind: "row", row });
  }
  flush();
  return items;
}

/** Flatten the text blocks used by MCP results without leaking their wire JSON into the UI. */
export function resultText(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const blocks = content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
          return block.text;
        }
        return "";
      })
      .filter(Boolean);
    if (blocks.length) return blocks.join("\n");
    return "";
  }
  if (typeof content === "object") {
    const value = content as Record<string, unknown>;
    if (typeof value.output === "string") return value.output;
    if (Array.isArray(value.content)) return resultText(value.content);
  }
  return safeJson(content);
}

/** Result text with manager transport metadata removed for transcript display. */
export function displayResultText(content: unknown): string {
  const lines = resultText(content).split(/\r?\n/);
  if (lines.length > 1 && /^\[[^\]]+\]\s+cwd=.*\sexit=\d+$/.test(lines[0]!.trim())) {
    lines.shift();
  }
  return lines.join("\n").trim();
}

/** One useful output line for the collapsed command row. */
export function resultPreview(content: unknown): string {
  const lines = displayResultText(content).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const first = lines[0];
  if (!first) return "No output";
  return first.length > 240 ? `${first.slice(0, 239)}…` : first;
}
