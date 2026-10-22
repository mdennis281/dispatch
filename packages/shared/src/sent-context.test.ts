import { describe, expect, it } from "vitest";
import { readSentContext, withRuntimeMcpReport, type SentContextMcpServer } from "./sent-context.js";

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

  it("does not mutate the configured list", () => {
    withRuntimeMcpReport(configured, ["mcp__playwright__x"], []);
    expect(configured[1]!.tools).toBeUndefined();
  });
});
