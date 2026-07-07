import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
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
    // Grouped by type, one-line per memory (name + description).
    expect(injection).toContain("`one` — first fact");
    expect(injection).toContain("`two` — second fact");
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

  it("ranks matches: a name hit outranks a body-only hit", async () => {
    await memory.write("p1", { name: "deploy-runbook", description: "shipping steps", type: "project", body: "steps" });
    await memory.write("p1", { name: "misc", description: "notes", type: "project", body: "mentions deploy once" });

    const ranked = await memory.search("p1", "deploy");
    expect(ranked.map((m) => m.name)).toEqual(["deploy-runbook", "misc"]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("expandLinks pulls in [[wikilink]] neighbours of a match (marked linked)", async () => {
    await memory.write("p1", { name: "auth-flow", description: "how auth works", type: "project", body: "see [[token-store]]" });
    await memory.write("p1", { name: "token-store", description: "where tokens live", type: "project", body: "redis" });

    const ranked = await memory.search("p1", "auth", { expandLinks: true });
    const byName = new Map(ranked.map((m) => [m.name, m]));
    expect(byName.has("auth-flow")).toBe(true);
    expect(byName.get("token-store")?.linked).toBe(true);
  });

  it("recall can restrict to one type", async () => {
    await memory.write("p1", { name: "pref-x", description: "wants tabs", type: "user", body: "tabs" });
    await memory.write("p1", { name: "fact-x", description: "uses tabs", type: "project", body: "tabs" });

    const hit = await memory.recall("p1", "tabs", { type: "user" });
    expect(hit.matches.map((m) => m.name)).toEqual(["pref-x"]);
  });

  it("surfaceFor returns a system-reminder block once per memory (respects exclude)", async () => {
    await memory.write("p1", { name: "deploy-runbook", description: "how we ship to prod", type: "project", body: "run the pipeline" });

    const first = await memory.surfaceFor("p1", "how do we deploy to prod?");
    expect(first).not.toBeNull();
    expect(first!.block).toContain("<system-reminder>");
    expect(first!.block).toContain("run the pipeline");
    expect(first!.names).toEqual(["deploy-runbook"]);

    // Already surfaced → excluded → nothing to push again.
    const again = await memory.surfaceFor("p1", "how do we deploy to prod?", {
      exclude: new Set(first!.names),
    });
    expect(again).toBeNull();
  });

  it("surfaceFor stays quiet for an irrelevant turn", async () => {
    await memory.write("p1", { name: "deploy-runbook", description: "how we ship to prod", type: "project", body: "pipeline" });
    expect(await memory.surfaceFor("p1", "what colour is the sky")).toBeNull();
  });

  it("persists updatedAt into the frontmatter and reads it back", async () => {
    const written = await memory.write("p1", { name: "stamped", description: "d", type: "project", body: "b" });
    expect(written.updatedAt).toBeTypeOf("number");
    const reread = await memory.read("p1", "stamped");
    expect(reread?.updatedAt).toBe(written.updatedAt);
  });
});

describe("MemoryService — .claude-manager/ config dir source of truth", () => {
  // Project "cfg" has a config dir → memory lives in the repo memory dir;
  // project "plain" has none → back-compat `.data` store.
  let repoMemoryDir: string;
  let cfgMemory: MemoryService;

  beforeEach(() => {
    repoMemoryDir = join(dir, "repo", ".claude-manager", "memory");
    const resolver = {
      getConfig: (projectId: string) =>
        projectId === "cfg" ? { memoryDir: repoMemoryDir } : null,
    };
    let clock = 2000;
    cfgMemory = new MemoryService({ store, bus, now: () => ++clock, projectConfig: resolver });
  });

  it("writes a config-dir project's memory into the repo dir (+ index) — not .data — and injection reflects it", async () => {
    await cfgMemory.write("cfg", {
      name: "repo-fact",
      description: "lives in the repo",
      type: "project",
      body: "REPO BODY",
    });

    // The `.md` + regenerated `MEMORY.md` land in the REPO dir…
    expect(existsSync(join(repoMemoryDir, "repo-fact.md"))).toBe(true);
    const idx = await readFile(join(repoMemoryDir, "MEMORY.md"), "utf8");
    expect(idx).toContain("- [repo-fact](repo-fact.md) — lives in the repo");
    // …and NOT in the legacy `.data` store.
    expect(existsSync(join(store.projectMemoryDir("cfg"), "repo-fact.md"))).toBe(false);

    // Reads + injection route through the repo dir too.
    expect((await cfgMemory.read("cfg", "repo-fact"))?.body).toBe("REPO BODY");
    const injection = await cfgMemory.buildInjection("cfg");
    expect(injection).toContain("`repo-fact` — lives in the repo");

    // The memory-update event fired as usual (client sees no difference).
    expect(events.some((e) => e.type === "memory-update" && e.memory.name === "repo-fact")).toBe(true);
  });

  it("forget removes a config-dir memory from the repo dir + regenerates the index", async () => {
    await cfgMemory.write("cfg", { name: "keep", description: "stays", type: "project", body: "1" });
    await cfgMemory.write("cfg", { name: "drop", description: "goes", type: "project", body: "2" });
    expect(existsSync(join(repoMemoryDir, "drop.md"))).toBe(true);

    expect(await cfgMemory.delete("cfg", "drop")).toBe(true);
    expect(existsSync(join(repoMemoryDir, "drop.md"))).toBe(false);
    const idx = await readFile(join(repoMemoryDir, "MEMORY.md"), "utf8");
    expect(idx).not.toContain("drop.md");
    expect(idx).toContain("keep.md");
    expect(events.some((e) => e.type === "memory-deleted" && e.name === "drop")).toBe(true);
  });

  it("a project WITHOUT a config dir still uses the .data store (back-compat)", async () => {
    await cfgMemory.write("plain", { name: "legacy-home", description: "d", type: "project", body: "b" });
    expect(existsSync(join(store.projectMemoryDir("plain"), "legacy-home.md"))).toBe(true);
    expect(existsSync(join(repoMemoryDir, "legacy-home.md"))).toBe(false);
  });

  it("migrates legacy .data memories into the repo dir, idempotently, without deleting the originals", async () => {
    // Seed a legacy `.data` memory via the plain (config-less) service.
    await memory.write("cfg", { name: "legacy", description: "from .data", type: "project", body: "LEGACY BODY" });
    const legacyPath = join(store.projectMemoryDir("cfg"), "legacy.md");
    expect(existsSync(legacyPath)).toBe(true);

    events.length = 0;
    await cfgMemory.migrateProject("cfg");

    // Copied into the repo dir (+ index regenerated) …
    expect(existsSync(join(repoMemoryDir, "legacy.md"))).toBe(true);
    expect((await cfgMemory.read("cfg", "legacy"))?.body).toBe("LEGACY BODY");
    expect(await readFile(join(repoMemoryDir, "MEMORY.md"), "utf8")).toContain("[legacy](legacy.md)");
    // … the legacy original is left in place …
    expect(existsSync(legacyPath)).toBe(true);
    // … and a memory-update fired so open UIs refresh.
    expect(events.some((e) => e.type === "memory-update" && e.memory.name === "legacy")).toBe(true);

    // Idempotent: re-running does NOT clobber a repo copy that has since diverged.
    await writeFile(
      join(repoMemoryDir, "legacy.md"),
      "---\nname: legacy\ndescription: edited in repo\ntype: project\n---\n\nEDITED BODY\n",
      "utf8",
    );
    await cfgMemory.migrateProject("cfg");
    expect((await cfgMemory.read("cfg", "legacy"))?.body).toBe("EDITED BODY");
  });

  it("migrateProject is a no-op for a project without a config dir", async () => {
    await memory.write("plain", { name: "x", description: "d", type: "project", body: "b" });
    // Should neither throw nor create anything under a (non-existent) repo dir.
    await cfgMemory.migrateProject("plain");
    expect(existsSync(join(dir, "plain-repo"))).toBe(false);
  });

  it("copies every legacy memory but skips ones already present in the repo dir", async () => {
    await memory.write("cfg", { name: "a", description: "da", type: "project", body: "A" });
    await memory.write("cfg", { name: "b", description: "db", type: "project", body: "B" });
    // Pre-seed one of them in the repo dir with a divergent body.
    await mkdir(repoMemoryDir, { recursive: true });
    await writeFile(
      join(repoMemoryDir, "a.md"),
      "---\nname: a\ndescription: repo wins\ntype: project\n---\n\nREPO A\n",
      "utf8",
    );

    await cfgMemory.migrateProject("cfg");

    // "b" copied fresh; "a" kept the pre-existing repo version.
    expect((await cfgMemory.read("cfg", "b"))?.body).toBe("B");
    expect((await cfgMemory.read("cfg", "a"))?.body).toBe("REPO A");
  });
});
