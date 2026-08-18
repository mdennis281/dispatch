import { describe, it, expect } from "vitest";
import {
  PR_TOOL_PAYLOAD_MARKER,
  decodePrToolPayload,
  encodePrToolPayload,
  type PrToolPayload,
} from "./pr-tools.js";
import { ShellTranscriptFilterSchema } from "./common.js";

function payload(over: Partial<PrToolPayload> = {}): PrToolPayload {
  return {
    v: 1,
    tool: "watch_pr",
    outcome: { summary: "PR #96 needs attention", ok: true, details: ["check build failed"] },
    pr: {
      key: "octo/repo#96",
      repo: "octo/repo",
      number: 96,
      url: "https://github.com/octo/repo/pull/96",
      title: "feat: thing",
      branch: "feat/thing",
      baseBranch: "main",
      state: "open",
      isDraft: false,
      labels: [],
      hold: false,
      mergeable: true,
      reviewDecision: null,
      reviewers: [],
      threads: [],
      checks: [],
      additions: 128,
      deletions: 40,
    },
    ...over,
  } as PrToolPayload;
}

describe("PR tool payloads", () => {
  it("round-trips through a tool result", () => {
    const text = `Some prose for the model.\n${encodePrToolPayload(payload())}`;
    const decoded = decodePrToolPayload(text);
    expect(decoded.payload).toMatchObject({ tool: "watch_pr" });
    expect(decoded.payload?.pr?.additions).toBe(128);
    // The prose comes back WITHOUT the machine line — a human reading the raw
    // exchange should never see the envelope.
    expect(decoded.text).toBe("Some prose for the model.");
    expect(decoded.text).not.toContain(PR_TOOL_PAYLOAD_MARKER);
  });

  it("ignores braces in the prose — the marker is what identifies the line", () => {
    // The real results end in a JSON blob for the model. Picking "the last {"
    // would find THAT, which is why there is a sentinel at all.
    const prose = 'Merged PR #96.\n{"number":96,"merged":true}';
    const text = `${prose}\n${encodePrToolPayload(payload({ tool: "approve_pr" }))}`;
    const decoded = decodePrToolPayload(text);
    expect(decoded.payload?.tool).toBe("approve_pr");
    expect(decoded.text).toBe(prose);
  });

  it("degrades to prose for a result with no payload at all", () => {
    // A transcript written by an older build must still render.
    const decoded = decodePrToolPayload("Opened PR #96 — https://example/pr/96");
    expect(decoded.payload).toBeNull();
    expect(decoded.text).toBe("Opened PR #96 — https://example/pr/96");
  });

  it("degrades to prose for a payload this client cannot read", () => {
    // Forwards compatibility: a NEWER server may send a shape we do not know.
    // Rendering nothing is right; throwing inside a transcript row is not.
    const text = `prose\n${PR_TOOL_PAYLOAD_MARKER}{"v":99,"tool":"teleport_pr"}`;
    expect(decodePrToolPayload(text).payload).toBeNull();
  });

  it("survives a truncated payload line", () => {
    const text = `prose\n${PR_TOOL_PAYLOAD_MARKER}{"v":1,"tool":"watch_pr"`;
    const decoded = decodePrToolPayload(text);
    expect(decoded.payload).toBeNull();
    expect(decoded.text).toContain("prose");
  });

  it("keeps a payload with no PR — a tool that could not read one", () => {
    const text = encodePrToolPayload(payload({ tool: "create_pr", pr: undefined }));
    const decoded = decodePrToolPayload(text);
    expect(decoded.payload?.pr).toBeUndefined();
    expect(decoded.payload?.outcome.summary).toBeTruthy();
  });
});

describe("shell transcript filter — retiring a category", () => {
  it("drops a category that no longer exists instead of failing the record", () => {
    // `pr` was a filter category until PR tools got cards of their own. A stored
    // filter naming it must not make the chat that holds it unreadable.
    const parsed = ShellTranscriptFilterSchema.parse(["shell", "pr", "memory"]);
    expect(parsed).toEqual(["shell", "memory"]);
  });

  it("still rejects a genuinely malformed filter", () => {
    expect(() => ShellTranscriptFilterSchema.parse(["shell", "shell"])).toThrow();
    expect(() => ShellTranscriptFilterSchema.parse("shell")).toThrow();
  });
});
