import { describe, it, expect } from "vitest";
import type { ChatMessage } from "@dispatch/shared";
import { collectChatMedia, indexOfAsset, labelForAsset } from "./chatMedia.js";

const base = { chatId: "c", ts: 0, turn: 1 } as const;

function use(id: string, filePath: string): ChatMessage {
  return { ...base, id: `u-${id}`, kind: "tool_use", toolUseId: id, name: "Read", input: { file_path: filePath } } as ChatMessage;
}

function result(id: string, assets: string[]): ChatMessage {
  return {
    ...base,
    id: `r-${id}`,
    kind: "tool_result",
    toolUseId: id,
    ok: true,
    content: [],
    images: assets.map((path, i) => ({ id: `${id}-${i}`, path, mimeType: "image/png" })),
  } as ChatMessage;
}

describe("labelForAsset", () => {
  it("prefers an explicit alt", () => {
    expect(labelForAsset({ id: "a", path: "assets/x.png", alt: "shot" })).toBe("shot");
  });

  it("falls back to the basename of the path the AGENT asked for", () => {
    // The stored name is content-addressed and unreadable; the tool call still
    // knows what the human would call it.
    expect(
      labelForAsset(
        { id: "a", path: "assets/kEE0Q1yjaoffNb8tVDGmR.png" },
        use("t1", "C:/p/.claude/shots/buck-b2-understair.png") as never,
      ),
    ).toBe("buck-b2-understair.png");
  });

  it("reads the other spellings a file tool uses", () => {
    const ref = { id: "a", path: "assets/x.png" };
    expect(labelForAsset(ref, { input: { path: "a/b/c.png" } } as never)).toBe("c.png");
    expect(labelForAsset(ref, { input: { notebook_path: "n/o.ipynb" } } as never)).toBe("o.ipynb");
  });

  it("is undefined when there is nothing better than the asset id", () => {
    expect(labelForAsset({ id: "a", path: "assets/x.png" })).toBeUndefined();
    expect(labelForAsset({ id: "a", path: "assets/x.png" }, { input: {} } as never)).toBeUndefined();
  });
});

describe("collectChatMedia", () => {
  it("collects every image in transcript order", () => {
    const items = collectChatMedia([
      use("t1", "a/one.png"),
      result("t1", ["assets/1.png"]),
      { ...base, id: "m", kind: "assistant", text: "words" } as ChatMessage,
      use("t2", "a/two.png"),
      result("t2", ["assets/2.png", "assets/3.png"]),
    ]);
    expect(items.map((i) => i.asset.path)).toEqual(["assets/1.png", "assets/2.png", "assets/3.png"]);
  });

  it("captions each image from its own tool call", () => {
    const items = collectChatMedia([
      use("t1", "shots/first.png"),
      result("t1", ["assets/aaa.png"]),
      use("t2", "shots/second.png"),
      result("t2", ["assets/bbb.png"]),
    ]);
    expect(items.map((i) => i.asset.alt)).toEqual(["first.png", "second.png"]);
  });

  it("shows a re-read file once", () => {
    // An agent re-reading the same screenshot after an edit is routine, and a
    // gallery that repeats it makes the arrows feel stuck.
    const items = collectChatMedia([
      use("t1", "a/one.png"),
      result("t1", ["assets/1.png"]),
      use("t2", "a/one.png"),
      result("t2", ["assets/1.png"]),
    ]);
    expect(items).toHaveLength(1);
  });

  it("ignores rows that carry no media", () => {
    expect(
      collectChatMedia([
        { ...base, id: "m", kind: "assistant", text: "no pictures" } as ChatMessage,
        use("t1", "src/index.ts"),
        { ...base, id: "r", kind: "tool_result", toolUseId: "t1", ok: true, content: "1\tcode" } as ChatMessage,
      ]),
    ).toEqual([]);
  });

  it("records the row each image came from", () => {
    const items = collectChatMedia([use("t1", "a/one.png"), result("t1", ["assets/1.png"])]);
    expect(items[0]?.rowId).toBe("r-t1");
  });
});

describe("indexOfAsset", () => {
  const items = ["a", "b", "c"].map((p) => ({ asset: { id: p, path: p }, rowId: p }));

  it("finds the clicked image", () => {
    expect(indexOfAsset(items, "b")).toBe(1);
  });

  it("falls back to the first rather than -1", () => {
    // A markdown embed or a prose chip is not a tool result, so it is not in
    // the gallery — the viewer must still open on something.
    expect(indexOfAsset(items, "not-here")).toBe(0);
    expect(indexOfAsset([], "anything")).toBe(0);
  });
});
