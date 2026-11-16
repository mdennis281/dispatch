import { describe, expect, it } from "vitest";
import { planEviction, summarizeUsage, type ArtifactCacheEntry } from "./artifactCache.js";

const NOW = 1_000_000;

function entry(over: Partial<ArtifactCacheEntry> & { key: string }): ArtifactCacheEntry {
  return {
    kind: "content",
    projectId: "p1",
    chatId: "c1",
    artifactId: "a1",
    version: 1,
    bytes: 10,
    lastUsed: NOW - 100,
    expiresAt: NOW + 1_000,
    ...over,
  };
}

const unlimited = { totalMaxBytes: Infinity, projectMaxBytes: () => Infinity };

describe("planEviction", () => {
  it("drops what has expired whatever the budget — the server deleted the original", () => {
    const keys = planEviction(
      [entry({ key: "old", expiresAt: NOW }), entry({ key: "fresh" })],
      unlimited,
      NOW,
    );
    expect(keys).toEqual(["old"]);
  });

  it("evicts least recently used first until the total fits", () => {
    const keys = planEviction(
      [
        entry({ key: "newest", lastUsed: NOW - 1 }),
        entry({ key: "oldest", lastUsed: NOW - 300 }),
        entry({ key: "middle", lastUsed: NOW - 200 }),
      ],
      { totalMaxBytes: 15, projectMaxBytes: () => Infinity },
      NOW,
    );
    expect(keys).toEqual(["oldest", "middle"]);
  });

  it("holds a project to its own cap without touching another project", () => {
    const keys = planEviction(
      [
        entry({ key: "p1-old", projectId: "p1", lastUsed: NOW - 500 }),
        entry({ key: "p1-new", projectId: "p1", lastUsed: NOW - 1 }),
        entry({ key: "p2-oldest", projectId: "p2", lastUsed: NOW - 900 }),
      ],
      { totalMaxBytes: Infinity, projectMaxBytes: (p) => (p === "p1" ? 10 : Infinity) },
      NOW,
    );
    // p2's row is older than anything in p1 and survives: p1's cap is p1's problem.
    expect(keys).toEqual(["p1-old"]);
  });

  it("counts a project's evictions toward the total, so it doesn't evict twice", () => {
    const keys = planEviction(
      [
        entry({ key: "a", projectId: "p1", lastUsed: NOW - 500 }),
        entry({ key: "b", projectId: "p2", lastUsed: NOW - 400 }),
        entry({ key: "c", projectId: "p1", lastUsed: NOW - 1 }),
      ],
      { totalMaxBytes: 20, projectMaxBytes: (p) => (p === "p1" ? 10 : Infinity) },
      NOW,
    );
    expect(keys).toEqual(["a"]);
  });

  it("evicts everything when the cache is turned off (0 MB)", () => {
    const keys = planEviction(
      [entry({ key: "x" }), entry({ key: "y" })],
      { totalMaxBytes: 0, projectMaxBytes: () => 0 },
      NOW,
    );
    expect(keys.sort()).toEqual(["x", "y"]);
  });
});

describe("summarizeUsage", () => {
  it("breaks bytes down by project then chat, largest first, counting versions and artifacts apart", () => {
    const u = summarizeUsage([
      entry({ key: "c|c1|a1|1", bytes: 5 }),
      entry({ key: "c|c1|a1|2", version: 2, bytes: 5 }),
      entry({ key: "b|x", kind: "blob", bytes: 100, artifactId: undefined, version: undefined }),
      entry({ key: "c|c2|a9|1", chatId: "c2", artifactId: "a9", bytes: 1 }),
      entry({ key: "c|c3|a3|1", projectId: "p2", chatId: "c3", artifactId: "a3", bytes: 7 }),
    ]);
    expect(u.bytes).toBe(118);
    expect(u.entries).toBe(5);
    expect(u.projects.map((p) => [p.projectId, p.bytes])).toEqual([
      ["p1", 111],
      ["p2", 7],
    ]);
    expect(u.projects[0]!.chats[0]).toEqual({ chatId: "c1", bytes: 110, versions: 2, artifacts: 1, blobs: 1 });
    expect(u.projects[0]!.chats[1]!.chatId).toBe("c2");
  });
});
