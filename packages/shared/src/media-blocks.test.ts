import { describe, it, expect } from "vitest";
import {
  findDataUrls,
  isPreviewablePath,
  parseDataUrl,
  parseInlineMedia,
  stripBase64Whitespace,
} from "./media-blocks.js";

/** A valid 1x1 PNG, base64. Used wherever the payload has to survive a decode. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("parseDataUrl", () => {
  it("splits a base64 data URL", () => {
    expect(parseDataUrl(`data:image/png;base64,${PNG}`)).toEqual({
      mimeType: "image/png",
      base64: PNG,
    });
  });

  it("re-encodes a percent-encoded text payload — the way SVG usually arrives", () => {
    const parsed = parseDataUrl("data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%202%202%22%2F%3E");
    expect(parsed?.mimeType).toBe("image/svg+xml");
    expect(Buffer.from(parsed!.base64, "base64").toString()).toBe('<svg viewBox="0 0 2 2"/>');
  });

  it("finds a data URL embedded in prose", () => {
    expect(parseDataUrl(`here you go: data:image/png;base64,${PNG} — enjoy`)?.base64).toBe(PNG);
  });

  it("returns null for anything else", () => {
    expect(parseDataUrl("just words")).toBeNull();
    expect(parseDataUrl("https://example.com/a.png")).toBeNull();
  });
});

describe("stripBase64Whitespace", () => {
  it("removes the newlines a prettified payload carries", () => {
    expect(stripBase64Whitespace("iVBO\nRw0K\r\nGgo=")).toBe("iVBORw0KGgo=");
  });

  it("pads an unpadded payload rather than rejecting it", () => {
    expect(stripBase64Whitespace("iVBORw0KGgoA")).toBe("iVBORw0KGgoA");
    expect(stripBase64Whitespace("iVBORw0KGgoAA")).toBe("");
    expect(stripBase64Whitespace("iVBORw0KGgoAAA")).toBe("iVBORw0KGgoAAA==");
  });

  it("rejects a payload that still carries its data-URL prefix", () => {
    // The bug this guards: Buffer.from() would not throw, it would return
    // plausible garbage and that garbage would be written to disk.
    expect(stripBase64Whitespace(`data:image/png;base64,${PNG}`)).toBe("");
  });
});

describe("parseInlineMedia", () => {
  it("reads Anthropic's nested base64 source", () => {
    expect(
      parseInlineMedia({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: PNG },
      }),
    ).toMatchObject({ base64: PNG, mimeType: "image/png" });
  });

  it("reads Anthropic's url source", () => {
    expect(
      parseInlineMedia({ type: "image", source: { type: "url", url: "https://x/y.png" } }),
    ).toMatchObject({ url: "https://x/y.png" });
  });

  it("reads MCP's flat ImageContent", () => {
    expect(parseInlineMedia({ type: "image", data: PNG, mimeType: "image/webp" })).toMatchObject({
      base64: PNG,
      mimeType: "image/webp",
    });
  });

  it("reads MCP AudioContent", () => {
    expect(parseInlineMedia({ type: "audio", data: PNG, mimeType: "audio/wav" })).toMatchObject({
      base64: PNG,
      mimeType: "audio/wav",
    });
  });

  it("reads an MCP EmbeddedResource carrying a binary blob", () => {
    // Previously dropped entirely — a standard MCP shape that rendered nothing.
    expect(
      parseInlineMedia({
        type: "resource",
        resource: { uri: "file:///tmp/a.png", mimeType: "image/png", blob: PNG, name: "shot" },
      }),
    ).toMatchObject({ base64: PNG, mimeType: "image/png", alt: "shot" });
  });

  it("reads an SVG EmbeddedResource carrying source text", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>';
    const got = parseInlineMedia({
      type: "resource",
      resource: { uri: "file:///tmp/a.svg", mimeType: "image/svg+xml", text: svg },
    });
    expect(got?.mimeType).toBe("image/svg+xml");
    expect(Buffer.from(got!.base64!, "base64").toString()).toBe(svg);
  });

  it("leaves a plain-text EmbeddedResource alone", () => {
    expect(
      parseInlineMedia({
        type: "resource",
        resource: { uri: "file:///tmp/a.txt", mimeType: "text/plain", text: "hello" },
      }),
    ).toBeNull();
  });

  it("reads OpenAI's image_url, object and flattened", () => {
    expect(
      parseInlineMedia({ type: "image_url", image_url: { url: `data:image/gif;base64,${PNG}` } }),
    ).toMatchObject({ base64: PNG, mimeType: "image/gif" });
    expect(
      parseInlineMedia({ type: "image_url", image_url: "https://x/y.jpg" }),
    ).toMatchObject({ url: "https://x/y.jpg" });
  });

  it("reads improvised flat spellings", () => {
    expect(parseInlineMedia({ type: "image", url: `data:image/png;base64,${PNG}` })).toMatchObject({
      base64: PNG,
    });
    expect(parseInlineMedia({ type: "image", src: `data:image/png;base64,${PNG}` })).toMatchObject({
      base64: PNG,
    });
    expect(parseInlineMedia({ type: "image", b64_json: PNG, mimeType: "image/png" })).toMatchObject({
      base64: PNG,
    });
  });

  it("strips a data-URL prefix that arrived inside the data field", () => {
    // The corruption case: `data` is supposed to be raw base64, but plenty of
    // servers put the whole data URL there.
    expect(
      parseInlineMedia({ type: "image", data: `data:image/png;base64,${PNG}` }),
    ).toMatchObject({ base64: PNG, mimeType: "image/png" });
  });

  it("lifts a bare data URL out of a text block", () => {
    expect(parseInlineMedia({ type: "text", text: `data:image/png;base64,${PNG}` })).toMatchObject({
      base64: PNG,
      mimeType: "image/png",
    });
  });

  it("lifts a bare data URL string", () => {
    expect(parseInlineMedia(`data:image/png;base64,${PNG}`)).toMatchObject({ base64: PNG });
  });

  it("ignores text, tool plumbing and junk", () => {
    expect(parseInlineMedia({ type: "text", text: "I saved the chart." })).toBeNull();
    expect(parseInlineMedia({ type: "tool_use", id: "x", name: "Bash" })).toBeNull();
    expect(parseInlineMedia({ type: "resource_link", uri: "file:///a.png" })).toBeNull();
    expect(parseInlineMedia(null)).toBeNull();
    expect(parseInlineMedia(42)).toBeNull();
  });
});

describe("findDataUrls", () => {
  it("finds every data URL and its span", () => {
    const text = `one ![a](data:image/png;base64,${PNG}) two data:image/gif;base64,${PNG} end`;
    const found = findDataUrls(text);
    expect(found).toHaveLength(2);
    expect(found[0].media.mimeType).toBe("image/png");
    expect(found[1].media.mimeType).toBe("image/gif");
    expect(text.slice(found[0].start, found[0].end)).toContain("data:image/png");
  });

  it("is empty for ordinary prose", () => {
    expect(findDataUrls("no pictures here")).toEqual([]);
  });
});

describe("isPreviewablePath", () => {
  it("accepts media extensions, including through a query string", () => {
    for (const p of ["out/chart.png", "a.SVG", "/tmp/run.mp4", "x/y.jpeg?v=2"]) {
      expect(isPreviewablePath(p), p).toBe(true);
    }
  });

  it("rejects code and data files", () => {
    for (const p of ["src/index.ts", "package.json", "notes.md", "a.png.bak"]) {
      expect(isPreviewablePath(p), p).toBe(false);
    }
  });
});
