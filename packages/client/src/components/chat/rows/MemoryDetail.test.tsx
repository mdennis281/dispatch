import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolUseRow } from "@dispatch/shared";
import { MemoryArguments, RecallResultView, parseRecallResult } from "./MemoryDetail.js";

// Mirrors the string `recall` builds in packages/server/src/services/mcp/manager-mcp.ts.
const recall =
  '2 match(es) for "deploy":\n\n' +
  [
    "### deploy-runbook (project)\nHow a release reaches users\n\nRun **promote**.\n\n---\n\nThen tag it.",
    "### two-instances (reference) — linked\nStable on 4318, dev on 4319\n\n- stable\n- dev",
  ].join("\n\n---\n\n");

describe("parseRecallResult", () => {
  it("splits one section per memory, keeping a body's own --- rule inside it", () => {
    const parsed = parseRecallResult(recall);
    expect(parsed?.heading).toBe('2 match(es) for "deploy":');
    expect(parsed?.memories.map((m) => [m.name, m.type, m.linked])).toEqual([
      ["deploy-runbook", "project", false],
      ["two-instances", "reference", true],
    ]);
    expect(parsed?.memories[0]?.description).toBe("How a release reaches users");
    expect(parsed?.memories[0]?.body).toBe("Run **promote**.\n\n---\n\nThen tag it.");
  });

  it("peels off the size-budget footer", () => {
    const parsed = parseRecallResult(`${recall}\n\n---\n\n_3 more match(es) omitted to stay within the size limit: a, b, c._`);
    expect(parsed?.memories).toHaveLength(2);
    expect(parsed?.tail).toMatch(/^_3 more/);
  });

  it("leaves the index and no-match replies to plain markdown", () => {
    expect(parseRecallResult("- deploy-runbook — How a release reaches users")).toBeNull();
    expect(parseRecallResult('No memories matched "x".\n\n- a — b')).toBeNull();
  });

  it("renders each memory body as markdown in its own section", () => {
    const html = renderToStaticMarkup(<RecallResultView result={parseRecallResult(recall)!} />);
    expect(html.match(/<section/g)).toHaveLength(2);
    expect(html).toMatch(/<strong[^>]*>promote<\/strong>/);
  });
});

describe("MemoryArguments", () => {
  it("renders a remember body as markdown, not an escaped JSON string", () => {
    const use = {
      kind: "tool_use",
      id: "t1",
      chatId: "c1",
      ts: 0,
      name: "mcp__dispatch-memory__remember",
      input: { name: "deploy-runbook", type: "project", description: "How a release ships", body: "# Steps\n\n**Why:** speed" },
    } as unknown as ToolUseRow;
    const html = renderToStaticMarkup(<MemoryArguments use={use} tool="remember" />);
    expect(html).toMatch(/<strong[^>]*>Why:<\/strong>/);
    expect(html).toContain("How a release ships");
    expect(html).toContain("Raw arguments");
  });
});
