import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARTIFACT_MAX_BYTES, ARTIFACT_MAX_VERSIONS, parseArtifactRef } from "@dispatch/shared";
import { ArtifactError, ArtifactService } from "./artifacts.js";
import { createArtifactTools, type ManagerMcpArtifacts } from "./mcp/artifact-tools.js";

const DAY = 24 * 60 * 60_000;

let root: string;
let clock: number;
let svc: ArtifactService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "artifacts-"));
  clock = 1_000_000;
  svc = new ArtifactService({ dirFor: (chatId) => join(root, chatId, "artifacts"), now: () => clock });
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
});

describe("artifact tools", () => {
  function bound(cwd?: string): ManagerMcpArtifacts {
    return {
      create: (input) => svc.create("c1", input),
      update: (id, change) => svc.update("c1", id, change),
      read: (id, version) => svc.read("c1", id, version),
      list: () => svc.list("c1"),
      ...(cwd ? { cwd } : {}),
    };
  }
  const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

  it("create → update → read round-trips, and each result carries a parseable ref", async () => {
    const tools = createArtifactTools({ artifacts: bound() });
    const created = await tools.artifactCreate.handler({ title: "Demo", type: "html", content: "<b>1</b>" }, {});
    expect(created.isError).toBe(false);
    const ref = parseArtifactRef(text(created));
    expect(ref).toMatchObject({ version: 1, title: "Demo", type: "html" });

    const updated = await tools.artifactUpdate.handler({ id: ref!.id, old_str: "1", new_str: "2" }, {});
    expect(parseArtifactRef(text(updated))).toMatchObject({ id: ref!.id, version: 2 });

    svc.recordErrors("c1", ref!.id, 2, ["ReferenceError: x is not defined"]);
    const read = await tools.artifactRead.handler({ id: ref!.id }, {});
    expect(text(read)).toContain("ReferenceError: x is not defined");
    expect(text(read)).toContain("<b>2</b>");
    expect(parseArtifactRef(text(read))).toBeNull();

    const listed = await tools.artifactList.handler({}, {});
    expect(text(listed)).toContain(ref!.id);
  });

  it("publishes from a path relative to the session cwd", async () => {
    await writeFile(join(root, "page.html"), "<h1>file</h1>");
    const tools = createArtifactTools({ artifacts: bound(root) });
    const res = await tools.artifactCreate.handler({ title: "F", type: "html", path: "page.html" }, {});
    const ref = parseArtifactRef(text(res))!;
    expect((await svc.read("c1", ref.id)).content).toBe("<h1>file</h1>");
  });

  it("refuses ambiguous or empty calls with a readable error", async () => {
    const tools = createArtifactTools({ artifacts: bound() });
    expect((await tools.artifactCreate.handler({ title: "x", type: "html" }, {})).isError).toBe(true);
    expect(
      (await tools.artifactCreate.handler({ title: "x", type: "html", content: "a", path: "b" }, {})).isError,
    ).toBe(true);
    const created = await tools.artifactCreate.handler({ title: "x", type: "html", content: "a" }, {});
    const id = parseArtifactRef(text(created))!.id;
    const none = await tools.artifactUpdate.handler({ id }, {});
    expect(none.isError).toBe(true);
    const missing = await tools.artifactUpdate.handler({ id, old_str: "zzz", new_str: "q" }, {});
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/does not occur/);
  });

  it("reports itself unavailable with no store bound", async () => {
    const tools = createArtifactTools({});
    const res = await tools.artifactList.handler({}, {});
    expect(res.isError).toBe(true);
  });
});
