import { fileToolAction, type ChatMessage, type FileToolAction, type ToolUseRow } from "@dispatch/shared";
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

/**
 * A call that touched the filesystem, reduced to what its one-line row shows:
 * which file (or which pattern), and what it did to it. The counts are NOT here
 * — they come off the row's `fileStat` because they depend on the result too.
 */
export interface FileToolPresentation {
  kind: "file";
  tool: string;
  action: FileToolAction;
  /** The path the tool named, verbatim (absent for a search). */
  path?: string;
  /** What a search looked for. */
  pattern?: string;
  /** The directory a search was narrowed to. */
  scope?: string;
  /** The glob/type a search was further filtered by (Grep only). */
  filter?: string;
}

export type ToolPresentation = ShellToolPresentation | DispatchToolPresentation | FileToolPresentation;

/** The presentations that belong in a terminal frame — everything but files. */
export type ShellGroupPresentation = ShellToolPresentation | DispatchToolPresentation;

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
    // Read/Write/Edit/Grep/Glob and friends. A row that names no file (and no
    // pattern) has nothing to show, so it falls through to ToolCallCard rather
    // than rendering an empty path.
    match: (use) => fileToolAction(use.name) !== null,
    present: (use) => {
      const action = fileToolAction(use.name);
      if (!action) return null;
      if (action === "search") {
        const pattern = stringArg(use, "pattern") ?? stringArg(use, "query") ?? stringArg(use, "glob");
        if (!pattern) return null;
        const scope = stringArg(use, "path");
        // A Grep's glob/type narrows the regex it already ran; that is a filter
        // ON the search, not the place it ran, so it gets its own slot instead
        // of impersonating the directory (and shadowing it when both are set).
        const filter = use.name === "Grep" ? (stringArg(use, "glob") ?? stringArg(use, "type")) : undefined;
        return {
          kind: "file",
          tool: use.name,
          action,
          pattern,
          scope: scope === pattern ? undefined : scope,
          filter: filter === pattern ? undefined : filter,
        };
      }
      const path =
        stringArg(use, "file_path") ??
        stringArg(use, "filePath") ??
        stringArg(use, "notebook_path") ??
        stringArg(use, "path");
      return path ? { kind: "file", tool: use.name, action, path } : null;
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

/** The presentation for a row inside a terminal frame (never a file or PR row). */
export function shellGroupPresentation(use: ToolUseRow): ShellGroupPresentation | null {
  const presentation = toolPresentation(use);
  if (!presentation || presentation.kind === "file") return null;
  return presentation.kind === "dispatch" && presentation.category === "pr" ? null : presentation;
}

/** True for a call that belongs in a PR card rather than the terminal frame. */
export function isPrPresentation(presentation: ToolPresentation | null): boolean {
  return presentation?.kind === "dispatch" && presentation.category === "pr";
}

export interface TranscriptRowItem {
  kind: "row";
  row: ChatMessage;
}

export interface TranscriptShellItem {
  kind: "shell";
  rows: ToolUseRow[];
}

export interface TranscriptFilesItem {
  kind: "files";
  rows: ToolUseRow[];
}

/**
 * Adjacent pull-request calls, as their own run.
 *
 * They used to sit inside the terminal frame with a `pr >` prompt, which said
 * the wrong thing about them: nothing here is a command, the useful content is
 * the PR's state rather than an output stream, and the terminal's two-line
 * receipt had nowhere to put a title, a diff size or a list of jobs.
 */
export interface TranscriptPrItem {
  kind: "pr";
  rows: ToolUseRow[];
}

export type TranscriptItem =
  | TranscriptRowItem
  | TranscriptShellItem
  | TranscriptFilesItem
  | TranscriptPrItem;

/**
 * Group adjacent terminal-style calls and adjacent file calls into their own
 * runs, leaving every unhandled row untouched.
 *
 * The kinds do NOT merge: a shell run is a terminal session, a file run is a
 * changelog, and a PR run is a pull request's story. Interleaving them would
 * make all three unreadable. A file call between two commands therefore closes
 * the terminal frame, which is honest — that is what happened.
 */
export function groupTranscriptRows(rows: ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: { kind: "shell" | "files" | "pr"; rows: ToolUseRow[] } | null = null;

  const flush = () => {
    if (run?.rows.length) items.push({ kind: run.kind, rows: run.rows });
    run = null;
  };

  for (const row of rows) {
    // Results and task statuses are folded into their owning command. They do
    // not interrupt a run of commands, just as they did not create visible rows.
    if (row.kind === "tool_result" || row.kind === "task_status") continue;
    if (row.kind === "tool_use") {
      const presentation = toolPresentation(row);
      if (presentation) {
        const kind = isPrPresentation(presentation)
          ? "pr"
          : presentation.kind === "file"
            ? "files"
            : "shell";
        if (!run || run.kind !== kind) {
          flush();
          run = { kind, rows: [row] };
        } else {
          run.rows.push(row);
        }
        continue;
      }
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
