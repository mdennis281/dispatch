/**
 * Dependencies at install time (design §1.4), through the real inspector and
 * real tarballs: a collection member's provider resolves from its siblings,
 * a consumer posted before its provider is refused with where the provider
 * must come from, and a replace that breaks an installed dependent needs the
 * owner's confirmation.
 *
 * `dependencyNodes` is what `PluginService.dependencyNodes` gives the
 * inspector in production: every installed plugin as read from disk — here
 * re-read after each install, as `noteInstalled` does.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPluginCollection, type PluginCollectionInspection, type PluginInspectResult } from "@dispatch/shared";
import { discoverPlugins } from "../manifest.js";
import type { FetchDeps } from "./fetch.js";
import type { NamedDependencyNode } from "./dependencies.js";
import { PluginInspector } from "./index.js";
import { chunked, gzip, makeTar, type TarEntry } from "./test-tar.js";

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const lsRemote = (sha: string) => [`ref: refs/heads/main\tHEAD`, `${sha}\tHEAD`, `${sha}\trefs/heads/main`].join("\n");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const REMOTE_HOST = (version: string, provides = "machines: [1]") =>
  `id: remote-host\nname: Remote host\nversion: ${version}\ndispatch: '>=1'\nprovides:\n  ${provides}\n`;
const PROXMOX = `id: proxmox-terminal\nname: Proxmox terminal\nversion: 0.2.0\ndispatch: '>=1'\ndependencies:\n  remote-host:\n    uses: [machines@1]\n    version: ">=0.10.0"\n`;

function tarAt(sha: string, files: Record<string, string>): FetchDeps {
  const prefix = `o-r-${sha.slice(0, 7)}`;
  const entries: TarEntry[] = Object.entries(files).map(([name, body]) => ({ name: `${prefix}/${name}`, body }));
  const tar = makeTar(entries, { comment: sha });
  return { lsRemote: async () => lsRemote(sha), githubTarball: async () => chunked(gzip(tar)), gitArchive: async () => chunked(tar) };
}

/** A host as far as the inspector sees one: plugins on disk, judged as the service judges them. */
async function host() {
  const configDir = await mkdtemp(join(tmpdir(), "dispatch-deps-install-"));
  dirs.push(configDir);
  let nodes: NamedDependencyNode[] = [];
  const reread = async () => {
    nodes = (await discoverPlugins(configDir)).map((p) => ({
      id: p.id,
      ...(p.manifest?.name ? { name: p.manifest.name } : {}),
      ...(p.manifest?.version ? { version: p.manifest.version } : {}),
      valid: !!p.manifest && !p.incompatible,
      enabled: true,
      ...(p.manifest?.dependencies ? { dependencies: p.manifest.dependencies } : {}),
      ...(p.manifest?.provides ? { provides: p.manifest.provides } : {}),
    }));
  };
  const inspector = (fetchDeps: FetchDeps) =>
    new PluginInspector({
      configDir,
      hostInfo: () => undefined,
      noteInstalled: async () => {
        await reread();
        return undefined;
      },
      recordSource: async () => {},
      dependencyNodes: () => nodes,
      fetchDeps,
    });
  return { inspector };
}

const COLLECTION = "https://github.com/o/r/tree/main/plugins";
const collectionFiles = (rh = REMOTE_HOST("0.10.0")) => ({
  "plugins/remote-host/plugin.yaml": rh,
  "plugins/proxmox-terminal/plugin.yaml": PROXMOX,
});

function asCollection(r: PluginInspectResult): PluginCollectionInspection {
  if (!isPluginCollection(r)) throw new Error("expected a collection");
  return r;
}
const member = (c: PluginCollectionInspection, id: string) => c.plugins.find((p) => p.report?.id === id)!.report!;

describe("a collection with a provider and its consumer", () => {
  it("resolves the consumer's dependency from its sibling, with the consent sentences on both", async () => {
    const h = await host();
    const c = asCollection(await h.inspector(tarAt(SHA, collectionFiles())).inspect(COLLECTION));
    const proxmox = member(c, "proxmox-terminal");
    expect(proxmox.installable).toBe(true);
    expect(proxmox.dependencies).toEqual([
      expect.objectContaining({
        id: "remote-host",
        from: "collection",
        state: "ok",
        found: "0.10.0",
        range: ">=0.10.0",
        name: "Remote host",
        subdir: "plugins/remote-host",
        line: "Uses Remote host (remote-host) — its `machines` API v1. Remote host acts on what this plugin hands it.",
      }),
    ]);
    const rh = member(c, "remote-host");
    expect(rh.provides).toEqual(["machines@1"]);
    expect(rh.providesLine).toBe("Lets other plugins use: `machines` v1.");
  });

  it("refuses the consumer posted alone — the provider goes first — and takes it once the provider is in", async () => {
    const h = await host();
    const ins = h.inspector(tarAt(SHA, collectionFiles()));
    await expect(ins.install(COLLECTION, SHA, false, "plugins/proxmox-terminal")).rejects.toMatchObject({
      status: 409,
      message:
        "not installable: needs remote-host (machines@1): remote-host is not installed — install remote-host first, or install this from a collection that has it",
    });
    await ins.install(COLLECTION, SHA, false, "plugins/remote-host");
    await expect(ins.install(COLLECTION, SHA, false, "plugins/proxmox-terminal")).resolves.toMatchObject({ id: "proxmox-terminal" });
  });

  it("an installed provider too old for the consumer is replaced from the collection, and judged by its NEW files", async () => {
    const h = await host();
    await h.inspector(tarAt(SHA2, { "plugins/remote-host/plugin.yaml": REMOTE_HOST("0.9.2") })).install(COLLECTION, SHA2, false, "plugins/remote-host");
    const ins = h.inspector(tarAt(SHA, collectionFiles()));
    const c = asCollection(await ins.inspect(COLLECTION));
    expect(member(c, "proxmox-terminal").dependencies?.[0]).toMatchObject({ from: "collection", found: "0.10.0" });
    expect(member(c, "proxmox-terminal").dependencies?.[0]?.detail).toContain("replacing the installed v0.9.2");
    await ins.install(COLLECTION, SHA, true, "plugins/remote-host");
    await expect(ins.install(COLLECTION, SHA, false, "plugins/proxmox-terminal")).resolves.toMatchObject({ id: "proxmox-terminal" });
  });

  it("a provider replacement that drops a major the consumer uses is refused until the owner confirms it", async () => {
    const h = await host();
    const v1 = h.inspector(tarAt(SHA, collectionFiles()));
    await v1.install(COLLECTION, SHA, false, "plugins/remote-host");
    await v1.install(COLLECTION, SHA, false, "plugins/proxmox-terminal");

    const v2 = h.inspector(tarAt(SHA2, collectionFiles(REMOTE_HOST("1.0.0", "machines: [2]"))));
    const report = member(asCollection(await v2.inspect(COLLECTION)), "remote-host");
    expect(report.breaks).toEqual([{ id: "proxmox-terminal", detail: expect.stringContaining("does not provide machines@1") }]);
    await expect(v2.install(COLLECTION, SHA2, true, "plugins/remote-host")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(`breaks "proxmox-terminal"`),
    });
    await expect(v2.install(COLLECTION, SHA2, true, "plugins/remote-host", true)).resolves.toMatchObject({ outcome: "replaced" });
  });

  it("a cached report is judged again on read: a provider installed since makes the consumer installable on its own", async () => {
    const h = await host();
    const single = h.inspector(tarAt(SHA, { "plugins/proxmox-terminal/plugin.yaml": PROXMOX }));
    const cached = await single.inspect("https://github.com/o/r/tree/main/plugins/proxmox-terminal");
    if (isPluginCollection(cached)) throw new Error("expected one plugin");
    expect(cached.installable).toBe(false);
    await h.inspector(tarAt(SHA2, { "plugins/remote-host/plugin.yaml": REMOTE_HOST("0.10.0") })).install(COLLECTION, SHA2, false, "plugins/remote-host");
    const now = single.judged(cached);
    expect(now.installable).toBe(true);
    expect(now.refusal).toBeUndefined();
    expect(now.dependencies?.[0]).toMatchObject({ from: "installed", found: "0.10.0" });
  });
});

