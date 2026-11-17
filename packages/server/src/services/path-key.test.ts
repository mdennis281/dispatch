import { describe, expect, it } from "vitest";
import { pathKey, pathKeyOn } from "./path-key.js";

const same = (platform: NodeJS.Platform, a: string, b: string) => pathKeyOn(platform, a) === pathKeyOn(platform, b);

describe("pathKeyOn", () => {
  it("on Windows ignores separator flavour, case and a trailing slash", () => {
    expect(same("win32", "C:\\a\\b", "c:/a/b/")).toBe(true);
    expect(same("win32", "C:\\a\\b", "C:\\a\\bc")).toBe(false);
  });

  it("on Linux ignores a trailing slash but NOT case — those are two directories", () => {
    expect(same("linux", "/repo/app", "/repo/app///")).toBe(true);
    expect(same("linux", "/repo/App", "/repo/app")).toBe(false);
  });

  it("on macOS folds case, as the default APFS volume does", () => {
    expect(same("darwin", "/Users/x/Proj/wt", "/Users/x/proj/wt/")).toBe(true);
    expect(same("darwin", "/Users/x/Proj/wt", "/Users/x/Proj/wt2")).toBe(false);
  });

  it("resolves `.` and `..` segments before comparing", () => {
    expect(same("linux", "/repo/a/../b", "/repo/b")).toBe(true);
    expect(same("win32", "C:\\repo\\.\\b", "C:\\repo\\b")).toBe(true);
  });

  it("keeps the POSIX root and a Windows drive root comparable", () => {
    expect(pathKeyOn("linux", "/")).toBe("/");
    expect(same("win32", "C:\\", "c:/")).toBe(true);
  });

  it("does not hang on a long run of separators", () => {
    const start = Date.now();
    pathKeyOn("linux", "/a" + "/".repeat(50_000));
    pathKeyOn("win32", "C:\\a" + "\\".repeat(50_000));
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});

describe("pathKey", () => {
  it("is safe to pass point-free to Array.map — the index is not a platform", () => {
    const paths = ["/x/A", "/x/B"];
    expect(paths.map(pathKey)).toEqual(paths.map((p) => pathKey(p)));
  });
});
