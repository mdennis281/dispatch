import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
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

  it("lists the optional capabilities it grants, and notes the ones it does not know", () => {
    const lines = consentLines({
      id: "r",
      name: "r",
      version: "1.0.0",
      dispatch: ">=1",
      capabilities: ["routes"],
      optionalCapabilities: ["approvals", "teleport"],
    });
    expect(lines).toContain("  capabilities: routes");
    expect(lines).toContain("  optional capabilities (granted): approvals");
    expect(lines.find((l) => l.startsWith("  note: "))).toMatch(/"teleport" is not known to this Dispatch/);
  });

  it("says what it uses of other plugins and what it offers them, in the app's own sentences", () => {
    const lines = consentLines({
      id: "proxmox-terminal",
      name: "Proxmox terminal",
      version: "0.2.0",
      dispatch: ">=1",
      dependencies: { "remote-host": { uses: ["machines@1"], optional: true } },
      provides: { clones: [1, 2] },
    });
    expect(lines).toContain(
      "  Uses remote-host — its `machines` API v1. remote-host acts on what this plugin hands it. Optional: it runs without it, with less.",
    );
    expect(lines).toContain("  Lets other plugins use: `clones` v1 and v2.");
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

describe("replacing an installed plugin", () => {
  /** `hello` again, from another directory, at `version`. */
  async function variant(dirName: string, version: string): Promise<string> {
    const dir = join(root, dirName, "hello");
    await mkdir(join(dir, "server"), { recursive: true });
    await writeFile(join(dir, "plugin.yaml"), MANIFEST("hello").replace("1.2.3", version));
    await writeFile(join(dir, "server", "index.js"), "export function activate() {}\n");
    return dir;
  }
  const installedVersions = async () => (await discoverPlugins(configDir)).map((p) => [p.id, p.manifest?.version]);

  it("keeps the installed copy when the new one fails to copy part-way", async () => {
    // The slot used to be emptied BEFORE the copy: a copy that then failed
    // left no plugin at all — and every plugin that depends on it blocked.
    await addPlugin(configDir, await source("hello"));
    const bad = await variant("bad", "2.0.0");
    const gone = join(root, "gone");
    await mkdir(gone);
    // A dangling link: `cp` dereferences it and fails after starting.
    await symlink(gone, join(bad, "assets"), process.platform === "win32" ? "junction" : "dir");
    await rm(gone, { recursive: true });

    await expect(addPlugin(configDir, bad, { force: true })).rejects.toThrow();
    expect(await installedVersions()).toEqual([["hello", "1.2.3"]]);
    // Neither the half copy nor an aside entry is left behind.
    expect(await readdir(join(configDir, "plugins"))).toEqual(["hello"]);
  });

  it("runs the check before anything moves: a refusal changes nothing, warnings come back on the result", async () => {
    await addPlugin(configDir, await source("hello"));
    const next = await variant("next", "2.0.0");
    const refuse = () => {
      throw new CmError("hello: needs remote-host (machines@1): too old");
    };
    await expect(addPlugin(configDir, next, { force: true, check: refuse })).rejects.toThrow(/too old/);
    expect(await installedVersions()).toEqual([["hello", "1.2.3"]]);

    const seen: string[] = [];
    const result = await addPlugin(configDir, next, {
      force: true,
      check: (m) => {
        seen.push(m.version);
        return ["careful"];
      },
    });
    expect(seen).toEqual(["2.0.0"]);
    expect(result).toMatchObject({ outcome: "replaced", warnings: ["careful"] });
    expect(await installedVersions()).toEqual([["hello", "2.0.0"]]);
    expect(await readdir(join(configDir, "plugins"))).toEqual(["hello"]);
  });

  it("puts back a copy left aside by a process killed between the two renames, and clears its leftovers", async () => {
    await addPlugin(configDir, await source("hello"));
    await addPlugin(configDir, await source("other"));
    const plugins = join(configDir, "plugins");
    // A pid that is certainly not running: a child that has already exited.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const { rename: mv } = await import("node:fs/promises");
    // hello: killed after the first rename — no `hello`, the old copy aside, the new one staged.
    await mv(join(plugins, "hello"), join(plugins, `.hello.${dead}.old`));
    await mkdir(join(plugins, `.hello.${dead}.tmp`));
    // other: killed after the swap, before the aside was deleted.
    await mkdir(join(plugins, `.other.${dead}.old`));
    // A live process's staging is an install in flight: not ours to touch.
    await mkdir(join(plugins, `.other.${process.ppid}.tmp`));

    expect((await discoverPlugins(configDir)).map((p) => [p.id, p.manifest?.version])).toEqual([
      ["hello", "1.2.3"],
      ["other", "1.2.3"],
    ]);
    expect((await readdir(plugins)).sort()).toEqual([`.other.${process.ppid}.tmp`, "hello", "other"]);
  });

  it("unlinks a linked plugin it replaces — the working directory is never emptied", async () => {
    const work = await source("hello");
    await linkPlugin(configDir, work);
    const copy = await addPlugin(configDir, await variant("release", "2.0.0"), { force: true });
    expect((await lstat(copy.dir)).isSymbolicLink()).toBe(false);
    expect(existsSync(join(work, "plugin.yaml"))).toBe(true);
    expect(existsSync(join(work, "server", "index.js"))).toBe(true);
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

  it("skips dot-entries: an install mid-swap is not a second, invalid copy", async () => {
    await addPlugin(configDir, await source("ok"));
    for (const name of [".ok.1234.tmp", ".ok.1234.old"]) {
      await mkdir(join(configDir, "plugins", name), { recursive: true });
      await writeFile(join(configDir, "plugins", name, "plugin.yaml"), MANIFEST("ok"));
    }
    expect((await discoverPlugins(configDir)).map((p) => p.id)).toEqual(["ok"]);
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
    expect(await listCollectionMembers(join(root, "src"))).toEqual([
      { path: "beta", id: "beta", name: "beta", version: "1.2.3", manifest: expect.objectContaining({ id: "beta", capabilities: ["routes", "kv"] }) },
    ]);
    expect((await collectionIn(join(root, "src"))).errors).toEqual([]);
  });
});
