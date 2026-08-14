import type { ChatMessage, ToolUseRow } from "@dispatch/shared";
import { parseMcpName, safeJson } from "./format.js";

export type ShellLanguage = "bash" | "powershell";

export interface ShellToolPresentation {
  kind: "shell";
  command: string;
  language: ShellLanguage;
  terminal?: string;
}

export type ToolPresentation = ShellToolPresentation;

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
];

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

/** Group adjacent handled shell calls while leaving every other row untouched. */
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
    if (row.kind === "tool_use" && toolPresentation(row)?.kind === "shell") {
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

/** One useful output line for the collapsed command row. */
export function resultPreview(content: unknown): string {
  const lines = resultText(content).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // Managed terminals prepend transport metadata. The status column already
  // carries exit state, so spend the scarce preview width on actual output.
  if (lines.length > 1 && /^\[[^\]]+\]\s+cwd=.*\sexit=\d+$/.test(lines[0]!)) lines.shift();
  const first = lines[0];
  if (!first) return "No output";
  return first.length > 240 ? `${first.slice(0, 239)}…` : first;
}
