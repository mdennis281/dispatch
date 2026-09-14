import { describe, it, expect } from "vitest";
import { layerSourceLabel, resolveChain, resolveLayered } from "./layered.js";

describe("resolveLayered", () => {
  it("falls through to the default when no layer pins", () => {
    const r = resolveLayered<boolean>({}, false);
    expect(r).toMatchObject({ effective: false, source: "default", byDefault: false, inherited: false });
    expect("chat" in r).toBe(false);
  });

  it("takes the most specific layer and names it", () => {
    expect(resolveLayered({ app: "a" }, "d")).toMatchObject({ effective: "a", source: "app" });
    expect(resolveLayered({ project: "p", app: "a" }, "d")).toMatchObject({
      effective: "p",
      source: "project",
    });
    expect(resolveLayered({ chat: "c", project: "p", app: "a" }, "d")).toMatchObject({
      effective: "c",
      source: "chat",
    });
  });

  // A `false` or an empty list is a real answer, not an absence. This is the
  // whole reason the chain keys on `undefined` and never on truthiness.
  it("treats false and empty as pins, only undefined as inherit", () => {
    expect(resolveLayered({ chat: false, app: true }, true)).toMatchObject({
      effective: false,
      source: "chat",
    });
    expect(resolveLayered<string[]>({ project: [], app: ["x"] }, ["y"])).toMatchObject({
      effective: [],
      source: "project",
    });
  });

  it("reports what the chat would inherit if its pin were cleared", () => {
    expect(resolveLayered({ chat: "c", app: "a" }, "d").inherited).toBe("a");
    expect(resolveLayered({ chat: "c" }, "d").inherited).toBe("d");
    // Nothing more specific than the project: inherited IS the effective value.
    expect(resolveLayered({ project: "p", app: "a" }, "d").inherited).toBe("p");
  });

  it("keeps every layer's own value visible", () => {
    const r = resolveLayered({ chat: 1, project: 2, app: 3 }, 0);
    expect(r).toMatchObject({ chat: 1, project: 2, app: 3, byDefault: 0 });
  });
});

describe("resolveChain", () => {
  it("walks an arbitrary ordered chain", () => {
    const r = resolveChain<"a" | "b" | "c", number>(
      [
        ["a", undefined],
        ["b", 2],
        ["c", 3],
      ],
      0,
    );
    expect(r).toEqual({ effective: 2, source: "b", inherited: 3 });
  });
});

describe("layerSourceLabel", () => {
  it("has one phrasing per layer", () => {
    expect(layerSourceLabel("chat")).toBe("set for this chat");
    expect(layerSourceLabel("project")).toBe("from this project's config");
    expect(layerSourceLabel("app")).toBe("from your app settings");
    expect(layerSourceLabel("default")).toBe("built-in default");
    expect(layerSourceLabel("default", "off by default")).toBe("off by default");
  });
});
