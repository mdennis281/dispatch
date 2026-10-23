/**
 * `dispatch plugin add <git-url>` recording its source, `dispatch plugin
 * update`, and `remove --purge` — against a REAL local git repository (a
 * bare `*.git` path is a git URL to `looksLikeGitUrl`, and cloning it needs
 * no network), so the clone / ls-remote / rev-parse plumbing is exercised as
 * it runs for the owner.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { addPlugin, readPluginEntries, setPluginEnabled, setPluginSource, removePlugin } from "./plugins.js";
import { checkPluginUpdates, purgePluginData, updatePlugins } from "./plugin-lifecycle.js";

let root: string;
let configDir: string;
let work: string;
let bare: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

const V1 = "id: hello\nname: Hello\nversion: 1.0.0\ndispatch: '>=1'\ncapabilities: [routes]\n";
const V2 = "id: hello\nname: Hello\nversion: 1.1.0\ndispatch: '>=1'\ncapabilities: [routes, kv]\nsecrets: [API_KEY]\n";

async function commit(manifest: string, msg: string): Promise<string> {
  await writeFile(join(work, "plugin.yaml"), manifest);
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", msg);
  git(work, "push", "-q", "origin", "HEAD:main");
  return git(work, "rev-parse", "HEAD");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cm-plugin-life-"));
  configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  bare = join(root, "remote.git");
  work = join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(root, "clone", "-q", bare, work);
  git(work, "checkout", "-q", "-b", "main");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("add records where a plugin came from", () => {
  it("records a git URL as a followed branch at the cloned commit", async () => {
    const sha = await commit(V1, "v1");
    const result = await addPlugin(configDir, bare);
    expect(result.source).toMatchObject({ type: "git", url: bare, cloneUrl: bare, ref: "main", refKind: "branch", subdir: "", sha });
    // The command layer writes it; the toggle beside it is untouched.
    await setPluginEnabled(configDir, "hello", false);
    await setPluginSource(configDir, "hello", result.source);
    expect((await readPluginEntries(configDir)).hello).toMatchObject({ enabled: false, source: { sha } });
  });

  it("records a local directory as local", async () => {
    await writeFile(join(work, "plugin.yaml"), V1);
    const result = await addPlugin(configDir, work);
    expect(result.source).toMatchObject({ type: "local", path: work });
  });
});

describe("update", () => {
  async function installV1(): Promise<string> {
    const sha = await commit(V1, "v1");
    const r = await addPlugin(configDir, bare);
    await setPluginSource(configDir, "hello", r.source);
    await setPluginEnabled(configDir, "hello", false);
    return sha;
  }

  it("checks without installing, then refuses an escalating update without --yes", async () => {
    const old = await installV1();
    expect((await checkPluginUpdates(configDir))[0]).toMatchObject({ id: "hello", status: "up-to-date" });
    const next = await commit(V2, "v2");

    const [check] = await checkPluginUpdates(configDir, { id: "hello" });
    expect(check).toMatchObject({ status: "available", current: { sha: old, version: "1.0.0" }, target: { ref: "main", sha: next, version: "1.1.0" }, installable: true });
    expect(check!.diff!.escalations.map((c) => c.label)).toEqual(["kv", "secret:API_KEY"]);
    expect(await readFile(join(configDir, "plugins", "hello", "plugin.yaml"), "utf8")).toMatch(/version: 1.0.0/);

    const [held] = await updatePlugins(configDir);
    expect(held).toMatchObject({ status: "available", message: expect.stringMatching(/--yes/) });
    expect(held!.updated).toBeUndefined();
    expect(await readFile(join(configDir, "plugins", "hello", "plugin.yaml"), "utf8")).toMatch(/version: 1.0.0/);

    const [done] = await updatePlugins(configDir, { acceptEscalations: true });
    expect(done).toMatchObject({ updated: true, target: { sha: next } });
    expect(await readFile(join(configDir, "plugins", "hello", "plugin.yaml"), "utf8")).toMatch(/version: 1.1.0/);
    // Source advanced; the toggle kept.
    expect((await readPluginEntries(configDir)).hello).toMatchObject({ enabled: false, source: { sha: next, ref: "main" } });
  });

  it("says why there is nothing to check for a local or unknown source", async () => {
    await writeFile(join(work, "plugin.yaml"), V1);
    await addPlugin(configDir, work);
    expect((await checkPluginUpdates(configDir))[0]).toMatchObject({ status: "unsupported", origin: "unknown" });
    await setPluginSource(configDir, "hello", { type: "local", path: work, installedAt: 1 });
    expect((await checkPluginUpdates(configDir))[0]).toMatchObject({ status: "unsupported", origin: "local" });
  });
});

describe("remove --purge", () => {
  it("deletes the entry, the secrets only it lists, and that instance's kv / OAuth rows", async () => {
    await writeFile(join(work, "plugin.yaml"), V2.replace("[API_KEY]", "[API_KEY, SHARED]"));
    await addPlugin(configDir, work);
    const other = join(root, "other");
    await mkdir(other);
    await writeFile(join(other, "plugin.yaml"), "id: other\nname: O\nversion: 1.0.0\ndispatch: '>=1'\nsecrets: [SHARED]\n");
    await addPlugin(configDir, other);
    await setPluginEnabled(configDir, "hello", false);
    await writeFile(
      join(configDir, "secrets.json"),
      JSON.stringify({
        version: 1,
        entries: [
          { name: "API_KEY", scope: "global", iv: "", tag: "", data: "", updatedAt: 1 },
          { name: "SHARED", scope: "global", iv: "", tag: "", data: "", updatedAt: 1 },
          { name: "API_KEY", scope: "project", projectId: "p", iv: "", tag: "", data: "", updatedAt: 1 },
        ],
      }),
    );
    const dataDir = join(root, "data");
    await mkdir(dataDir);
    const db = new DatabaseSync(join(dataDir, "state.db"));
    db.exec("CREATE TABLE plugin_kv (plugin TEXT, key TEXT, value TEXT, updated_at INTEGER)");
    db.exec("CREATE TABLE plugin_oauth_token (plugin TEXT, name TEXT, access_token TEXT, scopes TEXT, updated_at INTEGER)");
    db.exec("INSERT INTO plugin_kv VALUES ('hello', 'a', '1', 1), ('hello', 'b', '2', 1), ('other', 'a', '1', 1)");
    db.exec("INSERT INTO plugin_oauth_token VALUES ('hello', 'gh', 't', '', 1)");
    db.close();

    await removePlugin(configDir, "hello");
    const purged = await purgePluginData(configDir, "hello", { manifestSecrets: ["API_KEY", "SHARED"], dataDir });
    expect(purged).toEqual({ settings: true, secrets: ["API_KEY"], sharedSecrets: ["SHARED"], kvKeys: 2, oauth: ["gh"] });
    expect((await readPluginEntries(configDir)).hello).toBeUndefined();
    const left = JSON.parse(await readFile(join(configDir, "secrets.json"), "utf8")) as { entries: Array<{ name: string; scope: string }> };
    // A project-scoped secret of the same name is not this plugin's.
    expect(left.entries.map((e) => `${e.scope}:${e.name}`)).toEqual(["global:SHARED", "project:API_KEY"]);
    const check = new DatabaseSync(join(dataDir, "state.db"));
    expect(check.prepare("SELECT plugin FROM plugin_kv").all()).toEqual([{ plugin: "other" }]);
    expect(check.prepare("SELECT COUNT(*) AS n FROM plugin_oauth_token").get()).toEqual({ n: 0 });
    check.close();
  });

  it("says what it could not reach without a data dir", async () => {
    await writeFile(join(work, "plugin.yaml"), V1);
    await addPlugin(configDir, work);
    await removePlugin(configDir, "hello");
    const purged = await purgePluginData(configDir, "hello", { manifestSecrets: [] });
    expect(purged.stateSkipped).toMatch(/--data-dir/);
    expect(existsSync(join(configDir, "plugins", "hello"))).toBe(false);
  });
});
