import { describe, expect, it } from "vitest";
import {
  mcpToolCount,
  mcpToolPrefix,
  readSentContext,
  summarizeSentContext,
  withRuntimeMcpReport,
  withSentContextSummary,
  type SentContextMcpServer,
} from "./sent-context.js";

describe("readSentContext", () => {
  it("is undefined for init rows written before sent context existed", () => {
    expect(readSentContext(undefined)).toBeUndefined();
    expect(readSentContext({ model: "m" })).toBeUndefined();
    expect(readSentContext({ sentContext: { sections: "nope" } })).toBeUndefined();
  });

  it("drops malformed sections rather than throwing in the renderer", () => {
    const got = readSentContext({
      sentContext: { sections: [{ label: "ok", text: "t", chars: 1 }, { label: 3 }, null] },
    });
    expect(got?.sections).toHaveLength(1);
    expect(got?.mcpServers).toEqual([]);
    expect(got?.skills).toEqual([]);
  });
});

describe("withRuntimeMcpReport", () => {
  const configured: SentContextMcpServer[] = [
    { name: "dispatch-chat", origin: "dispatch", transport: "in-process" },
    { name: "playwright", origin: "bundled", transport: "stdio" },
  ];

  it("files each tool under its server and carries the status", () => {
    const out = withRuntimeMcpReport(
      configured,
      ["Bash", "mcp__dispatch-chat__chat_send", "mcp__playwright__browser_click"],
      [
        { name: "dispatch-chat", status: "connected" },
        { name: "playwright", status: "failed" },
      ],
    );
    expect(out[0]).toMatchObject({ tools: ["chat_send"], status: "connected" });
    expect(out[1]).toMatchObject({ tools: ["browser_click"], status: "failed" });
  });

  it("adds servers the runtime attached that Dispatch never configured", () => {
    // A user-level ~/.claude.json server still costs tokens on this session.
    const out = withRuntimeMcpReport(configured, [], [{ name: "claude.ai Gmail", status: "needs-auth" }]);
    expect(out.map((s) => s.name)).toContain("claude.ai Gmail");
  });

  it("leaves tools unset when the runtime listed none, so absent never reads as zero", () => {
    const out = withRuntimeMcpReport(configured, undefined, undefined);
    expect(out[0]!.tools).toBeUndefined();
  });

  it("finds tools under the runtime's normalised spelling of an odd server name", () => {
    // Claude turns "claude.ai Gmail" into mcp__claude_ai_Gmail__… — a literal
    // prefix match filed none of its tools under it.
    const out = withRuntimeMcpReport(
      [],
      ["mcp__claude_ai_Gmail__send", "mcp__claude_ai_Gmail__search"],
      [{ name: "claude.ai Gmail", status: "connected" }],
    );
    expect(out[0]).toMatchObject({ name: "claude.ai Gmail", origin: "external", tools: ["send", "search"] });
    expect(mcpToolPrefix("claude.ai Gmail")).toBe("mcp__claude_ai_Gmail__");
  });

  it("does not mutate the configured list", () => {
    withRuntimeMcpReport(configured, ["mcp__playwright__x"], []);
    expect(configured[1]!.tools).toBeUndefined();
  });
});

describe("summarizeSentContext / withSentContextSummary", () => {
  const sent = {
    sections: [{ id: "instructions:global", label: "Global instructions", text: "SECRET-ISH ".repeat(100), chars: 1100 }],
    mcpServers: [{ name: "dispatch-chat", origin: "dispatch" as const, transport: "in-process", tools: ["a", "b", "c"] }],
    skills: [{ name: "mcp-setup", description: "long description" }],
  };

  it("keeps sizes and counts, drops bodies, tool names and skill descriptions", () => {
    const s = summarizeSentContext(sent, 0);
    expect(s.clipped).toBe(true);
    expect(s.sections[0]).toMatchObject({ label: "Global instructions", text: "", chars: 1100 });
    expect(s.mcpServers[0]).toEqual({ name: "dispatch-chat", origin: "dispatch", transport: "in-process", toolCount: 3 });
    expect(s.skills).toEqual([{ name: "mcp-setup" }]);
    expect(mcpToolCount(s.mcpServers[0]!)).toBe(3);
  });

  it("keeps a preview when asked for one", () => {
    expect(summarizeSentContext(sent, 10).sections[0]!.text).toBe(`${"SECRET-ISH ".repeat(100).slice(0, 10)}…`);
  });

  it("returns data without a sent context untouched", () => {
    const data = { model: "m" };
    expect(withSentContextSummary(data, 0)).toBe(data);
    expect(JSON.stringify(withSentContextSummary({ model: "m", sentContext: sent }, 0))).not.toContain("SECRET-ISH");
  });
});
