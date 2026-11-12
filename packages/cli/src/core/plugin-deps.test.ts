/**
 * The CLI's dependency planning (design §1.4 "CLI"): what `add <collection>`
 * takes, in which order, what it refuses up front — and what it only warns
 * about, because the CLI cannot see the built-in plugins a user plugin may
 * depend on.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginManifest } from "@dispatch/shared";
import {
  dependencyCheck,
  dependentsOf,
  nodeOfManifest,
  parseWithDeps,
  planCollectionAdd,
  providersFirst,
  stillLacking,
  type NamedNode,
} from "./plugin-deps.js";
import type { CollectionMember } from "./plugins.js";

const manifest = (id: string, extra: Partial<PluginManifest> = {}): PluginManifest => ({
  id,
  name: id,
  version: "1.0.0",
  dispatch: ">=1",
  ...extra,
});
const RH = manifest("remote-host", { version: "0.10.0", provides: { machines: [1] } });
const PROXMOX = manifest("proxmox-terminal", {
  dependencies: { "remote-host": { uses: ["machines@1"], version: ">=0.10.0" } },
});
const member = (m: PluginManifest, path = `plugins/${m.id}`): CollectionMember => ({ path, id: m.id, version: m.version, name: m.name, manifest: m });

describe("planCollectionAdd", () => {
  const members = [member(PROXMOX), member(RH)];

  it("refuses a pick whose provider is in the collection but left out, naming both fixes", () => {
    const plan = planCollectionAdd(members, [member(PROXMOX)], [], "none");
    expect(plan.add).toEqual([]);
    expect(plan.refused).toEqual([
      { member: member(PROXMOX), reason: "needs remote-host (machines@1): add --plugin plugins/remote-host, or --with-deps" },
    ]);
  });

  it("--with-deps brings the provider in, and puts it first", () => {
    const plan = planCollectionAdd(members, [member(PROXMOX)], [], "required");
    expect(plan.add.map((m) => m.id)).toEqual(["remote-host", "proxmox-terminal"]);
    expect(plan.refused).toEqual([]);
  });

  it("picking both is enough, in either order — the provider still goes first", () => {
    const plan = planCollectionAdd(members, [member(PROXMOX), member(RH)], [], "none");
    expect(plan.add.map((m) => m.id)).toEqual(["remote-host", "proxmox-terminal"]);
  });

  it("takes nothing from the collection that an installed plugin already satisfies", () => {
    const plan = planCollectionAdd(members, [member(PROXMOX)], [nodeOfManifest(RH)], "required");
    expect(plan.add.map((m) => m.id)).toEqual(["proxmox-terminal"]);
  });

  it("replaces an installed provider too old for the pick — but only when asked", () => {
    const old = nodeOfManifest({ ...RH, version: "0.9.2" });
    expect(planCollectionAdd(members, [member(PROXMOX)], [old], "none").refused[0]?.reason).toBe(
      "needs remote-host (machines@1): add --plugin plugins/remote-host, or --with-deps",
    );
    expect(planCollectionAdd(members, [member(PROXMOX)], [old], "required").add.map((m) => m.id)).toEqual(["remote-host", "proxmox-terminal"]);
  });

  it("leaves a switched-off provider alone: switching it on is the fix, not a second copy", () => {
    const plan = planCollectionAdd(members, [member(PROXMOX)], [{ ...nodeOfManifest(RH), enabled: false }], "required");
    expect(plan.add.map((m) => m.id)).toEqual(["proxmox-terminal"]);
    expect(plan.refused).toEqual([]);
  });

  it("optional dependencies: a note without --with-deps=all, taken with it", () => {
    const optional = manifest("proxmox-terminal", { dependencies: { "remote-host": { uses: ["machines@1"], optional: true } } });
    const ms = [member(optional), member(RH)];
    const plain = planCollectionAdd(ms, [member(optional)], [], "required");
    expect(plain.add.map((m) => m.id)).toEqual(["proxmox-terminal"]);
    expect(plain.notes).toEqual([
      "proxmox-terminal can use remote-host (optional: machines@1) — add --plugin plugins/remote-host, or --with-deps=all",
    ]);
    expect(planCollectionAdd(ms, [member(optional)], [], "all").add.map((m) => m.id)).toEqual(["remote-host", "proxmox-terminal"]);
  });

  it("a dependency nothing has is a note, not a refusal — it may be a built-in the CLI cannot see", () => {
    const needsBuiltin = manifest("x", { dependencies: { "dispatch-voice": { uses: ["speech@1"] } } });
    const plan = planCollectionAdd([member(needsBuiltin)], [member(needsBuiltin)], [], "required");
    expect(plan.add.map((m) => m.id)).toEqual(["x"]);
    expect(plan.notes[0]).toMatch(/^x needs dispatch-voice \(speech@1\), which is not installed — .*built in/);
  });

  it("refuses what is certain — a collection provider that does not offer the export — and drops what it brought in", () => {
    const wrong = { ...RH, provides: { machines: [2] } };
    const plan = planCollectionAdd([member(PROXMOX), member(wrong)], [member(PROXMOX)], [], "required");
    // remote-host came in only for proxmox-terminal: never installed on its own account.
    expect(plan.add).toEqual([]);
    expect(plan.refused).toEqual([
      {
        member: member(PROXMOX),
        reason: "proxmox-terminal: needs remote-host (machines@1): in this collection, remote-host 0.10.0 does not provide machines@1 (it provides machines@2)",
      },
    ]);
  });

  it("a refused provider takes what needs it down too", () => {
    const top = manifest("top", { dependencies: { "proxmox-terminal": { uses: ["clones@1"] } } });
    const proxmox = { ...PROXMOX, provides: { clones: [1] } };
    const plan = planCollectionAdd([member(top), member(proxmox), member(RH)], [member(top), member(proxmox)], [], "none");
    expect(plan.add).toEqual([]);
    expect(plan.refused.map((r) => [r.member.id, r.reason])).toEqual([
      ["proxmox-terminal", "needs remote-host (machines@1): add --plugin plugins/remote-host, or --with-deps"],
      ["top", "needs proxmox-terminal, which is not being installed (above)"],
    ]);
  });
});

describe("providersFirst", () => {
  it("keeps the given order where nothing forces another, and survives a cycle", () => {
    const a = { id: "a", manifest: manifest("a", { dependencies: { c: { uses: ["x@1"] } } }) };
    const b = { id: "b", manifest: manifest("b") };
    const c = { id: "c", manifest: manifest("c", { dependencies: { a: { uses: ["y@1"], optional: true } } }) };
    expect(providersFirst([b, a, c]).map((m) => m.id)).toEqual(["b", "c", "a"]);
  });
});

describe("dependentsOf", () => {
  it("follows required uses through a chain; optional ones are listed apart", () => {
    const nodes: NamedNode[] = [
      nodeOfManifest(RH),
      nodeOfManifest(PROXMOX),
      nodeOfManifest(manifest("top", { dependencies: { "proxmox-terminal": { uses: ["clones@1"] } } })),
      nodeOfManifest(manifest("dash", { dependencies: { "remote-host": { uses: ["machines@1"], optional: true } } })),
    ];
    expect(dependentsOf(nodes, "remote-host")).toEqual({ required: ["proxmox-terminal", "top"], optional: ["dash"] });
    expect(dependentsOf(nodes, "dash")).toEqual({ required: [], optional: [] });
  });
});

describe("parseWithDeps", () => {
  it("bare is required, =all is all, anything else is a mistake", () => {
    expect(parseWithDeps(undefined)).toBe("none");
    expect(parseWithDeps("")).toBe("required");
    expect(parseWithDeps("all")).toBe("all");
    expect(() => parseWithDeps("some")).toThrow(/--with-deps takes no value, or "all"/);
  });
});

describe("dependencyCheck / stillLacking (against what is on disk)", () => {
  let configDir: string;
  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "cm-plugin-deps-"));
  });
  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });
  async function install(m: PluginManifest) {
    const dir = join(configDir, "plugins", m.id);
    await mkdir(dir, { recursive: true });
    const deps = m.dependencies
      ? `dependencies:\n${Object.entries(m.dependencies)
          .map(([id, d]) => `  ${id}:\n    uses: [${d.uses.join(", ")}]\n${d.version ? `    version: "${d.version}"\n` : ""}`)
          .join("")}`
      : "";
    const provides = m.provides
      ? `provides:\n${Object.entries(m.provides)
          .map(([n, majors]) => `  ${n}: [${majors.join(", ")}]\n`)
          .join("")}`
      : "";
    await writeFile(join(dir, "plugin.yaml"), `id: ${m.id}\nname: ${m.name}\nversion: ${m.version}\ndispatch: ">=1"\n${deps}${provides}`);
  }

  it("warns on an absent provider, refuses one too old", async () => {
    const check = dependencyCheck(configDir);
    expect((await check(PROXMOX))[0]).toMatch(/^proxmox-terminal needs remote-host \(machines@1\), which is not installed/);
    await install({ ...RH, version: "0.9.2" });
    await expect(check(PROXMOX)).rejects.toThrow(/^proxmox-terminal: needs remote-host \(machines@1\): .*0\.9\.2/);
    await install(RH);
    expect(await check(PROXMOX)).toEqual([]);
  });

  it("refuses a replace that breaks an installed user unless allowed, or that user comes along in the same run", async () => {
    await install(RH);
    await install(PROXMOX);
    const v1 = { ...RH, version: "1.0.0", provides: { machines: [2] } };
    await expect(dependencyCheck(configDir)(v1)).rejects.toThrow(
      /^replacing remote-host with v1\.0\.0 breaks proxmox-terminal \(.*\) — re-run with --allow-breaking/,
    );
    expect(await dependencyCheck(configDir, { allowBreaking: true })(v1)).toEqual([
      "replacing remote-host breaks proxmox-terminal — allowed by --allow-breaking",
    ]);
    expect(await dependencyCheck(configDir, { alsoAdding: new Set(["proxmox-terminal"]) })(v1)).toEqual([]);
  });

  it("stillLacking: a failed provider skips its user unless the installed copy still serves it", async () => {
    const failed = new Set(["remote-host"]);
    expect(await stillLacking(configDir, PROXMOX, failed)).toBe("remote-host");
    await install(RH);
    expect(await stillLacking(configDir, PROXMOX, failed)).toBeUndefined();
    expect(await stillLacking(configDir, PROXMOX, new Set())).toBeUndefined();
  });
});
