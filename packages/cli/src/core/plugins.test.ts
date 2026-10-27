import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addPlugin,
  collectionIn,
  consentLines,
  discoverPlugins,
  linkPlugin,
  listCollectionMembers,
  looksLikeGitUrl,
  readPluginToggles,
  removePlugin,
  setPluginEnabled,
} from "./plugins.js";
import { CmError } from "./manifest.js";

let root: string;
let configDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cm-plugin-"));
  configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const MANIFEST = (id: string, extra = "") =>
  `id: ${id}\nname: ${id}\nversion: 1.2.3\ndispatch: ">=1"\nserver: ./server/index.js\ncapabilities: [routes, kv]\n${extra}`;

/** A plugin source directory outside the config root. */
async function source(id: string, manifest = MANIFEST(id)): Promise<string> {
  const dir = join(root, "src", id);
  await mkdir(join(dir, "server"), { recursive: true });
  await writeFile(join(dir, "plugin.yaml"), manifest);
  await writeFile(join(dir, "server", "index.js"), "export function activate() {}\n");
  return dir;
}

describe("addPlugin", () => {
  it("copies a valid plugin into <configDir>/plugins/<id> and reports its consent summary", async () => {
    const result = await addPlugin(configDir, await source("hello"));
    expect(result.outcome).toBe("copied");
    expect(result.dir).toBe(join(configDir, "plugins", "hello"));
    expect(existsSync(join(result.dir, "server", "index.js"))).toBe(true);
    expect(result.plugin.manifest?.id).toBe("hello");
    expect(consentLines(result.plugin.manifest!)).toEqual([
      "hello v1.2.3 (hello)",
      "  runs: server code (in-process)",
      "  capabilities: routes, kv",
    ]);
  });

  it("refuses an invalid manifest BEFORE anything lands under the root", async () => {
    const bad = await source("bad", "id: bad\nname: [\n");
    await expect(addPlugin(configDir, bad)).rejects.toBeInstanceOf(CmError);
    expect(existsSync(join(configDir, "plugins", "bad"))).toBe(false);
  });

  it("refuses an incompatible plugin and a reserved id", async () => {
    await expect(addPlugin(configDir, await source("old", MANIFEST("old").replace('">=1"', '">=99"')))).rejects.toThrow(
      /plugin API/,
    );
    await expect(addPlugin(configDir, await source("dispatch-x", MANIFEST("dispatch-x")))).rejects.toThrow(/reserved/);
  });

  it("refuses to overwrite an installed plugin unless --force", async () => {
    const src = await source("hello");
    await addPlugin(configDir, src);
    await expect(addPlugin(configDir, src)).rejects.toThrow(/already installed/);
    await writeFile(join(src, "server", "index.js"), "export function activate() { return 2; }\n");
    const again = await addPlugin(configDir, src, { force: true });
    expect(again.outcome).toBe("replaced");
    expect(await readFile(join(again.dir, "server", "index.js"), "utf8")).toContain("return 2");
  });

  it("claims the slot by MANIFEST id when the source directory is named something else", async () => {
    // A clone lands in `src/`, a checkout is called whatever the author
    // called it. Claiming by that name skipped the installed check (rename
    // then failed with ENOTEMPTY) and let --force delete the wrong plugin.
    const first = await addPlugin(configDir, await source("hello"));
    expect(first.dir).toBe(join(configDir, "plugins", "hello"));
    const checkout = join(root, "src", "hello-checkout");
    await mkdir(join(checkout, "server"), { recursive: true });
    await writeFile(join(checkout, "plugin.yaml"), MANIFEST("hello"));
    await writeFile(join(checkout, "server", "index.js"), "export function activate() { return 'checkout'; }\n");

    await expect(addPlugin(configDir, checkout)).rejects.toThrow(/already installed/);
    expect(await readFile(join(first.dir, "server", "index.js"), "utf8")).not.toContain("checkout");

    const forced = await addPlugin(configDir, checkout, { force: true });
    expect(forced.outcome).toBe("replaced");
    expect(forced.dir).toBe(join(configDir, "plugins", "hello"));
    expect(await readFile(join(forced.dir, "server", "index.js"), "utf8")).toContain("checkout");
    expect(existsSync(join(configDir, "plugins", "hello-checkout"))).toBe(false);

    // Same for link: the slot is the manifest id, so a second link refuses
    // and a forced one replaces the copy with the junction.
    await expect(linkPlugin(configDir, checkout)).rejects.toThrow(/already installed/);
    const linked = await linkPlugin(configDir, checkout, { force: true });
    expect(linked.dir).toBe(join(configDir, "plugins", "hello"));
    expect((await lstat(linked.dir)).isSymbolicLink()).toBe(true);
  });

  it("leaves node_modules and .git behind — a scaffold's SDK link would otherwise be copied through", async () => {
    const src = await source("built");
    await mkdir(join(src, "node_modules", "@dispatch", "plugin-sdk"), { recursive: true });
    await writeFile(join(src, "node_modules", "@dispatch", "plugin-sdk", "package.json"), "{}");
    await mkdir(join(src, ".git"));
    await writeFile(join(src, ".git", "HEAD"), "ref: refs/heads/main\n");
    const result = await addPlugin(configDir, src);
    expect(existsSync(join(result.dir, "server", "index.js"))).toBe(true);
    expect(existsSync(join(result.dir, "node_modules"))).toBe(false);
    expect(existsSync(join(result.dir, ".git"))).toBe(false);
  });

  it("finds the manifest one directory down, the way a tarball or clone wraps it", async () => {
    const wrapped = join(root, "wrapped");
    await mkdir(wrapped, { recursive: true });
    const inner = await source("inner");
    await rm(wrapped, { recursive: true });
    await mkdir(wrapped);
    const { rename } = await import("node:fs/promises");
    await rename(inner, join(wrapped, "inner-main"));
    const result = await addPlugin(configDir, wrapped);
    expect(result.plugin.id).toBe("inner");
  });

  it("names a source that is nothing it knows", async () => {
    await expect(addPlugin(configDir, join(root, "missing"))).rejects.toThrow(/no such file/);
    await writeFile(join(root, "x.txt"), "x");
    await expect(addPlugin(configDir, join(root, "x.txt"))).rejects.toThrow(/neither a directory/);
  });
});

describe("linkPlugin / removePlugin", () => {
  it("links a working directory and unlinks it without touching the source", async () => {
    const src = await source("dev");
    const linked = await linkPlugin(configDir, src);
    expect(linked.outcome).toBe("linked");
    expect((await lstat(linked.dir)).isSymbolicLink()).toBe(true);
    const found = await discoverPlugins(configDir);
    expect(found.map((p) => [p.id, p.linked])).toEqual([["dev", true]]);

    const removed = await removePlugin(configDir, "dev");
    expect(removed.removed).toBe(true);
    expect(existsSync(linked.dir)).toBe(false);
    expect(existsSync(join(src, "plugin.yaml"))).toBe(true);
  });

  it("removes a copied plugin and reports a missing one", async () => {
    await addPlugin(configDir, await source("hello"));
    expect((await removePlugin(configDir, "hello")).removed).toBe(true);
    expect((await removePlugin(configDir, "hello")).removed).toBe(false);
  });
});

describe("discoverPlugins", () => {
  it("skips directories without a manifest and lists broken ones with their error", async () => {
    await mkdir(join(configDir, "plugins", "README-dir"), { recursive: true });
    await mkdir(join(configDir, "plugins", "broken"), { recursive: true });
    await writeFile(join(configDir, "plugins", "broken", "plugin.yaml"), "id: other\nname: x\nversion: 1.0.0\ndispatch: '1'\n");
    await addPlugin(configDir, await source("ok"));
    const found = await discoverPlugins(configDir);
    expect(found.map((p) => p.id)).toEqual(["broken", "ok"]);
    expect(found[0]!.error).toMatch(/does not match its directory/);
    expect(found[1]!.manifest?.name).toBe("ok");
  });

  it("returns nothing when the root does not exist", async () => {
    expect(await discoverPlugins(join(root, "nowhere"))).toEqual([]);
  });
});

describe("setPluginEnabled", () => {
  it("edits only the plugins map of config.json and creates the file when absent", async () => {
    await setPluginEnabled(configDir, "hello", false);
    expect(JSON.parse(await readFile(join(configDir, "config.json"), "utf8"))).toEqual({
      plugins: { hello: { enabled: false } },
    });
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({ theme: "light", unknownFutureKey: { a: 1 }, plugins: { hello: { enabled: false, settings: { x: 1 } } } }),
    );
    await setPluginEnabled(configDir, "hello", true);
    expect(JSON.parse(await readFile(join(configDir, "config.json"), "utf8"))).toEqual({
      theme: "light",
      unknownFutureKey: { a: 1 },
      plugins: { hello: { enabled: true, settings: { x: 1 } } },
    });
    expect(await readPluginToggles(configDir)).toEqual({ hello: true });
  });
});

describe("looksLikeGitUrl", () => {
  it("recognises the clone shapes and nothing local", () => {
    expect(looksLikeGitUrl("https://github.com/x/y")).toBe(true);
    expect(looksLikeGitUrl("git@github.com:x/y.git")).toBe(true);
    expect(looksLikeGitUrl("../plugins/voice")).toBe(false);
    expect(looksLikeGitUrl("C:\\plugins\\voice")).toBe(false);
  });
});

describe("collections", () => {
  it("refuses to guess, listing the members, when a directory holds several plugins", async () => {
    await source("alpha");
    await source("beta");
    const err = await addPlugin(configDir, join(root, "src")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CmError);
    expect((err as Error).message).toMatch(/holds 2 plugins — pick with --plugin/);
    expect((err as Error).message).toMatch(/alpha {2}\(alpha v1\.2\.3\)/);
    expect(existsSync(join(configDir, "plugins"))).toBe(false);
  });

  it("installs the member picked by path or by id", async () => {
    await source("alpha");
    await source("beta");
    expect((await addPlugin(configDir, join(root, "src"), { plugin: "beta" })).plugin.manifest?.id).toBe("beta");
    expect((await addPlugin(configDir, join(root, "src"), { plugin: "./alpha/" })).plugin.manifest?.id).toBe("alpha");
    await expect(addPlugin(configDir, join(root, "src"), { plugin: "gamma" })).rejects.toThrow(/no plugin "gamma" in .* — it holds/);
  });

  it("lists by dispatch-plugins.yaml when there is one", async () => {
    await source("alpha");
    await source("beta");
    await writeFile(join(root, "src", "dispatch-plugins.yaml"), "plugins:\n  - beta\n");
    expect(await listCollectionMembers(join(root, "src"))).toEqual([{ path: "beta", id: "beta", name: "beta", version: "1.2.3" }]);
    expect((await collectionIn(join(root, "src"))).errors).toEqual([]);
  });
});
