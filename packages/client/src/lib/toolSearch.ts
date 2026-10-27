import type { ToolUseRow } from "@dispatch/shared";
import { resultText } from "./toolPresentations.js";

/**
 * Claude's deferred-tool loader, reduced to what a person wants from it: which
 * tools the agent pulled in. Rendered through the generic card it was a JSON
 * dump of `{query, max_results}` above a JSON dump of `tool_reference` blocks —
 * two boxes of wire format to say "loaded chat_read".
 */
export interface ToolSearchCall {
  /** `select:a,b` names tools outright; anything else is a keyword search. */
  mode: "select" | "search";
  /** The keywords, for a search. */
  query?: string;
  /** The names a `select:` asked for — shown while the call is still running. */
  requested: string[];
}

export function isToolSearch(use: ToolUseRow): boolean {
  return use.name === "ToolSearch";
}

export function parseToolSearchCall(use: ToolUseRow): ToolSearchCall | null {
  const raw = use.input.query;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const query = raw.trim();
  const select = /^select:(.*)$/i.exec(query);
  if (select) {
    const requested = select[1]!
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    return { mode: "select", requested };
  }
  return { mode: "search", query, requested: [] };
}

/**
 * The tool names a ToolSearch result loaded, or null when the result is not
 * the `tool_reference` shape (an error, or prose like "no matching tools") —
 * the card then shows that text instead of claiming an empty load.
 */
export function toolSearchMatches(content: unknown): string[] | null {
  if (!Array.isArray(content)) return null;
  const names: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "tool_reference") {
      const name = (block as { tool_name?: unknown }).tool_name;
      if (typeof name === "string" && name) names.push(name);
    } else if (resultText([block]).trim()) {
      // Real prose alongside the references — not a shape we understand.
      return null;
    }
  }
  return names;
}
