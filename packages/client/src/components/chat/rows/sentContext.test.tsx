/**
 * "Show sent context" — the session card and the modal's two structured views.
 *
 * Static markup, like the other row tests: the client's vitest runs in a `node`
 * environment. The modal itself portals into `document.body`, so it is not
 * rendered here; its bodies are, because those are where the data shapes bite.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ContextUsage, SentContext, SystemMessageRow } from "@dispatch/shared";
import { McpServersBody, SentContextCard, UsageBody } from "./SentContext.js";

describe("UsageBody", () => {
  it("renders a Codex/goose answer that carries only the two totals", () => {
    // The harness path returns `{ totalTokens, maxTokens }` with no
    // `categories`; reading `.length` off it threw and took the whole
    // "Session started" row down with it.
    const usage = { totalTokens: 12_345, maxTokens: 258_000 } as ContextUsage;
    const html = renderToStaticMarkup(<UsageBody usage={usage} />);
    expect(html).toContain("12.3k");
    expect(html).not.toContain("By category");
  });

  it("leaves deferred MCP tools out of the per-server totals, and says so", () => {
    const usage = {
      totalTokens: 1,
      maxTokens: 2,
      percentage: 50,
      categories: [],
      mcpTools: [
        { name: "mcp__a__x", serverName: "a", tokens: 1_000 },
        { name: "mcp__a__y", serverName: "a", tokens: 9_000, isLoaded: false },
      ],
    } as ContextUsage;
    const html = renderToStaticMarkup(<UsageBody usage={usage} />);
    expect(html).toContain("1 deferred not counted");
    expect(html).toContain("1.0k");
    expect(html).not.toContain("10.0k");
  });
});

describe("McpServersBody", () => {
  it("reads a lean tool COUNT, and finds tokens under the runtime's spelling of the name", () => {
    const html = renderToStaticMarkup(
      <McpServersBody
        servers={[
          { name: "claude.ai Gmail", origin: "external", transport: "unknown", tools: ["send"] },
          { name: "dispatch-chat", origin: "dispatch", transport: "in-process", toolCount: 7 },
        ]}
        usage={
          {
            totalTokens: 1,
            maxTokens: 2,
            percentage: 50,
            categories: [],
            mcpTools: [{ name: "mcp__claude_ai_Gmail__send", serverName: "claude.ai Gmail", tokens: 2_500 }],
          } as ContextUsage
        }
      />,
    );
    expect(html).toContain("7 tools");
    expect(html).toContain("Runtime");
    expect(html).toContain("2.5k");
  });
});

describe("SentContextCard", () => {
  const row: SystemMessageRow = { kind: "system", id: "i1", chatId: "c1", ts: 1, subtype: "init" };
  const sent: SentContext = {
    clipped: true,
    sections: [
      { id: "workflow", label: "Workflow profile — review", text: "# How change ships here\n\nThis project is on the review profile…", chars: 4_000 },
    ],
    mcpServers: [{ name: "dispatch-chat", origin: "dispatch", transport: "in-process", toolCount: 7 }],
    skills: [{ name: "mcp-setup" }],
  };

  it("draws one line per section with a prose preview, not the heading again", () => {
    const html = renderToStaticMarkup(<SentContextCard row={row} sent={sent} />);
    expect(html).toContain("Workflow profile — review");
    expect(html).toContain("This project is on the review profile");
    expect(html).not.toContain("How change ships here");
    expect(html).toContain("≈1.0k tok");
    expect(html).toContain("7 tools");
  });

  it("says when a session start is unchanged from an earlier one", () => {
    const html = renderToStaticMarkup(<SentContextCard row={row} sent={{ ...sent, sameAs: "i0" }} />);
    expect(html).toContain("unchanged since an earlier start");
  });
});
