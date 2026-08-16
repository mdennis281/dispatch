import { describe, it, expect } from "vitest";
import { fileEditStat, fileResultStat, fileToolAction } from "./file-tools.js";

describe("fileToolAction", () => {
  it("classifies the tools a file row renders", () => {
    expect(fileToolAction("Write")).toBe("write");
    expect(fileToolAction("Edit")).toBe("edit");
    expect(fileToolAction("MultiEdit")).toBe("edit");
    expect(fileToolAction("Read")).toBe("read");
    expect(fileToolAction("Grep")).toBe("search");
    expect(fileToolAction("Glob")).toBe("search");
    expect(fileToolAction("Bash")).toBeNull();
  });
});

describe("fileEditStat", () => {
  it("counts only the lines an Edit actually changed", () => {
    // Identical context on both sides must not inflate the counts, or every
    // small edit inside a large hunk would read as a rewrite.
    expect(
      fileEditStat("Edit", {
        old_string: "const a = 1;\nconst b = 2;\nconst c = 3;",
        new_string: "const a = 1;\nconst b = 20;\nconst c = 3;",
      }),
    ).toEqual({ added: 1, removed: 1 });
  });

  it("reports a pure insertion with no removals", () => {
    expect(
      fileEditStat("Edit", { old_string: "a\nb", new_string: "a\nnew1\nnew2\nb" }),
    ).toEqual({ added: 2, removed: 0 });
  });

  it("reports a pure deletion with no additions", () => {
    expect(fileEditStat("Edit", { old_string: "a\ngone\nb", new_string: "a\nb" })).toEqual({
      added: 0,
      removed: 1,
    });
  });

  it("sums a MultiEdit's individual edits", () => {
    expect(
      fileEditStat("MultiEdit", {
        edits: [
          { old_string: "a", new_string: "a1" },
          { old_string: "b\nc", new_string: "" },
        ],
      }),
    ).toEqual({ added: 1, removed: 3 });
  });

  it("counts a Write as additions only — it says nothing about what it replaced", () => {
    expect(fileEditStat("Write", { content: "one\ntwo\nthree\n" })).toEqual({ added: 3 });
  });

  it("counts a notebook cell deletion as a removal", () => {
    expect(fileEditStat("NotebookEdit", { new_source: "x\ny", edit_mode: "delete" })).toEqual({
      removed: 2,
    });
  });

  it("returns null when the bodies are gone (a lean row) or the tool is not a file tool", () => {
    expect(fileEditStat("Edit", { file_path: "src/a.ts" })).toBeNull();
    expect(fileEditStat("Bash", { command: "ls" })).toBeNull();
  });
});

describe("fileResultStat", () => {
  it("takes a read's range from the line numbering of its output", () => {
    const output = ["   120\tconst a = 1;", "   121\t", "   122\tconst b = 2;"].join("\n");
    expect(fileResultStat("Read", output)).toEqual({ startLine: 120, endLine: 122, lines: 3 });
  });

  it("falls back to a line count when the output carries no numbering", () => {
    expect(fileResultStat("Read", "raw\noutput\n")).toEqual({ lines: 2 });
  });

  it("prefers a search's own tally over counting its rows", () => {
    expect(fileResultStat("Grep", "Found 12 files\na.ts\nb.ts")).toEqual({ count: 12 });
  });

  it("counts a bare listing and recognises an empty search", () => {
    expect(fileResultStat("Glob", "a.ts\nb.ts\nc.ts")).toEqual({ count: 3 });
    expect(fileResultStat("Grep", "No matches found")).toEqual({ count: 0 });
  });

  it("returns null for a tool whose result has no file meaning", () => {
    expect(fileResultStat("Bash", "hello")).toBeNull();
  });
});
