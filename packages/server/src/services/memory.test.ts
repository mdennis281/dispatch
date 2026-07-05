import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import type { WsServerEvent } from "@cm/shared";
import { MemoryService } from "./memory.js";

let dir: string;
let store: Store;
let bus: EventBus;
let events: WsServerEvent[];
let memory: MemoryService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-memory-"));
  store = new Store(dir);
  await store.init();
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  let clock = 1000;
  memory = new MemoryService({ store, bus, now: () => ++clock });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Read the generated MEMORY.md index for a project (or "" when absent). */
async function indexFile(projectId: string): Promise<string> {
  const path = join(store.projectMemoryDir(projectId), "MEMORY.md");
  return existsSync(path) ? readFile(path, "utf8") : "";
}

describe("MemoryService — create / read / list", () => {
  it("writes a memory file + index and reads it back with frontmatter intact", async () => {
    const saved = await memory.write("p1", {
      name: "deploy-runbook",
      description: "How we ship to prod",
      type: "project",
      body: "Run `pnpm ship`, wait for CI, the bot merges.",
    });
    expect(saved).toMatchObject({
      projectId: "p1",
      name: "deploy-runbook",
      type: "project",
      file: "deploy-runbook.md",
    });

    const list = await memory.list("p1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: "deploy-runbook",
      description: "How we ship to prod",
      body: "Run `pnpm ship`, wait for CI, the bot merges.",
    });

    const single = await memory.read("p1", "deploy-runbook");
    expect(single?.body).toContain("pnpm ship");

    // The generated index has one line for the memory.
    expect(await indexFile("p1")).toContain("- [deploy-runbook](deploy-runbook.md) — How we ship to prod");

    // A memory-update event fired.
    expect(events.some((e) => e.type === "memory-update" && e.memory.name === "deploy-runbook")).toBe(true);
  });

  it("slugifies a free-text name and dedupes by slug (update, not duplicate)", async () => {
    await memory.write("p1", { name: "My Cool Fact", description: "v1", type: "user", body: "first" });
    // A name that slugs to the SAME identity updates in place.
    await memory.write("p1", { name: "my cool fact", description: "v2", type: "feedback", body: "second" });

    const list = await memory.list("p1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: "my-cool-fact",
      description: "v2",
      type: "feedback",
      body: "second",
    });
  });

  it("rejects an empty / punctuation-only name", async () => {
    await expect(memory.write("p1", { name: "  ", description: "x", type: "project", body: "b" })).rejects.toBeTruthy();
    await expect(memory.write("p1", { name: "!!!", description: "x", type: "project", body: "b" })).rejects.toBeTruthy();
  });

  it("scopes memories per project", async () => {
    await memory.write("p1", { name: "a", description: "", type: "project", body: "in p1" });
    await memory.write("p2", { name: "b", description: "", type: "project", body: "in p2" });
    expect((await memory.list("p1")).map((m) => m.name)).toEqual(["a"]);
    expect((await memory.list("p2")).map((m) => m.name)).toEqual(["b"]);
  });
});

describe("MemoryService — delete + index regen", () => {
  it("deletes a memory, regenerates the index, and emits memory-deleted", async () => {
    await memory.write("p1", { name: "keep", description: "stays", type: "project", body: "1" });
    await memory.write("p1", { name: "drop", description: "goes", type: "project", body: "2" });

    // Index lists both, sorted by name.
    const before = await indexFile("p1");
    expect(before).toContain("[drop](drop.md)");
    expect(before).toContain("[keep](keep.md)");
    expect(before.indexOf("drop")).toBeLessThan(before.indexOf("keep"));

    const removed = await memory.delete("p1", "drop");
    expect(removed).toBe(true);

    const list = await memory.list("p1");
    expect(list.map((m) => m.name)).toEqual(["keep"]);
    // Index no longer lists the deleted memory.
    expect(await indexFile("p1")).not.toContain("drop.md");

    expect(events.some((e) => e.type === "memory-deleted" && e.name === "drop")).toBe(true);
  });

  it("delete of a missing memory returns false (no event)", async () => {
    expect(await memory.delete("p1", "ghost")).toBe(false);
    expect(events.some((e) => e.type === "memory-deleted")).toBe(false);
  });
});

describe("MemoryService — injection + recall", () => {
  it("buildInjection returns null for an empty project and the index+descriptions when populated", async () => {
    expect(await memory.buildInjection("p1")).toBeNull();

    await memory.write("p1", { name: "one", description: "first fact", type: "project", body: "body 1" });
    await memory.write("p1", { name: "two", description: "second fact", type: "reference", body: "body 2" });

    const injection = await memory.buildInjection("p1");
    expect(injection).toBeTruthy();
    expect(injection).toContain("Project memory");
    expect(injection).toContain("**one** (project) — first fact");
    expect(injection).toContain("**two** (reference) — second fact");
    // Bounded — the full body is NOT injected.
    expect(injection).not.toContain("body 1");
    expect(injection).toContain("mcp__manager__recall");
  });

  it("recall returns the index with no query and matching bodies with a query", async () => {
    await memory.write("p1", { name: "alpha", description: "about the build", type: "project", body: "BUILD DETAIL" });
    await memory.write("p1", { name: "beta", description: "about deploys", type: "project", body: "DEPLOY DETAIL" });

    const all = await memory.recall("p1");
    expect(all.matches).toHaveLength(0);
    expect(all.index).toContain("[alpha](alpha.md)");

    const hit = await memory.recall("p1", "deploy");
    expect(hit.matches.map((m) => m.name)).toEqual(["beta"]);
    expect(hit.matches[0]?.body).toBe("DEPLOY DETAIL");
  });
});
