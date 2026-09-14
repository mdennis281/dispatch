import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ClaudeMemoryService, ClaudeMemoryError, claudeProjectSlug } from "./claude-memory.js";

// Platform-rooted, so the slug is computed from a real absolute path on Linux CI too.
const REPO = process.platform === "win32" ? "C:\\Users\\me\\repo" : "/home/me/repo";

let root: string;
let memDir: string;
let service: ClaudeMemoryService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cm-claude-memory-"));
  service = new ClaudeMemoryService({ claudeRoot: root });
  memDir = service.dir(REPO);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function seed(): Promise<void> {
  await mkdir(memDir, { recursive: true });
  await writeFile(
    join(memDir, "MEMORY.md"),
    "# Memory index\n\n- [Alpha](alpha.md) — first\n- [Beta](beta.md) — second\n",
  );
  await writeFile(
    join(memDir, "alpha.md"),
    "---\nname: alpha\ndescription: the first\nmetadata:\n  type: project\n---\n\nAlpha body.\n",
  );
  await writeFile(join(memDir, "beta.md"), "---\nname: beta\ndescription: the second\ntype: user\n---\nBeta body.\n");
}

describe("ClaudeMemoryService", () => {
  it("slugs a repo path the way Claude Code does", () => {
    expect(claudeProjectSlug("C:\\Users\\Michael\\projects\\claude-manager")).toBe(
      "C--Users-Michael-projects-claude-manager",
    );
  });

  it("reports a missing dir without failing", async () => {
    const listing = await service.list(REPO);
    expect(listing.exists).toBe(false);
    expect(listing.files).toEqual([]);
  });

  it("lists the index first and reads type from frontmatter or metadata", async () => {
    await seed();
    const { files } = await service.list(REPO);
    expect(files.map((f) => f.file)).toEqual(["MEMORY.md", "alpha.md", "beta.md"]);
    expect(files[0]!.isIndex).toBe(true);
    expect(files[1]).toMatchObject({ name: "alpha", description: "the first", type: "project", body: "Alpha body." });
    expect(files[2]!.type).toBe("user");
  });

  it("edits an existing file but never creates one", async () => {
    await seed();
    const saved = await service.write(REPO, "alpha.md", "---\nname: alpha\ndescription: edited\n---\nNew.\n");
    expect(saved.description).toBe("edited");
    await expect(service.write(REPO, "nope.md", "x")).rejects.toThrow(ClaudeMemoryError);
    expect(existsSync(join(memDir, "nope.md"))).toBe(false);
  });

  it("deletes a file and drops its index pointer", async () => {
    await seed();
    await service.delete(REPO, "alpha.md");
    expect(existsSync(join(memDir, "alpha.md"))).toBe(false);
    const index = await readFile(join(memDir, "MEMORY.md"), "utf8");
    expect(index).not.toContain("alpha.md");
    expect(index).toContain("beta.md");
  });

  it("refuses traversal and deleting the index", async () => {
    await seed();
    await expect(service.delete(REPO, "../escape.md")).rejects.toThrow(ClaudeMemoryError);
    await expect(service.write(REPO, "..\\escape.md", "x")).rejects.toThrow(ClaudeMemoryError);
    await expect(service.delete(REPO, "MEMORY.md")).rejects.toThrow(/index/);
  });
});
