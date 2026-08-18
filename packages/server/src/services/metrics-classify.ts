/**
 * One tool call → one ledger row.
 *
 * This is the vocabulary the whole metrics feature agrees on, and it lives in
 * its own module because TWO callers have to classify identically or the
 * numbers lie: the live recorder in `SessionBroker` (as calls happen) and the
 * one-time transcript import in `metrics-backfill.ts`. If they disagreed, the
 * same `Skill` call would count as a skill today and a tool from last week.
 *
 * EXACTLY ONE category per call, always the most specific one that applies. A
 * `Skill` call is `skill`, never `skill` AND `tool`; `mcp__manager__create_pr`
 * is `manager`, never `manager` AND `mcp`. That's what makes summing the
 * categories give the honest total instead of double-counting the interesting
 * calls — which are precisely the ones that would be counted twice.
 */
import type { MetricCategory } from "@dispatch/shared";

/** What one tool call contributes to the ledger. */
export interface ClassifiedTool {
  category: MetricCategory;
  /** The uid within the category (tool name, skill name, `server/tool`, …). */
  identifier: string;
  /** Category-specific qualifier — the MCP server, or the carrying tool. */
  detail?: string;
}

/** Parse `mcp__<server>__<tool>` → `[server, tool]`, or null for a built-in. */
function parseMcp(name: string): [server: string, tool: string] | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const i = rest.indexOf("__");
  // A malformed `mcp__foo` (no tool half) is still an MCP call — attribute the
  // whole remainder to the server and let the tool read as the same string,
  // rather than silently filing it as a built-in tool named `mcp__foo`.
  return i >= 0 ? [rest.slice(0, i), rest.slice(i + 2)] : [rest, rest];
}

/** First string-valued key among `keys`, or undefined. */
function pickString(input: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!input) return undefined;
  for (const key of keys) {
    const v = input[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

/**
 * The tools that spawn a subagent. `Agent` is Claude Code's; `Task` is the
 * name the SDK has used and still emits in older transcripts, which the
 * backfill reads — so both have to map here or historical rows land as
 * ordinary tool calls.
 */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/**
 * Classify one tool call.
 *
 * `input` is the tool's arguments — needed only to read the NAME out of the
 * generic carriers (`Skill({skill})`, `Agent({subagent_type})`), which is the
 * whole reason those two get their own categories: "Skill was called 400 times"
 * says nothing, "code-review ran 400 times" is the answer being asked for.
 * A carrier whose payload is missing still classifies, as `(unnamed)` — a
 * lean/hydrated transcript row can legitimately have dropped the input.
 */
export function classifyTool(name: string, input?: Record<string, unknown>): ClassifiedTool {
  const mcp = parseMcp(name);
  if (mcp) {
    const [server, tool] = mcp;
    return server === "manager"
      ? { category: "manager", identifier: tool, detail: server }
      : // `server/tool` so grouping by identifier gives per-endpoint counts while
        // grouping by detail gives per-server ones — both questions, one row.
        { category: "mcp", identifier: `${server}/${tool}`, detail: server };
  }
  if (name === "Skill") {
    return {
      category: "skill",
      identifier: pickString(input, ["skill", "name", "command"]) ?? "(unnamed)",
      detail: name,
    };
  }
  if (SUBAGENT_TOOLS.has(name)) {
    return {
      category: "subagent",
      // Claude Code defaults an un-typed spawn to the general-purpose agent, so
      // that's what an absent `subagent_type` actually means.
      identifier: pickString(input, ["subagent_type", "agentType"]) ?? "general-purpose",
      detail: name,
    };
  }
  return { category: "tool", identifier: name };
}
