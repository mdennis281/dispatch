import { describe, expect, it } from "vitest";
import {
  applyArtifactEdit,
  artifactAssetType,
  artifactAssetsBytes,
  artifactExtension,
  formatArtifactRef,
  isRewritableAssetType,
  normalizeAssetPath,
  parseArtifactRef,
} from "./artifacts.js";
import { resolveRetention, DEFAULT_ARTIFACT_DAYS } from "./retention.js";

describe("artifact refs", () => {
  it("round-trips through a tool result's prose", () => {
    const ref = { id: "abc_123-x", version: 3, title: "Q3 \"report\"", type: "markdown" as const };
    const text = `Updated "Q3" to version 3.\n${formatArtifactRef(ref)}`;
    expect(parseArtifactRef(text)).toEqual(ref);
  });

  it("is null for a result with no ref or a mangled one", () => {
    expect(parseArtifactRef("No artifact here")).toBeNull();
    expect(parseArtifactRef("dispatch-artifact:{not json")).toBeNull();
    expect(parseArtifactRef('dispatch-artifact:{"id":1}')).toBeNull();
    expect(parseArtifactRef(undefined)).toBeNull();
  });

  it("falls back to html for an unknown type rather than dropping the card", () => {
    expect(parseArtifactRef('dispatch-artifact:{"id":"a","version":1,"type":"react"}')?.type).toBe("html");
  });
});

describe("applyArtifactEdit", () => {
  it("replaces exactly one occurrence", () => {
    expect(applyArtifactEdit("a b c", "b", "B")).toEqual({ ok: true, content: "a B c" });
  });
  it("refuses zero, many, or an empty needle", () => {
    expect(applyArtifactEdit("a", "z", "y").ok).toBe(false);
    expect(applyArtifactEdit("aa", "a", "y").ok).toBe(false);
    expect(applyArtifactEdit("a", "", "y").ok).toBe(false);
  });
  it("treats $ in the replacement literally", () => {
    expect(applyArtifactEdit("price", "price", "$1 $&")).toEqual({ ok: true, content: "$1 $&" });
  });
});

describe("artifactExtension", () => {
  it("never lets a language name become a path", () => {
    expect(artifactExtension("code", "../../evil")).toBe("evil");
    expect(artifactExtension("code")).toBe("txt");
    expect(artifactExtension("svg")).toBe("svg");
  });
});

describe("artifact retention", () => {
  it("defaults to 7 days and honours the app setting", () => {
    expect(DEFAULT_ARTIFACT_DAYS).toBe(7);
    expect(resolveRetention(undefined).artifactDays.effective).toBe(7);
    expect(resolveRetention({ artifactDays: 2 }).artifactMs).toBe(2 * 24 * 60 * 60_000);
  });
});

describe("asset paths and types", () => {
  it("normalizes to a bundle key, refusing anything that leaves the bundle", () => {
    expect(normalizeAssetPath("./textures//hero.png")).toBe("textures/hero.png");
    expect(normalizeAssetPath("textures\\hero.png")).toBe("textures/hero.png");
    for (const bad of ["../x.png", "a/../../x", "", "./", "a/\u0000b"]) expect(normalizeAssetPath(bad), bad).toBeNull();
  });

  it("gives loaders that check the type the one they insist on", () => {
    // instantiateStreaming refuses anything but application/wasm.
    expect(artifactAssetType("engine.WASM")).toBe("application/wasm");
    expect(artifactAssetType("a/b.mjs")).toBe("text/javascript");
    expect(artifactAssetType("noext")).toBe("application/octet-stream");
    expect(isRewritableAssetType("text/css")).toBe(true);
    expect(isRewritableAssetType("model/gltf+json")).toBe(true);
    expect(isRewritableAssetType("model/gltf-binary")).toBe(false);
    expect(artifactAssetsBytes({ a: { sha256: "0".repeat(64), size: 3, type: "x" }, b: { sha256: "1".repeat(64), size: 4, type: "x" } })).toBe(7);
  });
});
