import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_VERSIONS,
  ARTIFACT_READ_CONTENT_MAX,
  ARTIFACT_STORAGE_MAX_CHARS,
  parseArtifactRef,
} from "@dispatch/shared";
import { ArtifactError, ArtifactService } from "./artifacts.js";
import { createArtifactTools, type ManagerMcpArtifacts } from "./mcp/artifact-tools.js";

const DAY = 24 * 60 * 60_000;

let root: string;
let clock: number;
let svc: ArtifactService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "artifacts-"));
  clock = 1_000_000;
  svc = new ArtifactService({
    dirFor: (chatId) => join(root, chatId, "artifacts"),
    blobDirFor: (chatId) => join(root, chatId, "artifact-blobs"),
    now: () => clock,
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ArtifactService", () => {
  it("creates version 1 and reads it back", async () => {
    const meta = await svc.create("c1", { title: "  Chart \n demo ", type: "html", content: "<p>hi</p>" });
    expect(meta.title).toBe("Chart demo");
    expect(meta.versions).toEqual([{ n: 1, createdAt: clock, size: 9 }]);
    const got = await svc.read("c1", meta.id);
    expect(got).toMatchObject({ version: 1, content: "<p>hi</p>", errors: [] });
  });

  it("an exact-match edit makes a new version and keeps the old one readable", async () => {
    const { id } = await svc.create("c1", { title: "t", type: "markdown", content: "# One\nbody" });
    clock += 10;
    const meta = await svc.update("c1", id, { edit: { oldStr: "One", newStr: "Two" } });
    expect(meta.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(meta.updatedAt).toBe(clock);
    expect((await svc.read("c1", id)).content).toBe("# Two\nbody");
    expect((await svc.read("c1", id, 1)).content).toBe("# One\nbody");
  });

  it("refuses an edit whose old string is missing or ambiguous, and cuts no version", async () => {
    const { id } = await svc.create("c1", { title: "t", type: "code", language: "ts", content: "a a" });
    await expect(svc.update("c1", id, { edit: { oldStr: "zzz", newStr: "b" } })).rejects.toThrow(/does not occur/);
    await expect(svc.update("c1", id, { edit: { oldStr: "a", newStr: "b" } })).rejects.toThrow(/more than once/);
    expect((await svc.getMeta("c1", id))!.versions).toHaveLength(1);
  });

  it("serializes concurrent edits so neither reverts the other", async () => {
    const { id } = await svc.create("c1", { title: "t", type: "markdown", content: "A B" });
    await Promise.all([
      svc.update("c1", id, { edit: { oldStr: "A", newStr: "x" } }),
      svc.update("c1", id, { edit: { oldStr: "B", newStr: "y" } }),
    ]);
    expect((await svc.read("c1", id)).content).toBe("x y");
  });

  it("refuses content past the size limit", async () => {
    await expect(
      svc.create("c1", { title: "t", type: "html", content: "x".repeat(ARTIFACT_MAX_BYTES + 1) }),
    ).rejects.toBeInstanceOf(ArtifactError);
  });

  it("drops the OLDEST versions past the cap, files included", async () => {
    const { id } = await svc.create("c1", { title: "t", type: "markdown", content: "v1" });
    for (let i = 2; i <= ARTIFACT_MAX_VERSIONS + 2; i++) await svc.update("c1", id, { content: `v${i}` });
    const meta = (await svc.getMeta("c1", id))!;
    expect(meta.versions).toHaveLength(ARTIFACT_MAX_VERSIONS);
    expect(meta.versions[0]!.n).toBe(3);
    const files = await readdir(join(root, "c1", "artifacts", id));
    expect(files).not.toContain("v1.md");
    expect(files).toContain(`v${ARTIFACT_MAX_VERSIONS + 2}.md`);
  });

  it("rejects an id that could escape the artifacts dir", async () => {
    await expect(svc.read("c1", "../../etc")).rejects.toMatchObject({ code: "invalid" });
    await expect(svc.read("c1", "a/b")).rejects.toMatchObject({ code: "invalid" });
  });

  it("lists newest edit first and ignores stray entries", async () => {
    const a = await svc.create("c1", { title: "a", type: "html", content: "a" });
    clock += 5;
    const b = await svc.create("c1", { title: "b", type: "html", content: "b" });
    clock += 5;
    await svc.update("c1", a.id, { content: "a2" });
    await writeFile(join(root, "c1", "artifacts", "stray.txt"), "x");
    expect((await svc.list("c1")).map((m) => m.id)).toEqual([a.id, b.id]);
    expect(await svc.list("nochat")).toEqual([]);
  });

  it("records runtime errors per version, deduped and bounded", async () => {
    const { id } = await svc.create("c1", { title: "t", type: "html", content: "x" });
    svc.recordErrors("c1", id, 1, ["boom", "boom", " ", "bang"]);
    expect(svc.errorsFor("c1", id, 1)).toEqual(["boom", "bang"]);
    expect(svc.errorsFor("c1", id, 2)).toEqual([]);
    expect((await svc.read("c1", id)).errors).toEqual(["boom", "bang"]);
  });

  it("sweep expires content older than the window by LAST EDIT, keeping the meta", async () => {
    const old = await svc.create("c1", { title: "old", type: "html", content: "old" });
    const fresh = await svc.create("c1", { title: "fresh", type: "html", content: "fresh" });
    clock += 8 * DAY;
    await svc.update("c1", fresh.id, { content: "fresh2" });
    const report = await svc.sweep(["c1", "c2"], 7 * DAY);
    expect(report).toMatchObject({ artifacts: 1, chats: 1 });
    expect(report.bytes).toBe(3);

    const expired = (await svc.getMeta("c1", old.id))!;
    expect(expired.expiredAt).toBe(clock);
    expect(await readdir(join(root, "c1", "artifacts", old.id))).toEqual(["meta.json"]);
    await expect(svc.read("c1", old.id)).rejects.toMatchObject({ code: "expired", expiredAt: clock });
    expect((await svc.read("c1", fresh.id)).content).toBe("fresh2");

    // Already expired → not counted again.
    expect((await svc.sweep(["c1"], 7 * DAY)).artifacts).toBe(0);
  });

  it("sweep spares an artifact edited after the candidate list was taken", async () => {
    const a = await svc.create("c1", { title: "a", type: "html", content: "a" });
    clock += 8 * DAY;
    // Hold the edit until the sweep has listed `a` as stale, then let it land
    // before the sweep takes the artifact's lock.
    const realList = svc.list.bind(svc);
    let edited: Promise<unknown> = Promise.resolve();
    svc.list = async (chatId: string) => {
      const snapshot = await realList(chatId);
      edited = svc.update("c1", a.id, { content: "fresh" });
      await edited;
      return snapshot;
    };
    const report = await svc.sweep(["c1"], 7 * DAY);
    await edited;
    expect(report.artifacts).toBe(0);
    expect((await svc.read("c1", a.id)).content).toBe("fresh");
  });
});

describe("artifact storage", () => {
  it("round-trips, applies clear BEFORE set, and removes on null", async () => {
    const { id } = await svc.create("c1", { title: "game", type: "html", content: "x" });
    expect(await svc.readStorage("c1", id)).toEqual({ entries: {}, chars: 0 });
    await svc.writeStorage("c1", id, { set: { save: "1", opts: "a" } });
    await svc.writeStorage("c1", id, { clear: true, set: { save: "2" } });
    expect((await svc.readStorage("c1", id)).entries).toEqual({ save: "2" });
    const after = await svc.writeStorage("c1", id, { set: { save: null } });
    expect(after).toEqual({ entries: {}, chars: 0 });
    // Empty storage leaves no file behind.
    expect(await readdir(join(root, "c1", "artifacts", id))).not.toContain("storage.json");
  });

  it("is shared by every version — a save survives the agent editing the game", async () => {
    const { id } = await svc.create("c1", { title: "game", type: "html", content: "v1" });
    await svc.writeStorage("c1", id, { set: { save: "level 4" } });
    await svc.update("c1", id, { content: "v2" });
    expect((await svc.readStorage("c1", id)).entries).toEqual({ save: "level 4" });
  });

  it("refuses a batch past the quota WHOLE, leaving the old save intact", async () => {
    const { id } = await svc.create("c1", { title: "game", type: "html", content: "x" });
    await svc.writeStorage("c1", id, { set: { save: "ok" } });
    await expect(
      svc.writeStorage("c1", id, { set: { other: "fine", big: "x".repeat(ARTIFACT_STORAGE_MAX_CHARS) } }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect((await svc.readStorage("c1", id)).entries).toEqual({ save: "ok" });
  });

  it("goes with the content when retention expires the artifact", async () => {
    const { id } = await svc.create("c1", { title: "game", type: "html", content: "x" });
    await svc.writeStorage("c1", id, { set: { save: "1" } });
    clock += 8 * DAY;
    await svc.sweep(["c1"], 7 * DAY);
    expect(await readdir(join(root, "c1", "artifacts", id))).toEqual(["meta.json"]);
    await expect(svc.readStorage("c1", id)).rejects.toMatchObject({ code: "expired" });
    await expect(svc.writeStorage("c1", id, { set: { save: "2" } })).rejects.toMatchObject({ code: "expired" });
  });
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("artifact assets", () => {
  async function files(spec: Record<string, string>): Promise<Array<{ path: string; file: string }>> {
    const dir = await mkdtemp(join(root, "src-"));
    const out = [];
    for (const [path, body] of Object.entries(spec)) {
      const file = join(dir, ...path.split("/"));
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, body);
      out.push({ path, file });
    }
    return out;
  }
  const blobs = async () => (await readdir(join(root, "c1", "artifact-blobs")).catch(() => [])).sort();

  it("stores each file once by content hash and records the manifest on the version", async () => {
    const meta = await svc.create("c1", {
      title: "Game",
      type: "html",
      content: "<canvas>",
      assets: await files({ "textures/a.png": "AAA", "./copy-of-a.png": "AAA", "level.json": "{}" }),
    });
    expect(meta.versions[0]!.assets).toEqual({
      "textures/a.png": { sha256: sha("AAA"), size: 3, type: "image/png" },
      "copy-of-a.png": { sha256: sha("AAA"), size: 3, type: "image/png" },
      "level.json": { sha256: sha("{}"), size: 2, type: "application/json" },
    });
    // Two paths, same bytes: one blob.
    expect(await blobs()).toEqual([sha("AAA"), sha("{}")].sort());
    const got = await svc.read("c1", meta.id);
    expect(got.assets?.["level.json"]?.sha256).toBe(sha("{}"));
    expect(svc.blobPath("c1", sha("AAA"))).toBe(join(root, "c1", "artifact-blobs", sha("AAA")));
  });

  it("carries assets forward through an edit, replaces them on request, and drops them on null", async () => {
    const meta = await svc.create("c1", { title: "G", type: "html", content: "v1", assets: await files({ "a.bin": "1" }) });
    // An edit to one line of the page must not orphan its textures.
    await svc.update("c1", meta.id, { edit: { oldStr: "v1", newStr: "v2" } });
    expect((await svc.read("c1", meta.id)).assets).toEqual(meta.versions[0]!.assets);
    await svc.update("c1", meta.id, { content: "v3", assets: await files({ "b.bin": "2" }) });
    expect(Object.keys((await svc.read("c1", meta.id)).assets!)).toEqual(["b.bin"]);
    await svc.update("c1", meta.id, { content: "v4", assets: null });
    expect((await svc.read("c1", meta.id)).assets).toBeUndefined();
    // Old versions keep theirs.
    expect(Object.keys((await svc.read("c1", meta.id, 1)).assets!)).toEqual(["a.bin"]);
  });

  it("refuses paths that leave the bundle, collide, or name no file — before storing anything", async () => {
    const ok = await files({ "a.png": "x" });
    for (const bad of [
      [...ok, { path: "../escape.png", file: ok[0]!.file }],
      [...ok, { path: "./a.png", file: ok[0]!.file }],
      [{ path: "gone.png", file: join(root, "nope.png") }],
    ]) {
      await expect(svc.create("c1", { title: "t", type: "html", content: "p", assets: bad })).rejects.toBeInstanceOf(
        ArtifactError,
      );
    }
    expect(await svc.list("c1")).toEqual([]);
    expect(svc.blobPath("c1", "../../etc/passwd")).toBeNull();
    expect(svc.blobPath("c1", "A".repeat(64))).toBeNull();
  });

  it("refuses assets outright on a store with no blob directory", async () => {
    const bare = new ArtifactService({ dirFor: (chatId) => join(root, chatId, "artifacts") });
    await expect(
      bare.create("c1", { title: "t", type: "html", content: "p", assets: await files({ "a.png": "x" }) }),
    ).rejects.toThrow(/Assets aren't available/);
  });

  it("stamps a stored or reused blob as fresh, whatever the source's mtime", async () => {
    // Before the meta naming them is written, only mtime keeps new blobs from
    // the GC — and Windows copyFile keeps the source's, which may be weeks old.
    clock = Date.now();
    const src = await files({ "old.png": "OLD" });
    const monthAgo = new Date(clock - 30 * DAY);
    await utimes(src[0]!.file, monthAgo, monthAgo);
    await svc.create("c1", { title: "a", type: "html", content: "p", assets: src });
    const blob = join(root, "c1", "artifact-blobs", sha("OLD"));
    expect((await stat(blob)).mtimeMs).toBeGreaterThan(clock - 60_000);
    // A dedup hit on an orphan that already looks old refreshes it too.
    await utimes(blob, monthAgo, monthAgo);
    await svc.create("c1", { title: "b", type: "html", content: "p", assets: src });
    expect((await stat(blob)).mtimeMs).toBeGreaterThan(clock - 60_000);
  });

  it("collects blobs no live version names — but only once they are past the grace period", async () => {
    const meta = await svc.create("c1", { title: "G", type: "html", content: "p", assets: await files({ "a.bin": "old" }) });
    await svc.update("c1", meta.id, { content: "q", assets: await files({ "a.bin": "new" }) });
    // v1 still names "old", so nothing goes.
    clock = Date.now() + 2 * 60 * 60_000;
    expect((await svc.gcBlobs("c1")).files).toBe(0);
    // Once the artifact expires, everything it named is garbage — but a blob
    // written moments ago is spared, since a create stores its blobs before
    // the meta that names them.
    await svc.sweep(["c1"], 1);
    expect(await blobs()).toEqual([]);
    await svc.create("c1", { title: "H", type: "html", content: "p", assets: await files({ "b.bin": "fresh" }) });
    await rm(join(root, "c1", "artifacts"), { recursive: true });
    clock = Date.now();
    expect((await svc.gcBlobs("c1")).files).toBe(0);
    expect(await blobs()).toEqual([sha("fresh")]);
  });
});

describe("artifact tools", () => {
  function bound(cwd?: string, roots: string[] = cwd ? [cwd] : []): ManagerMcpArtifacts {
    return {
      create: (input) => svc.create("c1", input),
      update: (id, change) => svc.update("c1", id, change),
      read: (id, version) => svc.read("c1", id, version),
      list: () => svc.list("c1"),
      ...(cwd ? { cwd } : {}),
      roots: async () => roots,
    };
  }
  const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;
  /** Tool args as an agent sends them: optional keys simply absent. The handler
   *  type spells every key out, which a hand-written call can't satisfy. */
  const run = (def: { handler: (args: never, extra: unknown) => Promise<{ content: unknown[]; isError?: boolean }> }, args: object) =>
    def.handler(args as never, {});

  it("create → update → read round-trips, and each result carries a parseable ref", async () => {
    const tools = createArtifactTools({ artifacts: bound() });
    const created = await run(tools.artifactCreate, { title: "Demo", type: "html", content: "<b>1</b>" });
    expect(created.isError).toBe(false);
    const ref = parseArtifactRef(text(created));
    expect(ref).toMatchObject({ version: 1, title: "Demo", type: "html" });

    const updated = await run(tools.artifactUpdate, { id: ref!.id, old_str: "1", new_str: "2" });
    expect(parseArtifactRef(text(updated))).toMatchObject({ id: ref!.id, version: 2 });

    svc.recordErrors("c1", ref!.id, 2, ["ReferenceError: x is not defined"]);
    const read = await run(tools.artifactRead, { id: ref!.id });
    expect(text(read)).toContain("ReferenceError: x is not defined");
    expect(text(read)).toContain("<b>2</b>");
    expect(parseArtifactRef(text(read))).toBeNull();

    const listed = await run(tools.artifactList, {});
    expect(text(listed)).toContain(ref!.id);
  });

  it("publishes from a path relative to the session cwd", async () => {
    await writeFile(join(root, "page.html"), "<h1>file</h1>");
    const tools = createArtifactTools({ artifacts: bound(root) });
    const res = await run(tools.artifactCreate, { title: "F", type: "html", path: "page.html" });
    const ref = parseArtifactRef(text(res))!;
    expect((await svc.read("c1", ref.id)).content).toBe("<h1>file</h1>");
  });

  it("refuses a path outside the chat's directories, however it is spelled", async () => {
    // The tools are prompt-free and artifact_read returns content to the model,
    // so an unconfined path would be a silent read of the whole disk.
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(root, "secret.txt"), "id_rsa");
    await writeFile(join(repo, "ok.md"), "fine");
    const tools = createArtifactTools({ artifacts: bound(repo) });
    for (const path of [join(root, "secret.txt"), "../secret.txt", `${repo}/../secret.txt`]) {
      const res = await run(tools.artifactCreate, { title: "x", type: "code", path });
      expect(res.isError, path).toBe(true);
      expect(text(res)).toMatch(/outside this chat's working directories/);
    }
    expect(await svc.list("c1")).toEqual([]);
    // A second root (a worktree) is as good as the cwd.
    const wt = join(root, "wt");
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, "w.md"), "from worktree");
    const both = createArtifactTools({ artifacts: bound(repo, [repo, wt]) });
    expect((await run(both.artifactCreate, { title: "w", type: "markdown", path: join(wt, "w.md") })).isError).toBe(false);
    // …and with no roots at all, no path is publishable.
    const none = createArtifactTools({ artifacts: bound(undefined, []) });
    expect((await run(none.artifactCreate, { title: "n", type: "markdown", path: join(repo, "ok.md") })).isError).toBe(true);
  });

  it("refuses a path update that escapes too", async () => {
    const repo = join(root, "repo2");
    await mkdir(repo, { recursive: true });
    await writeFile(join(root, "outside.txt"), "nope");
    const tools = createArtifactTools({ artifacts: bound(repo) });
    const created = await run(tools.artifactCreate, { title: "x", type: "markdown", content: "a" });
    const id = parseArtifactRef(text(created))!.id;
    const res = await run(tools.artifactUpdate, { id, path: "../outside.txt" });
    expect(res.isError).toBe(true);
    expect((await svc.read("c1", id)).content).toBe("a");
  });

  it("refuses ambiguous or empty calls with a readable error", async () => {
    const tools = createArtifactTools({ artifacts: bound() });
    expect((await run(tools.artifactCreate, { title: "x", type: "html" })).isError).toBe(true);
    expect(
      (await run(tools.artifactCreate, { title: "x", type: "html", content: "a", path: "b" })).isError,
    ).toBe(true);
    const created = await run(tools.artifactCreate, { title: "x", type: "html", content: "a" });
    const id = parseArtifactRef(text(created))!.id;
    const none = await run(tools.artifactUpdate, { id });
    expect(none.isError).toBe(true);
    const missing = await run(tools.artifactUpdate, { id, old_str: "zzz", new_str: "q" });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/does not occur/);
  });

  it("bundles assets_dir recursively, skipping .git, node_modules and the page itself", async () => {
    const site = join(root, "site");
    await mkdir(join(site, "img"), { recursive: true });
    await mkdir(join(site, "node_modules", "x"), { recursive: true });
    await mkdir(join(site, ".git"), { recursive: true });
    await writeFile(join(site, "index.html"), '<img src="img/a.png">');
    await writeFile(join(site, "img", "a.png"), "PNG");
    await writeFile(join(site, "node_modules", "x", "i.js"), "dep");
    await writeFile(join(site, ".git", "HEAD"), "ref");
    const tools = createArtifactTools({ artifacts: bound(root) });
    const res = await run(tools.artifactCreate, { title: "S", type: "html", path: "site/index.html", assets_dir: "site" });
    expect(res.isError).toBe(false);
    expect(text(res)).toMatch(/with 1 asset/);
    const id = parseArtifactRef(text(res))!.id;
    expect(Object.keys((await svc.read("c1", id)).assets!)).toEqual(["img/a.png"]);

    const read = await run(tools.artifactRead, { id });
    expect(text(read)).toMatch(/Assets \(1, 3 B\):\n- img\/a\.png \(3 B, image\/png\)/);

    // An edit keeps them; clear_assets drops them.
    await run(tools.artifactUpdate, { id, old_str: "a.png", new_str: "a.png?" });
    expect((await svc.read("c1", id)).assets).toBeDefined();
    await run(tools.artifactUpdate, { id, clear_assets: true });
    expect((await svc.read("c1", id)).assets).toBeUndefined();
  });

  it("refuses an assets_dir outside the chat's directories, and assets on a non-html artifact", async () => {
    const repo = join(root, "repo3");
    const elsewhere = join(root, "elsewhere");
    await mkdir(repo, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, "secret.bin"), "s");
    const tools = createArtifactTools({ artifacts: bound(repo) });
    const out = await run(tools.artifactCreate, { title: "x", type: "html", content: "p", assets_dir: "../elsewhere" });
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/outside this chat's working directories/);
    const md = await run(tools.artifactCreate, { title: "x", type: "markdown", content: "p", assets_dir: "." });
    expect(md.isError).toBe(true);
    expect(await svc.list("c1")).toEqual([]);
  });

  it("truncates a huge page in artifact_read instead of handing the model all of it", async () => {
    const tools = createArtifactTools({ artifacts: bound() });
    const big = "x".repeat(ARTIFACT_READ_CONTENT_MAX + 10);
    const id = parseArtifactRef(text(await run(tools.artifactCreate, { title: "b", type: "html", content: big })))!.id;
    const read = text(await run(tools.artifactRead, { id }));
    expect(read).toMatch(/truncated: \d+ characters in all/);
    expect(read.length).toBeLessThan(ARTIFACT_READ_CONTENT_MAX + 1000);
  });

  it("reports itself unavailable with no store bound", async () => {
    const tools = createArtifactTools({});
    const res = await run(tools.artifactList, {});
    expect(res.isError).toBe(true);
  });
});
