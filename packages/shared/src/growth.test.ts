import { describe, it, expect } from "vitest";
import {
  GROWTH_GENERATED_KEY,
  GROWTH_NO_EXT_KEY,
  classifyPath,
  extensionLabel,
  languageOf,
} from "./growth.js";

describe("classifyPath", () => {
  it("keys a file by its extension, dot included", () => {
    expect(classifyPath("packages/client/src/App.tsx")).toBe(".tsx");
    expect(classifyPath("README.md")).toBe(".md");
    expect(classifyPath("a/b/c.tar.gz")).toBe(".gz");
  });

  it("is case-insensitive on the extension", () => {
    expect(classifyPath("Foo.TS")).toBe(".ts");
  });

  it("keeps a dotfile's whole name rather than reading it as an extension", () => {
    expect(classifyPath(".gitignore")).toBe(".gitignore");
    expect(classifyPath("packages/.npmrc")).toBe(".npmrc");
  });

  it("recognises extension-less files by name", () => {
    expect(classifyPath("Dockerfile")).toBe("Dockerfile");
    expect(classifyPath("tools/Makefile")).toBe("Makefile");
    expect(classifyPath("LICENSE")).toBe("LICENSE");
  });

  it("buckets anything else without an extension together", () => {
    expect(classifyPath("bin/run")).toBe(GROWTH_NO_EXT_KEY);
  });

  it("sends lockfiles, build output and minified assets to the generated bucket", () => {
    expect(classifyPath("pnpm-lock.yaml")).toBe(GROWTH_GENERATED_KEY);
    expect(classifyPath("api/package-lock.json")).toBe(GROWTH_GENERATED_KEY);
    expect(classifyPath("Cargo.lock")).toBe(GROWTH_GENERATED_KEY);
    expect(classifyPath("packages/client/dist/index.js")).toBe(GROWTH_GENERATED_KEY);
    expect(classifyPath("vendor/lib.go")).toBe(GROWTH_GENERATED_KEY);
    expect(classifyPath("static/app.min.js")).toBe(GROWTH_GENERATED_KEY);
    expect(classifyPath("static/app.js.map")).toBe(GROWTH_GENERATED_KEY);
    expect(classifyPath("src/__snapshots__/x.test.ts.snap")).toBe(GROWTH_GENERATED_KEY);
  });

  it("does not treat a source directory that merely contains 'build' as generated", () => {
    expect(classifyPath("tools/app/build-payload.mjs")).toBe(".mjs");
  });
});

describe("languageOf", () => {
  it("folds sibling extensions into one language", () => {
    expect(languageOf(".ts")).toBe("TypeScript");
    expect(languageOf(".tsx")).toBe("TypeScript");
    expect(languageOf(".mjs")).toBe("JavaScript");
    expect(languageOf(".yml")).toBe("YAML");
    expect(languageOf("Dockerfile")).toBe("Docker");
  });

  it("names the reserved buckets", () => {
    expect(languageOf(GROWTH_GENERATED_KEY)).toBe("Generated");
    expect(languageOf(GROWTH_NO_EXT_KEY)).toBe("(no extension)");
  });

  it("lets an unlisted extension stand for itself", () => {
    expect(languageOf(".weird")).toBe(".weird");
    expect(extensionLabel(".weird")).toBe(".weird");
  });
});
