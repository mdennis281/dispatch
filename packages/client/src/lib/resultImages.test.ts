import { describe, expect, it } from "vitest";
import { parseInlineResultImages } from "./resultImages.js";

describe("parseInlineResultImages", () => {
  it("extracts and sanitizes direct Codex MCP image blocks", () => {
    const parsed = parseInlineResultImages([
      { type: "image", data: "aGVsbG8=", mimeType: "image/webp" },
    ]);
    expect(parsed.images).toEqual([{ data: "aGVsbG8=", mimeType: "image/webp" }]);
    expect(JSON.stringify(parsed.content)).not.toContain("aGVsbG8=");
  });

  it("extracts an image from a serialized CallToolResult text block", () => {
    const parsed = parseInlineResultImages([
      {
        type: "text",
        text: JSON.stringify({
          content: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
        }),
      },
    ]);
    expect(parsed.images).toEqual([{ data: "cG5n", mimeType: "image/png" }]);
    expect(JSON.stringify(parsed.content)).not.toContain('\"data\":\"cG5n\"');
  });

  it("leaves unrelated content alone", () => {
    const content = [{ type: "text", text: "{not json" }, { answer: 42 }];
    expect(parseInlineResultImages(content)).toEqual({ images: [], content });
  });
});
