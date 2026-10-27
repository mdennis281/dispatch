/**
 * Plugin collections: one URL, several plugins. Discovery by scan and by
 * `dispatch-plugins.yaml`, the soft first pass that lets a monorepo too big
 * for the caps still be listed, the strict refetch of only its plugins, and
 * install of one member recording the collection URL plus that member's
 * subdir — which is all an update later needs.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPluginCollection,
  listCollection,
  normaliseCollectionPath,
  type PluginCollectionInspection,
  type PluginGitSource,
  type PluginInspectResult,
} from "@dispatch/shared";
import { DEFAULT_FETCH_LIMITS, memberSubdir, type FetchDeps } from "./fetch.js";
import { PluginInspector } from "./index.js";
import { chunked, entriesFromDir, gzip, makeTar, type TarEntry } from "./test-tar.js";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(here, "../../../../../examples/plugins");
const SHA = "a".repeat(40);
const LS_REMOTE = [`ref: refs/heads/main\tHEAD`, `${SHA}\tHEAD`, `${SHA}\trefs/heads/main`].join("\n");
const PREFIX = `o-r-${SHA.slice(0, 7)}`;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "dispatch-collection-test-"));
  dirs.push(d);
  return d;
}

const manifest = (id: string) => `id: ${id}\nname: ${id.toUpperCase()}\nversion: 1.0.0\ndispatch: '>=1'\n`;

function deps(entries: TarEntry[], fetched: string[] = []): FetchDeps {
  const tar = makeTar(entries, { comment: SHA });
  return {
    lsRemote: async () => LS_REMOTE,
    githubTarball: async (_o, _r, sha) => {
      fetched.push(sha);
      return chunked(gzip(tar));
    },
    gitArchive: async () => chunked(tar),
  };
}

async function inspector(fetchDeps: FetchDeps, recorded: Array<[string, PluginGitSource]> = [], limits = DEFAULT_FETCH_LIMITS) {
  return new PluginInspector({
    configDir: await tmp(),
    hostInfo: () => undefined,
    noteInstalled: async () => undefined,
    recordSource: async (id, source) => void recorded.push([id, source]),
    fetchDeps,
    limits,
  });
}

function asCollection(r: PluginInspectResult): PluginCollectionInspection {
  if (!isPluginCollection(r)) throw new Error("expected a collection");
  return r;
}

describe("listCollection", () => {
  it("lists every plugin.yaml outermost-first when there is no manifest", () => {
    expect(listCollection(undefined, ["b", "a", "a/examples/inner", "c/d"])).toMatchObject({
      members: ["a", "b", "c/d"],
      listedBy: "scan",
      manifestErrors: [],
    });
  });

  it("takes exactly the manifest's paths, in its order, and names a bad one", () => {
    const r = listCollection({ name: "Mine", plugins: ["./z/", { path: "a" }, "../escape", "a"] }, ["a", "z", "other"]);
    expect(r).toMatchObject({ members: ["z", "a"], listedBy: "manifest", name: "Mine" });
    expect(r.manifestErrors).toEqual([expect.stringMatching(/\.\. segments/)]);
  });

  it("falls back to the scan, saying so, when the manifest is unusable", () => {
    const r = listCollection({ plugins: "nope" }, ["a"]);
    expect(r.listedBy).toBe("scan");
    expect(r.members).toEqual(["a"]);
    expect(r.manifestErrors.at(-1)).toMatch(/unusable/);
  });

  it("normalises paths and refuses ones that leave the collection", () => {
    expect(normaliseCollectionPath("./a/b/")).toEqual({ path: "a/b" });
    expect(normaliseCollectionPath(".")).toEqual({ path: "" });
    for (const bad of ["/etc", "C:/x", "a\\b", "a/../b", "a//b"]) expect(normaliseCollectionPath(bad)).toHaveProperty("error");
    // CodeQL js/polynomial-redos: a long run of slashes must stay linear.
    expect(normaliseCollectionPath(`a${"/".repeat(100_000)}`)).toEqual({ path: "a" });
  });
});

describe("memberSubdir", () => {
  it("accepts the root or anything under it, and nothing else", () => {
    expect(memberSubdir("plugins", "plugins/a")).toBe("plugins/a");
    expect(memberSubdir("", "x/y")).toBe("x/y");
    expect(() => memberSubdir("plugins", "other/a")).toThrow(/not inside plugins\//);
    expect(() => memberSubdir("plugins", "plugins/../secrets")).toThrow(/\.\. segments/);
    expect(() => memberSubdir("", "a/con")).toThrow(/unsafe/);
  });
});

describe("inspect a collection", () => {
  it("lists Dispatch's own examples directory, each with its full report", async () => {
    const entries: TarEntry[] = [];
    for (const name of (await readdir(EXAMPLES)).sort()) {
      entries.push(...(await entriesFromDir(join(EXAMPLES, name), `${PREFIX}/examples/plugins/${name}`)));
    }
    const r = asCollection(await (await inspector(deps(entries))).inspect("https://github.com/o/r/tree/main/examples/plugins"));
    expect(r.listedBy).toBe("scan");
    expect(r.source).toMatchObject({ ref: "main", sha: SHA, subdir: "examples/plugins" });
    expect(r.plugins.map((p) => [p.subdir, p.report?.id])).toEqual([
      ["examples/plugins/contributions", "contributions"],
      ["examples/plugins/event-forwarder", "event-forwarder"],
      ["examples/plugins/hello-server", "hello-server"],
      ["examples/plugins/hello-slot", "hello-slot"],
    ]);
    const hello = r.plugins.find((p) => p.report?.id === "hello-server")!.report!;
    // A member's report is the one its own URL would give: its own subdir, files and scan.
    expect(hello.source).toMatchObject({ subdir: "examples/plugins/hello-server", url: "https://github.com/o/r/tree/main/examples/plugins" });
    expect(hello.installable).toBe(true);
    expect(hello.scan.files.every((f) => !f.startsWith("examples/"))).toBe(true);
    expect(hello.fetched.files).toBeGreaterThan(0);
  });

  it("follows dispatch-plugins.yaml and reports a listed path with no plugin", async () => {
    const r = asCollection(
      await (
        await inspector(
          deps([
            { name: `${PREFIX}/dispatch-plugins.yaml`, body: "name: Home lab\ndescription: Mine\nplugins:\n  - tools/b\n  - tools/a\n  - tools/gone\n" },
            { name: `${PREFIX}/tools/a/plugin.yaml`, body: manifest("a") },
            { name: `${PREFIX}/tools/b/plugin.yaml`, body: manifest("b") },
            { name: `${PREFIX}/tools/unlisted/plugin.yaml`, body: manifest("unlisted") },
          ]),
        )
      ).inspect("https://github.com/o/r"),
    );
    expect(r).toMatchObject({ listedBy: "manifest", name: "Home lab", description: "Mine" });
    expect(r.plugins.map((p) => p.report?.id ?? p.error)).toEqual(["b", "a", expect.stringMatching(/no plugin\.yaml in tools\/gone/)]);
  });

  it("still inspects a single plugin as one, even with plugins below it", async () => {
    const r = await (
      await inspector(
        deps([
          { name: `${PREFIX}/plugin.yaml`, body: manifest("root") },
          { name: `${PREFIX}/examples/x/plugin.yaml`, body: manifest("x") },
        ]),
      )
    ).inspect("https://github.com/o/r");
    expect(isPluginCollection(r)).toBe(false);
    expect(r).toMatchObject({ id: "root" });
  });

  it("lists a monorepo too big for the caps by refetching only its plugins", async () => {
    const fetched: string[] = [];
    const filler = Array.from({ length: 30 }, (_, i) => ({ name: `${PREFIX}/aaa-big/f${i}.txt`, body: "x".repeat(100) }));
    const ins = await inspector(
      deps(
        [
          ...filler,
          { name: `${PREFIX}/plugins/a/plugin.yaml`, body: manifest("a") },
          { name: `${PREFIX}/plugins/a/README.md`, body: "# A\n\nThe a plugin.\n" },
          { name: `${PREFIX}/plugins/b/plugin.yaml`, body: manifest("b") },
        ],
        fetched,
      ),
      [],
      { ...DEFAULT_FETCH_LIMITS, maxFiles: 10, maxBytes: 100_000 },
    );
    const r = asCollection(await ins.inspect("https://github.com/o/r"));
    expect(fetched).toHaveLength(2);
    expect(r.plugins.map((p) => p.report?.id)).toEqual(["a", "b"]);
    expect(r.plugins[0]!.report!.readme?.excerpt).toMatch(/The a plugin/);
  });

  it("turns one member's oversized file into that member's error, not the whole collection's", async () => {
    const ins = await inspector(
      deps([
        { name: `${PREFIX}/plugins/a/plugin.yaml`, body: manifest("a") },
        { name: `${PREFIX}/plugins/b/plugin.yaml`, body: manifest("b") },
        { name: `${PREFIX}/plugins/b/huge.bin`, body: "x".repeat(600) },
        { name: `${PREFIX}/plugins/c/plugin.yaml`, body: manifest("c") },
      ]),
      [],
      { ...DEFAULT_FETCH_LIMITS, maxFileBytes: 500 },
    );
    const r = asCollection(await ins.inspect("https://github.com/o/r"));
    expect(r.plugins.map((p) => p.report?.id ?? p.error)).toEqual(["a", expect.stringMatching(/huge\.bin .* per-file limit/), "c"]);
  });

  it("refuses a single plugin that overflowed, with the cap it crossed", async () => {
    const ins = await inspector(
      deps([
        { name: `${PREFIX}/plugin.yaml`, body: manifest("p") },
        ...Array.from({ length: 12 }, (_, i) => ({ name: `${PREFIX}/f${i}.txt`, body: "x" })),
      ]),
      [],
      { ...DEFAULT_FETCH_LIMITS, maxFiles: 10 },
    );
    await expect(ins.inspect("https://github.com/o/r")).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/more than 10 files/) });
  });

  it("says there is nothing to install when no plugin.yaml is at or below the URL", async () => {
    const ins = await inspector(deps([{ name: `${PREFIX}/README.md`, body: "hi" }, { name: `${PREFIX}/elsewhere/plugin.yaml`, body: manifest("e") }]));
    await expect(ins.inspect("https://github.com/o/r/tree/main/docs")).rejects.toMatchObject({
      status: 404,
      message: expect.stringMatching(/no plugins below it — found one in: elsewhere/),
    });
  });
});

describe("install a collection member", () => {
  const entries: TarEntry[] = [
    { name: `${PREFIX}/plugins/a/plugin.yaml`, body: manifest("a") },
    { name: `${PREFIX}/plugins/b/plugin.yaml`, body: manifest("b") },
  ];

  it("installs the picked member and records the collection URL with its subdir", async () => {
    const recorded: Array<[string, PluginGitSource]> = [];
    const ins = await inspector(deps(entries), recorded);
    const url = "https://github.com/o/r/tree/main/plugins";
    const res = await ins.install(url, SHA, false, "plugins/b");
    expect(res).toMatchObject({ id: "b", outcome: "copied" });
    expect(recorded).toEqual([["b", expect.objectContaining({ url, ref: "main", refKind: "branch", subdir: "plugins/b", sha: SHA })]]);
    const configDir = (ins as unknown as { opts: { configDir: string } }).opts.configDir;
    expect(existsSync(join(configDir, "plugins", "b", "plugin.yaml"))).toBe(true);
    expect(existsSync(join(configDir, "plugins", "a"))).toBe(false);
  });

  it("refuses a subdir outside the directory the URL names", async () => {
    const ins = await inspector(deps(entries));
    await expect(ins.install("https://github.com/o/r/tree/main/plugins/a", SHA, false, "plugins/b")).rejects.toMatchObject({ status: 400 });
  });
});
