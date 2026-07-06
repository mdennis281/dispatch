import { describe, it, expect } from "vitest";
import { zipSync, unzipSync, crc32, type ZipEntry } from "./zip.js";

describe("zip — round-trip", () => {
  it("round-trips a set of files (nested dirs, unicode, binary)", () => {
    const entries: ZipEntry[] = [
      { path: "project.yaml", data: Buffer.from("name: Hivebreak\n", "utf8") },
      { path: "memory/deploy-runbook.md", data: Buffer.from("# runbook — ✅\n", "utf8") },
      { path: "memory/MEMORY.md", data: Buffer.from("# Project memory\n", "utf8") },
      { path: "bin.dat", data: Buffer.from([0, 1, 2, 255, 254, 0, 128]) },
    ];
    const zip = zipSync(entries);
    const back = unzipSync(zip);
    expect(back.map((e) => e.path).sort()).toEqual(
      ["bin.dat", "memory/MEMORY.md", "memory/deploy-runbook.md", "project.yaml"].sort(),
    );
    for (const orig of entries) {
      const got = back.find((e) => e.path === orig.path)!;
      expect(got.data.equals(orig.data)).toBe(true);
    }
  });

  it("round-trips an empty file and a large compressible file", () => {
    const big = Buffer.from("ab".repeat(50_000), "utf8");
    const entries: ZipEntry[] = [
      { path: "empty.txt", data: Buffer.alloc(0) },
      { path: "big.txt", data: big },
    ];
    const zip = zipSync(entries);
    // The compressible file should actually shrink (deflate chosen).
    expect(zip.length).toBeLessThan(big.length);
    const back = unzipSync(zip);
    expect(back.find((e) => e.path === "empty.txt")!.data.length).toBe(0);
    expect(back.find((e) => e.path === "big.txt")!.data.equals(big)).toBe(true);
  });

  it("normalizes backslash paths to forward slashes", () => {
    const zip = zipSync([{ path: "memory\\a.md", data: Buffer.from("x") }]);
    expect(unzipSync(zip)[0]!.path).toBe("memory/a.md");
  });

  it("crc32 matches a known vector", () => {
    // CRC-32 of "123456789" is 0xCBF43926.
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("throws on a non-zip buffer", () => {
    expect(() => unzipSync(Buffer.from("not a zip at all"))).toThrow(/zip/i);
  });
});
