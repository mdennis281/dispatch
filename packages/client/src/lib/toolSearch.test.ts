import { describe, expect, it } from "vitest";
import type { ToolUseRow } from "@dispatch/shared";
import { parseToolSearchCall, toolSearchMatches } from "./toolSearch.js";

function use(input: Record<string, unknown>): ToolUseRow {
  return { id: "u1", chatId: "c1", ts: 0, kind: "tool_use", toolUseId: "t1", name: "ToolSearch", input } as ToolUseRow;
}

describe("parseToolSearchCall", () => {
  it("splits a select: query into the names it asked for", () => {
    expect(parseToolSearchCall(use({ query: "select:mcp__a__x, Read ,", max_results: 2 }))).toEqual({
      mode: "select",
      requested: ["mcp__a__x", "Read"],
    });
  });

  it("treats anything else as a keyword search", () => {
    expect(parseToolSearchCall(use({ query: "notebook jupyter" }))).toEqual({
      mode: "search",
      query: "notebook jupyter",
      requested: [],
    });
  });

  it("declines a call with no query, so the generic card still shows it", () => {
    expect(parseToolSearchCall(use({}))).toBeNull();
  });
});

describe("toolSearchMatches", () => {
  it("reads the loaded names off tool_reference blocks", () => {
    expect(
      toolSearchMatches([
        { type: "tool_reference", tool_name: "mcp__dispatch-chat__chat_read" },
        { type: "tool_reference", tool_name: "WebFetch" },
      ]),
    ).toEqual(["mcp__dispatch-chat__chat_read", "WebFetch"]);
  });

  it("is an empty load for an empty array", () => {
    expect(toolSearchMatches([])).toEqual([]);
  });

  it("declines prose, so the card shows the text instead of '0 tools'", () => {
    expect(toolSearchMatches("No matching deferred tools found")).toBeNull();
    expect(toolSearchMatches([{ type: "text", text: "Error: bad query" }])).toBeNull();
  });
});
