import { describe, it, expect } from "vitest";
import { mergeImages, recoverResultMedia } from "./resultMedia.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("recoverResultMedia", () => {
  it("recovers an Anthropic image block and blanks its payload", () => {
    const { images, content } = recoverResultMedia([
      { type: "text", text: "here" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
    ]);
    expect(images).toHaveLength(1);
    expect(images[0]?.path).toBe(`data:image/png;base64,${PNG}`);
    // The raw pane must not receive the base64 back — that is what freezes the
    // tab on a multi-megabyte screenshot.
    expect(JSON.stringify(content)).not.toContain(PNG);
  });

  it("recovers an MCP EmbeddedResource blob — a shape that used to render nothing", () => {
    const { images } = recoverResultMedia([
      {
        type: "resource",
        resource: { uri: "file:///t/a.png", mimeType: "image/png", blob: PNG, name: "shot" },
      },
    ]);
    expect(images).toHaveLength(1);
    expect(images[0]?.alt).toBe("shot");
  });

  it("recovers an SVG carried as resource text", () => {
    const { images } = recoverResultMedia([
      {
        type: "resource",
        resource: { uri: "file:///t/a.svg", mimeType: "image/svg+xml", text: "<svg/>" },
      },
    ]);
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/svg+xml");
  });

  it("walks into a serialized CallToolResult in a text block", () => {
    const { images, content } = recoverResultMedia([
      {
        type: "text",
        text: JSON.stringify({
          content: [{ type: "image", data: PNG, mimeType: "image/png" }],
        }),
      },
    ]);
    expect(images).toHaveLength(1);
    expect(JSON.stringify(content)).not.toContain(PNG);
  });

  it("walks into structuredContent", () => {
    const { images } = recoverResultMedia({
      structuredContent: [{ type: "image_url", image_url: { url: `data:image/gif;base64,${PNG}` } }],
    });
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/gif");
  });

  it("turns a server-normalized asset pointer into a ref", () => {
    const { images } = recoverResultMedia([
      { type: "image", media_type: "image/webp", asset: "assets/abc.webp" },
    ]);
    expect(images).toEqual([
      expect.objectContaining({ path: "assets/abc.webp", mimeType: "image/webp" }),
    ]);
  });

  it("leaves ordinary results untouched", () => {
    const content = [{ type: "text", text: "ok, done" }];
    const out = recoverResultMedia(content);
    expect(out.images).toEqual([]);
    expect(out.content).toEqual(content);
  });

  it("does not mistake non-result JSON for a tool result", () => {
    const content = [{ type: "text", text: '{"ok":true,"count":3}' }];
    expect(recoverResultMedia(content).content).toEqual(content);
  });
});

describe("depth bounding", () => {
  it("survives a deeply nested payload instead of blowing the stack", () => {
    // The walk runs inside a render. Unbounded recursion here does not fail to
    // find an image, it takes the whole transcript down.
    let deep: unknown = { type: "image", data: PNG, mimeType: "image/png" };
    for (let i = 0; i < 5000; i += 1) deep = [deep];
    expect(() => recoverResultMedia(deep)).not.toThrow();
  });

  it("still reaches media at a realistic nesting depth", () => {
    const { images } = recoverResultMedia({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            content: [{ type: "image", data: PNG, mimeType: "image/png" }],
          }),
        },
      ],
    });
    expect(images).toHaveLength(1);
  });
});

describe("mergeImages", () => {
  it("drops a recovered duplicate of a server-supplied ref", () => {
    // Both are live at once: a current message has a real ImageRef AND a
    // sanitized `{asset}` block that the walk turns into a second ref.
    const server = [{ id: "a", path: "assets/x.png", mimeType: "image/png" }];
    const recovered = [{ id: "recovered-1", path: "assets/x.png", mimeType: "image/png" }];
    expect(mergeImages(server, recovered)).toEqual(server);
  });

  it("keeps a recovered ref the server never knew about", () => {
    const recovered = [{ id: "recovered-1", path: "data:image/png;base64,AA==" }];
    expect(mergeImages(undefined, recovered)).toEqual(recovered);
  });
});
