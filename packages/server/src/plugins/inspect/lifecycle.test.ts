/**
 * The plugin lifecycle after install (#409): the recorded source and its
 * survival across a settings save, ref-kind resolution, the update diff with
 * escalations first, an update that keeps the plugin's data, uninstall of a
 * copied / linked / hand-installed plugin with and without purge, and the
 * built-in refusals.
 *
 * No network: `FetchDeps` serves canned `ls-remote` output and a tarball per
 * sha, built in memory — v0.1.0 at SHA_OLD, v0.2.0 (which asks for more) at
 * SHA_NEW.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  diffPluginSurfaces,
  newerTag,
  parseLsRemote,
  parseTagVersion,
  resolveUpdateTarget,
  type PluginInfo,
  type PluginUninstallPreview,
  type PluginUpdateCheck,
} from "@dispatch/shared";
import { buildApp } from "../../app.js";
import { EventBus } from "../../bus.js";
import { Store } from "../../store/index.js";
import { SecretsService, plainKeyProtector } from "../../services/secrets.js";
import type { PluginService } from "../service.js";
import type { FetchDeps } from "./fetch.js";
import { PluginInspector } from "./index.js";
import { chunked, gzip, makeTar, type TarEntry } from "./test-tar.js";

const SHA_OLD = "1".repeat(40);
const SHA_NEW = "2".repeat(40);
const SHA_BETA = "3".repeat(40);
const SHA_OTHER = "4".repeat(40);

const LS_REMOTE = [
  "ref: refs/heads/main\tHEAD",
  `${SHA_NEW}\tHEAD`,
  `${SHA_NEW}\trefs/heads/main`,
  `${SHA_OLD}\trefs/tags/v0.1.0`,
  `${SHA_NEW}\trefs/tags/v0.2.0`,
  `${SHA_BETA}\trefs/tags/v0.3.0-beta.1`,
].join("\n");

const URL_MAIN = "https://github.com/o/r";

const V1 = {
  "plugin.yaml": "id: hello\nname: Hello\nversion: 0.1.0\ndispatch: '>=1'\nserver: ./server/index.js\ncapabilities: [routes]\n",
  "server/index.js": 'export function activate(ctx) { ctx.routes((r) => r.get("/ping", async () => ({ ok: true }))); }\n',
};

/** v0.2.0 asks for more: capabilities, a secret, an OAuth client, an MCP server — and uses `memory` without declaring it. */
const V2 = {
  "plugin.yaml": [
    "id: hello",
    "name: Hello",
    "version: 0.2.0",
    "dispatch: '>=1'",
    "server: ./server/index.js",
    "capabilities: [routes, kv, chats:write, oauth, mcp]",
    "secrets: [API_KEY]",
    "contributes:",
    "  mcpServers: ./mcp.yaml",
    "oauth:",
    "  clients:",
    "    github:",
    "      authorizationUrl: https://github.com/login/oauth/authorize",
    "      tokenUrl: https://github.com/login/oauth/access_token",
    "      clientId: abc",
    "      scopes: [repo]",
    "",
  ].join("\n"),
  "mcp.yaml": "- name: search\n  transport:\n    type: stdio\n    command: node\n    args: [mcp.js]\n",
  "mcp.js": "// stdio server\n",
  "server/index.js": [
    "export async function activate(ctx) {",
    '  ctx.routes((r) => r.get("/ping", async () => ({ ok: true })));',
    '  await ctx.kv.set("n", 1);',
    '  await ctx.chats.send("c", "hi");',
    '  await ctx.memory.read("p");',
    '  await fetch("https://example.com");',
    "}",
    "",
  ].join("\n"),
};

function repoTar(files: Record<string, string>, sha: string, id = "hello"): Buffer {
  const prefix = `o-r-${sha.slice(0, 7)}`;
  const entries: TarEntry[] = Object.entries(files).map(([name, body]) => ({
    name: `${prefix}/${name}`,
    body: name === "plugin.yaml" ? body.replace("id: hello", `id: ${id}`) : body,
  }));
  return makeTar(entries, { comment: sha });
}

function deps(opts: { lsRemote?: string; seen?: string[]; idAt?: Record<string, string> } = {}): FetchDeps {
  const tarFor = (sha: string) => repoTar(sha === SHA_OLD ? V1 : V2, sha, opts.idAt?.[sha]);
  return {
    lsRemote: async () => opts.lsRemote ?? LS_REMOTE,
    githubTarball: async (_o, _r, sha) => {
      opts.seen?.push(sha);
      return chunked(gzip(tarFor(sha)));
    },
    gitArchive: async (_u, sha) => chunked(tarFor(sha)),
  };
}

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close().catch(() => {})));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function app(fetchDeps: FetchDeps, seed?: (configDir: string) => Promise<void>) {
  const base = await tmp("dispatch-lifecycle-");
  const configDir = join(base, "config");
  const dataDir = join(base, "data");
  await mkdir(join(configDir, "plugins"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await seed?.(configDir);
  let host: PluginService | undefined;
  const instance = await buildApp({
    store: new Store(dataDir, configDir),
    bus: new EventBus(),
    config: { port: 0, host: "127.0.0.1", dataDir, configDir, maxActiveSessions: 1, idleSessionMinutes: 30 },
    serviceOverrides: {
      // Plain key: DPAPI would spawn PowerShell per test.
      secrets: new SecretsService({ configDir, protector: plainKeyProtector }),
      pluginInspector: new PluginInspector({
        configDir,
        hostInfo: (id) => host?.get(id),
        noteInstalled: async (id) => host?.noteInstalled(id),
        recordSource: async (id, source) => host?.recordSource(id, source),
        fetchDeps,
      }),
    },
  });
  host = instance.services.plugins;
  apps.push(instance);
  const json = async <T>(method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>): Promise<{ status: number; body: T }> => {
    const res = await instance.inject({ method, url, ...(payload !== undefined ? { payload } : {}) });
    return { status: res.statusCode, body: res.json() as T };
  };
  const config = async () => JSON.parse(await readFile(join(configDir, "config.json"), "utf8")) as { plugins?: Record<string, Record<string, unknown>> };
  return { instance, configDir, json, config, plugins: instance.services.plugins };
}

async function writePlugin(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), body);
  }
}

/* ------------------------------------------------------- pure resolution */

describe("resolveUpdateTarget", () => {
  const remote = parseLsRemote(LS_REMOTE);

  it("follows a branch to its tip, and says when it vanished", () => {
    expect(resolveUpdateTarget({ ref: "main", refKind: "branch", sha: SHA_OLD }, remote)).toEqual({ status: "available", ref: "main", sha: SHA_NEW });
    expect(resolveUpdateTarget({ ref: "main", refKind: "branch", sha: SHA_NEW }, remote)).toMatchObject({ status: "up-to-date" });
    expect(resolveUpdateTarget({ ref: "HEAD", refKind: "branch", sha: SHA_OLD }, remote)).toMatchObject({ status: "available", sha: SHA_NEW });
    expect(resolveUpdateTarget({ ref: "gone", refKind: "branch", sha: SHA_OLD }, remote)).toMatchObject({ status: "gone" });
  });

  it("offers a newer semver tag with the same prefix, skipping prereleases", () => {
    expect(resolveUpdateTarget({ ref: "v0.1.0", refKind: "tag", sha: SHA_OLD }, remote)).toEqual({ status: "available", ref: "v0.2.0", sha: SHA_NEW });
    expect(resolveUpdateTarget({ ref: "v0.2.0", refKind: "tag", sha: SHA_NEW }, remote)).toMatchObject({ status: "up-to-date" });
    expect(newerTag("v1.0.0", ["v1.0.1", "v2.0.0", "other-v9.0.0", "v3.0.0-rc.1"])).toBe("v2.0.0");
    expect(newerTag("v3.0.0-rc.1", ["v3.0.0-rc.2", "v3.0.0"])).toBe("v3.0.0");
    expect(newerTag("hello-v1.0.0", ["v9.0.0", "hello-v1.1.0", "world-v5.0.0"])).toBe("hello-v1.1.0");
  });

  it("parses tag versions in linear time, whatever a remote names its tags", () => {
    expect(parseTagVersion("hello-v1.2.3-rc.1")).toEqual({ prefix: "hello-v", nums: [1, 2, 3], pre: "rc.1" });
    expect(parseTagVersion("v10.0.0")).toEqual({ prefix: "v", nums: [10, 0, 0] });
    const started = Date.now();
    expect(parseTagVersion("0".repeat(150) + "x")).toBeNull();
    expect(parseTagVersion(`0.0.0-${"0.0.0--".repeat(25)}!`)).toBeNull();
    expect(parseTagVersion("1".repeat(5000))).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("reports a moved tag as an update, and pins a sha", () => {
    expect(resolveUpdateTarget({ ref: "v0.2.0", refKind: "tag", sha: SHA_OTHER }, remote)).toMatchObject({ status: "available", ref: "v0.2.0", sha: SHA_NEW, note: expect.stringMatching(/moved/) });
    expect(resolveUpdateTarget({ ref: SHA_OLD, refKind: "sha", sha: SHA_OLD }, remote)).toEqual({ status: "pinned" });
  });
});

describe("diffPluginSurfaces", () => {
  const empty = {
    version: "1.0.0",
    capabilities: [],
    secrets: [],
    oauth: [],
    contributions: { modes: [], skills: [], instructions: [], personas: [], mcpServers: [], processes: [] },
    mismatches: { undeclared: [], unused: [] },
    hooks: [],
    entries: {},
  } satisfies Parameters<typeof diffPluginSurfaces>[0];

  it("lists escalations first, in a fixed order, and everything else after", () => {
    const to = {
      ...empty,
      version: "2.0.0",
      // Deliberately out of display order.
      hooks: [{ kind: "io" as const, label: "fetch(https://x)", file: "a.js", line: 1, count: 1 }, { kind: "api" as const, label: "ctx.kv.set", file: "a.js", line: 2, count: 1 }],
      mismatches: { undeclared: [{ capability: "memory" as const, because: ["ctx.memory.read"] }], unused: [] },
      contributions: {
        ...empty.contributions,
        processes: [{ id: "worker", command: "node w.js", autostart: true, singleton: false }],
        instructions: ["house-rules"],
        skills: ["s"],
      },
      secrets: ["API_KEY"],
      capabilities: [{ name: "kv" as const, line: "", used: true }],
      oauth: [{ name: "gh", provider: "github.com", scopes: ["repo"] }],
      entries: { server: { path: "server/index.js", present: true } },
    };
    const d = diffPluginSurfaces(empty, to);
    expect(d).toMatchObject({ fromVersion: "1.0.0", toVersion: "2.0.0" });
    expect(d.escalations.map((c) => c.kind)).toEqual(["capability", "secret", "oauth", "process", "mismatch", "entry", "contribution"]);
    expect(d.escalations.find((c) => c.kind === "contribution")?.label).toBe("instructions:house-rules");
    // Plain changes: the skill, then io hooks ahead of the rest.
    expect(d.changes.map((c) => c.label)).toEqual(["skills:s", "fetch(https://x)", "ctx.kv.set"]);
    // The reverse direction escalates nothing.
    expect(diffPluginSurfaces(to, empty).escalations).toEqual([]);
  });

  it("treats new OAuth scopes and a re-pointed MCP server as escalations", () => {
    const from = {
      ...empty,
      oauth: [{ name: "gh", provider: "github.com", scopes: ["read"] }],
      contributions: { ...empty.contributions, mcpServers: [{ name: "s", transport: "stdio", command: "node", args: ["a.js"] }] },
    };
    const to = {
      ...from,
      oauth: [{ name: "gh", provider: "github.com", scopes: ["read", "write"] }],
      contributions: { ...from.contributions, mcpServers: [{ name: "s", transport: "stdio", command: "node", args: ["b.js"] }] },
    };
    expect(diffPluginSurfaces(from, to).escalations.map((c) => `${c.change} ${c.label}`)).toEqual(["changed oauth:gh", "changed mcp:s"]);
  });
});

/* ------------------------------------------------------------- the routes */

describe("recorded source", () => {
  it("is written by install, exposed on the row, and survives a full settings save and a toggle", async () => {
    const { json, config } = await app(deps());
    const draft = (await json<Record<string, unknown>>("GET", "/api/settings")).body;
    const inst = await json<{ plugin: PluginInfo }>("POST", "/api/plugins/install", { url: URL_MAIN, sha: SHA_OLD });
    expect(inst.status).toBe(200);
    expect(inst.body.plugin).toMatchObject({
      origin: "url",
      source: { type: "git", url: URL_MAIN, cloneUrl: "https://github.com/o/r.git", ref: "main", refKind: "branch", subdir: "", sha: SHA_OLD },
    });
    expect((await config()).plugins?.hello?.source).toMatchObject({ sha: SHA_OLD });

    // A draft loaded BEFORE the install, saved after it — the full-replace PUT.
    expect((await json("PUT", "/api/settings", { ...draft, theme: "light" })).status).toBe(200);
    expect((await json("PUT", "/api/plugins/hello/enabled", { enabled: false })).status).toBe(200);
    expect((await json("PUT", "/api/plugins/hello/settings", { settings: { a: 1 } })).status).toBe(200);
    const entry = (await config()).plugins?.hello;
    expect(entry).toMatchObject({ enabled: false, settings: { a: 1 }, source: { sha: SHA_OLD, refKind: "branch" } });
  });

  it("never serves credentials from a hand-edited source", async () => {
    const { plugins } = await app(deps(), async (configDir) => {
      await writePlugin(join(configDir, "plugins", "hello"), V1);
      const url = "https://x-access-token:ghp_secret@github.com/o/r.git";
      await writeFile(
        join(configDir, "config.json"),
        JSON.stringify({ plugins: { hello: { source: { type: "git", url, cloneUrl: url, ref: "main", refKind: "branch", subdir: "", sha: SHA_OLD, installedAt: 1 } } } }),
      );
    });
    expect(JSON.stringify(plugins.get("hello"))).not.toContain("ghp_secret");
    expect(plugins.get("hello")?.source).toMatchObject({ url: "https://github.com/o/r.git", cloneUrl: "https://github.com/o/r.git" });
  });

  it("records a tag as a tag and a sha as pinned", async () => {
    const { json } = await app(deps());
    const tag = await json<{ plugin: PluginInfo }>("POST", "/api/plugins/install", { url: `${URL_MAIN}/tree/v0.1.0`, sha: SHA_OLD });
    expect(tag.body.plugin.source).toMatchObject({ ref: "v0.1.0", refKind: "tag" });
    const check = await json<PluginUpdateCheck>("POST", "/api/plugins/hello/check-update");
    expect(check.body).toMatchObject({ status: "available", target: { ref: "v0.2.0", sha: SHA_NEW, version: "0.2.0" } });

    await json("POST", "/api/plugins/hello/uninstall", {});
    const pinned = await json<{ plugin: PluginInfo }>("POST", "/api/plugins/install", { url: `${URL_MAIN}/tree/${SHA_OLD}`, sha: SHA_OLD });
    expect(pinned.body.plugin.source).toMatchObject({ refKind: "sha" });
    expect((await json<PluginUpdateCheck>("POST", "/api/plugins/hello/check-update")).body).toMatchObject({ status: "pinned" });
  });
});

describe("check for updates + update", () => {
  it("diffs the newer commit against the installed copy, escalations first", async () => {
    const { json } = await app(deps());
    await json("POST", "/api/plugins/install", { url: URL_MAIN, sha: SHA_OLD });
    const { status, body } = await json<PluginUpdateCheck>("POST", "/api/plugins/hello/check-update");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "available",
      origin: "url",
      current: { ref: "main", refKind: "branch", sha: SHA_OLD, version: "0.1.0" },
      target: { ref: "main", sha: SHA_NEW, version: "0.2.0" },
      diff: { fromVersion: "0.1.0", toVersion: "0.2.0" },
    });
    const kinds = body.diff!.escalations.map((c) => c.kind);
    expect([...new Set(kinds)]).toEqual(["capability", "secret", "oauth", "mcpServer", "mismatch"]);
    expect(body.diff!.escalations.filter((c) => c.kind === "capability").map((c) => c.label)).toEqual(["chats:write", "kv", "mcp", "oauth"]);
    expect(body.diff!.escalations.find((c) => c.kind === "mismatch")?.label).toBe("uses memory");
    // Hooks: the io one first.
    const hooks = body.diff!.changes.filter((c) => c.kind === "hook");
    expect(hooks[0]).toMatchObject({ hookKind: "io", change: "added" });
    expect(hooks.every((h) => h.change === "added")).toBe(true);
    expect(body.inspection?.installable).toBe(true);
  });

  it("updates in place and keeps settings, the toggle, kv, secrets and OAuth tokens", async () => {
    const { json, config, plugins, instance, configDir } = await app(deps());
    await json("POST", "/api/plugins/install", { url: URL_MAIN, sha: SHA_OLD });
    await json("PUT", "/api/plugins/hello/settings", { settings: { greeting: "yo" } });
    await json("PUT", "/api/plugins/hello/enabled", { enabled: false });
    const db = instance.services.store.stateDb;
    db.prepare("INSERT INTO plugin_kv (plugin, key, value, updated_at) VALUES (?, ?, ?, ?)").run("hello", "seen", "3", 1);
    db.prepare(
      "INSERT INTO plugin_oauth_token (plugin, name, access_token, scopes, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("hello", "github", "tok", "repo", 1);
    await instance.services.secrets.set({ scope: "global", name: "API_KEY" }, "k");

    const moved = await json<{ error: string }>("POST", "/api/plugins/hello/update", { sha: SHA_BETA });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toMatch(/moved .* since you checked/);

    const upd = await json<{ fromSha: string; sha: string; plugin: PluginInfo }>("POST", "/api/plugins/hello/update", { sha: SHA_NEW });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ fromSha: SHA_OLD, sha: SHA_NEW, needsRestart: true, plugin: { enabled: false, source: { sha: SHA_NEW } } });
    expect(await readFile(join(configDir, "plugins", "hello", "plugin.yaml"), "utf8")).toMatch(/version: 0\.2\.0/);
    expect((await config()).plugins?.hello).toMatchObject({ enabled: false, settings: { greeting: "yo" }, source: { sha: SHA_NEW } });
    expect(db.prepare("SELECT value FROM plugin_kv WHERE plugin = 'hello' AND key = 'seen'").get()).toEqual({ value: "3" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM plugin_oauth_token WHERE plugin = 'hello'").get()).toEqual({ n: 1 });
    expect((await instance.services.secrets.list()).map((s) => s.name)).toContain("API_KEY");
    expect(plugins.get("hello")?.settings).toEqual({ greeting: "yo" });

    expect((await json<PluginUpdateCheck>("POST", "/api/plugins/hello/check-update")).body.status).toBe("up-to-date");
    expect((await json("POST", "/api/plugins/hello/update", { sha: SHA_NEW })).status).toBe(409);
  });

  it("refuses an update whose plugin has a different id", async () => {
    const { json } = await app(deps({ idAt: { [SHA_NEW]: "imposter" } }));
    await json("POST", "/api/plugins/install", { url: URL_MAIN, sha: SHA_OLD });
    const check = (await json<PluginUpdateCheck>("POST", "/api/plugins/hello/check-update")).body;
    expect(check.message).toMatch(/"imposter", not "hello"/);
    const res = await json<{ error: string }>("POST", "/api/plugins/hello/update", { sha: SHA_NEW });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/refusing to update one plugin into another/);
  });

  it("answers a network failure as a row result, not a 5xx", async () => {
    const failing: FetchDeps = {
      ...deps(),
      lsRemote: async () => {
        throw new Error("boom");
      },
    };
    // A source recorded by hand, as #409's verification does to fake an old install.
    const { json } = await app(failing, async (configDir) => {
      await writePlugin(join(configDir, "plugins", "hello"), V1);
      await writeFile(
        join(configDir, "config.json"),
        JSON.stringify({ plugins: { hello: { source: { type: "git", url: URL_MAIN, cloneUrl: `${URL_MAIN}.git`, ref: "main", refKind: "branch", subdir: "", sha: SHA_OLD, installedAt: 1 } } } }),
      );
    });
    const res = await json<PluginUpdateCheck>("POST", "/api/plugins/hello/check-update");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "error", message: expect.stringMatching(/boom/) });
  });
});

describe("uninstall", () => {
  it("deletes a copied plugin, deactivating it live, and keeps its data unless purged", async () => {
    const { json, config, plugins, instance, configDir } = await app(deps(), async (c) => {
      await writePlugin(join(c, "plugins", "hello"), V1);
      await writeFile(join(c, "config.json"), JSON.stringify({ plugins: { hello: { settings: { a: 1 } } } }));
    });
    await plugins.activateAll();
    expect((await instance.inject({ url: "/api/plugins/hello/ping" })).statusCode).toBe(200);
    instance.services.store.stateDb.prepare("INSERT INTO plugin_kv (plugin, key, value, updated_at) VALUES ('hello', 'k', '1', 1)").run();
    expect(plugins.get("hello")?.origin).toBe("unknown");

    const preview = await json<PluginUninstallPreview>("GET", "/api/plugins/hello/uninstall");
    expect(preview.body).toMatchObject({ origin: "unknown", removes: "directory", active: true, data: { settings: true, kvKeys: 1, secrets: [], oauth: [] } });

    const res = await json<Record<string, unknown>>("POST", "/api/plugins/hello/uninstall", {});
    expect(res.body).toMatchObject({ id: "hello", removed: "directory", deactivated: true, needsRestart: false });
    expect(res.body.purged).toBeUndefined();
    expect(existsSync(join(configDir, "plugins", "hello"))).toBe(false);
    expect((await instance.inject({ url: "/api/plugins/hello/ping" })).statusCode).toBe(404);
    expect(plugins.get("hello")).toBeUndefined();
    expect((await config()).plugins?.hello).toEqual({ settings: { a: 1 } });
    expect(instance.services.store.stateDb.prepare("SELECT COUNT(*) AS n FROM plugin_kv WHERE plugin = 'hello'").get()).toEqual({ n: 1 });
  });

  it("purges settings, kv, OAuth tokens and the secrets only it lists", async () => {
    const { json, config, instance } = await app(deps(), async (c) => {
      await writePlugin(join(c, "plugins", "other"), { "plugin.yaml": "id: other\nname: O\nversion: 1.0.0\ndispatch: '>=1'\nsecrets: [SHARED]\n" });
    });
    await json("POST", "/api/plugins/install", { url: URL_MAIN, sha: SHA_NEW });
    // v0.2.0 lists API_KEY; make it list SHARED too by hand so the shared rule has something to keep.
    const yaml = join((instance.services.plugins.get("hello") as PluginInfo).dir, "plugin.yaml");
    await writeFile(yaml, (await readFile(yaml, "utf8")).replace("secrets: [API_KEY]", "secrets: [API_KEY, SHARED, UNSET]"));
    await instance.services.plugins.load();
    await json("PUT", "/api/plugins/hello/settings", { settings: { a: 1 } });
    const db = instance.services.store.stateDb;
    db.prepare("INSERT INTO plugin_kv (plugin, key, value, updated_at) VALUES ('hello', 'k', '1', 1)").run();
    db.prepare("INSERT INTO plugin_oauth_token (plugin, name, access_token, scopes, updated_at) VALUES ('hello', 'github', 't', '', 1)").run();
    await instance.services.secrets.set({ scope: "global", name: "API_KEY" }, "k");
    await instance.services.secrets.set({ scope: "global", name: "SHARED" }, "s");

    const preview = (await json<PluginUninstallPreview>("GET", "/api/plugins/hello/uninstall")).body;
    expect(preview.data).toEqual({ settings: true, kvKeys: 1, secrets: ["API_KEY"], sharedSecrets: [{ name: "SHARED", alsoUsedBy: ["other"] }], oauth: ["github"] });

    const res = await json<Record<string, unknown>>("POST", "/api/plugins/hello/uninstall", { purge: true });
    expect(res.body).toMatchObject({ purged: { settings: true, kvKeys: 1, secrets: ["API_KEY"], oauth: ["github"] } });
    expect((await config()).plugins?.hello).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM plugin_kv WHERE plugin = 'hello'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM plugin_oauth_token WHERE plugin = 'hello'").get()).toEqual({ n: 0 });
    expect((await instance.services.secrets.list()).map((s) => s.name).sort()).toEqual(["SHARED"]);
  });

  it("only unlinks a linked plugin — the author's directory is untouched", async () => {
    const author = await tmp("dispatch-lifecycle-author-");
    await writePlugin(author, V1);
    const { json, configDir, plugins } = await app(deps(), async (c) => {
      await symlink(author, join(c, "plugins", "hello"), process.platform === "win32" ? "junction" : "dir");
    });
    expect(plugins.get("hello")?.origin).toBe("linked");
    const preview = (await json<PluginUninstallPreview>("GET", "/api/plugins/hello/uninstall")).body;
    expect(preview).toMatchObject({ origin: "linked", removes: "link" });
    expect(preview.linkTarget?.toLowerCase()).toBe(author.toLowerCase());
    expect((await json<PluginUpdateCheck>("POST", "/api/plugins/hello/check-update")).body).toMatchObject({ status: "unsupported", origin: "linked" });

    const res = await json<Record<string, unknown>>("POST", "/api/plugins/hello/uninstall", { purge: true });
    expect(res.body).toMatchObject({ removed: "link" });
    expect(existsSync(join(configDir, "plugins", "hello"))).toBe(false);
    expect(existsSync(join(author, "plugin.yaml"))).toBe(true);
    expect(existsSync(join(author, "server", "index.js"))).toBe(true);
  });

  it("404s a plugin that is not installed", async () => {
    const { json } = await app(deps());
    expect((await json("POST", "/api/plugins/nope/uninstall", {})).status).toBe(404);
    expect((await json("GET", "/api/plugins/nope/uninstall")).status).toBe(404);
    expect((await json("POST", "/api/plugins/nope/check-update")).status).toBe(404);
  });
});

describe("built-in plugins", () => {
  it("can be switched off but not updated or uninstalled", async () => {
    const { json, plugins, configDir } = await app(deps(), async (c) => writePlugin(join(c, "plugins", "hello"), V1));
    // Built-ins are discovered from the app payload by the provider-plugins
    // work; the flag on the record is all this layer reads.
    (plugins as unknown as { records: Map<string, { builtin?: boolean }> }).records.get("hello")!.builtin = true;

    expect(plugins.get("hello")).toMatchObject({ origin: "builtin" });
    expect((await json<PluginUpdateCheck>("POST", "/api/plugins/hello/check-update")).body).toMatchObject({
      status: "unsupported",
      origin: "builtin",
      message: expect.stringMatching(/updates with Dispatch/),
    });
    expect((await json("POST", "/api/plugins/hello/update", { sha: SHA_NEW })).status).toBe(409);
    expect((await json("GET", "/api/plugins/hello/uninstall")).status).toBe(409);
    expect((await json("POST", "/api/plugins/hello/uninstall", { purge: true })).status).toBe(409);
    expect((await json("POST", "/api/plugins/install", { url: URL_MAIN, sha: SHA_OLD, replace: true })).status).toBe(409);
    expect(existsSync(join(configDir, "plugins", "hello", "plugin.yaml"))).toBe(true);
    expect((await json<PluginInfo>("PUT", "/api/plugins/hello/enabled", { enabled: false })).body).toMatchObject({ enabled: false, origin: "builtin" });
  });
});
