import { describe, expect, it } from "vitest";
import {
  compareSemver,
  isValidSemverRange,
  liveDependencyState,
  parsePluginUse,
  resolvePluginDependencies,
  semverRangeAccepts,
  type PluginDependencyNode,
} from "./plugin-dependencies.js";
import { PluginManifestSchema } from "./plugin-manifest.js";

describe("semverRangeAccepts", () => {
  const cases: Array<[string, string, boolean]> = [
    [">=0.10.0", "0.10.0", true],
    [">=0.10.0", "0.9.2", false],
    [">=0.10.0", "1.4.0", true],
    [">=0.10.0 <1", "0.12.3", true],
    [">=0.10.0 <1", "1.0.0", false],
    [">0.10.0", "0.10.0", false],
    [">0.10", "0.10.9", false],
    [">0.10", "0.11.0", true],
    ["<=1.2", "1.2.9", true],
    ["<=1.2", "1.3.0", false],
    ["1.2.3", "1.2.3", true],
    ["=1.2.3", "1.2.4", false],
    ["1.2", "1.2.7", true],
    ["1.2", "1.3.0", false],
    ["1", "1.9.9", true],
    ["1.x", "2.0.0", false],
    ["^1.2.3", "1.9.0", true],
    ["^1.2.3", "2.0.0", false],
    ["^1.2.3", "1.2.2", false],
    ["^0.10.0", "0.10.5", true],
    ["^0.10.0", "0.11.0", false],
    ["^0.0.3", "0.0.4", false],
    ["^1", "1.5.0", true],
    ["~1.2.3", "1.2.9", true],
    ["~1.2.3", "1.3.0", false],
    ["~1", "1.9.0", true],
    ["*", "3.1.4", true],
    ["v1.2.3", "1.2.3", true],
  ];
  it.each(cases)("%s admits %s → %s", (range, version, want) => {
    expect(semverRangeAccepts(range, version)).toBe(want);
  });

  it("keeps prereleases out unless a clause names one of the same x.y.z (npm's rule)", () => {
    expect(semverRangeAccepts(">=0.10.0", "0.11.0-beta.1")).toBe(false);
    expect(semverRangeAccepts("^0.10.0", "0.10.1-rc.1")).toBe(false);
    expect(semverRangeAccepts(">=0.11.0-beta.0", "0.11.0-beta.1")).toBe(true);
    expect(semverRangeAccepts(">=0.11.0-beta.0", "0.12.0-beta.1")).toBe(false);
    // The `-0` floor a partial bound is written with is not "naming a prerelease".
    expect(semverRangeAccepts("<1", "1.0.0-alpha")).toBe(false);
  });

  it("refuses what it cannot read, on either side", () => {
    for (const bad of ["", "  ", ">=", "1.2-beta", "||", ">= 1", "1.x.3", "latest", ">=1 || >=2"]) {
      expect(isValidSemverRange(bad)).toBe(false);
      expect(semverRangeAccepts(bad, "1.0.0")).toBe(false);
    }
    expect(semverRangeAccepts(">=1", "one")).toBe(false);
  });

  it("orders versions by semver precedence, numeric prerelease fields below alphanumeric", () => {
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.10", "1.0.0-alpha.9")).toBe(1);
    expect(compareSemver("1.0.0+build.5", "1.0.0")).toBe(0);
    expect(compareSemver("x", "1.0.0")).toBeNull();
  });
});

describe("parsePluginUse", () => {
  it("reads name@major and nothing else", () => {
    expect(parsePluginUse("machines@1")).toEqual({ name: "machines", major: 1 });
    expect(parsePluginUse("machines@0")).toBeNull();
    expect(parsePluginUse("machines")).toBeNull();
    expect(parsePluginUse("Machines@1")).toBeNull();
  });
});

const node = (id: string, extra: Partial<PluginDependencyNode> = {}): PluginDependencyNode => ({
  id,
  version: "1.0.0",
  valid: true,
  enabled: true,
  ...extra,
});

describe("resolvePluginDependencies", () => {
  it("orders a provider before its consumer even when the consumer's id sorts first", () => {
    const r = resolvePluginDependencies([
      node("proxmox-terminal", { dependencies: { "remote-host": { uses: ["machines@1"], optional: true } } }),
      node("remote-host", { version: "0.10.0", provides: { machines: [1] } }),
      node("aardvark"),
    ]);
    expect(r.order).toEqual(["aardvark", "remote-host", "proxmox-terminal"]);
    expect(r.dependencies.get("proxmox-terminal")).toEqual([
      { id: "remote-host", uses: ["machines@1"], optional: true, state: "ok", detail: "" },
    ]);
    expect(r.blocked.size).toBe(0);
    expect(r.dependents.get("remote-host")).toEqual(["proxmox-terminal"]);
  });

  it("names each way a required dependency can be missing, and blocks the consumer for it", () => {
    const uses = { uses: ["machines@1"] };
    const r = resolvePluginDependencies([
      node("a", { dependencies: { gone: uses } }),
      node("b", { dependencies: { off: uses } }),
      node("c", { dependencies: { broken: uses } }),
      node("d", { dependencies: { old: { ...uses, version: ">=0.10.0" } } }),
      node("e", { dependencies: { next: uses } }),
      node("off", { enabled: false, provides: { machines: [1] } }),
      node("broken", { valid: false, version: undefined }),
      node("old", { version: "0.9.2", provides: { machines: [1] } }),
      node("next", { provides: { machines: [2] } }),
    ]);
    const state = (id: string) => r.dependencies.get(id)![0]!;
    expect(state("a")).toMatchObject({ state: "missing", detail: "gone is not installed" });
    expect(state("b")).toMatchObject({ state: "disabled" });
    expect(state("c")).toMatchObject({ state: "invalid" });
    expect(state("d")).toMatchObject({ state: "incompatible", detail: "old 0.9.2 is installed; this needs >=0.10.0" });
    expect(state("e")).toMatchObject({ state: "incompatible" });
    expect(state("e").detail).toContain("it provides machines@2");
    for (const id of ["a", "b", "c", "d", "e"]) expect(r.blocked.get(id)).toContain("needs ");
    expect(r.blocked.get("b")).toBe("needs off (machines@1): off is switched off");
  });

  it("does not block for an optional dependency, and does not block a plugin that is off or invalid", () => {
    const r = resolvePluginDependencies([
      node("a", { dependencies: { gone: { uses: ["x@1"], optional: true } } }),
      node("b", { enabled: false, dependencies: { gone: { uses: ["x@1"] } } }),
    ]);
    expect(r.dependencies.get("a")![0]!.state).toBe("missing");
    expect(r.blocked.has("a")).toBe(false);
    expect(r.blocked.has("b")).toBe(false);
  });

  it("blocks transitively, saying which link broke", () => {
    const r = resolvePluginDependencies([
      node("top", { dependencies: { mid: { uses: ["m@1"] } } }),
      node("mid", { provides: { m: [1] }, dependencies: { base: { uses: ["b@1"] } } }),
      node("base", { enabled: false, provides: { b: [1] } }),
    ]);
    expect(r.order).toEqual(["base", "mid", "top"]);
    expect(r.blocked.get("mid")).toContain("base is switched off");
    expect(r.dependencies.get("top")![0]).toMatchObject({ state: "blocked" });
    expect(r.blocked.get("top")).toContain("mid is blocked");
  });

  it("blocks every plugin on a required cycle and names the cycle; an optional edge on one only reports it", () => {
    const r = resolvePluginDependencies([
      node("a", { provides: { x: [1] }, dependencies: { b: { uses: ["y@1"] } } }),
      node("b", { provides: { y: [1] }, dependencies: { c: { uses: ["z@1"] } } }),
      node("c", { provides: { z: [1] }, dependencies: { a: { uses: ["x@1"] } } }),
      node("after", { dependencies: { a: { uses: ["x@1"] } } }),
      node("p", { provides: { q: [1] }, dependencies: { q: { uses: ["r@1"], optional: true } } }),
      node("q", { provides: { r: [1] }, dependencies: { p: { uses: ["q@1"] } } }),
    ]);
    expect(r.dependencies.get("a")![0]).toMatchObject({ state: "cycle", detail: "dependency cycle: a → b → c → a" });
    expect(r.blocked.has("a") && r.blocked.has("b") && r.blocked.has("c")).toBe(true);
    // Downstream of a cycle: blocked, because what it needs is.
    expect(r.blocked.get("after")).toContain("a is blocked");
    // An optional edge closing a cycle is the one that gives: it is reported,
    // and blocks nobody. `q` REQUIRES `p`, and without the optional edge back
    // there is no cycle — so `p` starts, then `q`.
    expect(r.dependencies.get("p")![0]).toMatchObject({
      state: "cycle",
      detail: "dependency cycle: p → q → p (an optional use, so p starts without it)",
    });
    expect(r.blocked.has("p")).toBe(false);
    expect(r.blocked.has("q")).toBe(false);
    expect(r.dependencies.get("q")![0]!.state).toBe("ok");
    expect(r.order.indexOf("p")).toBeLessThan(r.order.indexOf("q"));
    // Every node is still in the order exactly once.
    expect([...r.order].sort()).toEqual(["a", "after", "b", "c", "p", "q"]);
    expect(r.order.indexOf("after")).toBeGreaterThan(r.order.indexOf("a"));
  });

  it("inside a loop an optional use closes, starts each plugin after what it requires — not in id order", () => {
    const r = resolvePluginDependencies([
      // `zz-host` sorts last but is required by `aa-term`; `zz-host` only likes `aa-term` back.
      node("zz-host", { provides: { m: [1] }, dependencies: { "aa-term": { uses: ["t@1"], optional: true } } }),
      node("aa-term", { provides: { t: [1] }, dependencies: { "zz-host": { uses: ["m@1"] } } }),
    ]);
    expect(r.order).toEqual(["zz-host", "aa-term"]);
    expect(r.blocked.size).toBe(0);
    expect(r.dependencies.get("aa-term")![0]!.state).toBe("ok");
    expect(r.dependencies.get("zz-host")![0]!.state).toBe("cycle");
  });

  it("lets a built-in depend only on built-ins", () => {
    const r = resolvePluginDependencies([
      node("codex", { builtin: true, dependencies: { helper: { uses: ["h@1"] } } }),
      node("helper", { provides: { h: [1] } }),
    ]);
    expect(r.dependencies.get("codex")![0]!.state).toBe("incompatible");
    expect(r.blocked.has("codex")).toBe(true);
  });
});

describe("liveDependencyState", () => {
  const ok = { id: "remote-host", uses: ["machines@1"], optional: false, state: "ok" as const, detail: "" };
  it("turns an ok-on-paper provider into what is actually running", () => {
    expect(liveDependencyState(ok, { phase: "active", enabled: true })).toBe(ok);
    expect(liveDependencyState(ok, { phase: "error", enabled: true, error: "boom" })).toMatchObject({
      state: "failed",
      detail: "remote-host failed to start: boom",
    });
    expect(liveDependencyState(ok, { phase: "active", enabled: false }).state).toBe("disabled");
    expect(liveDependencyState(ok, { phase: "inactive", enabled: true }).state).toBe("disabled");
    expect(liveDependencyState(ok, { phase: "blocked", enabled: true }).state).toBe("blocked");
  });
  it("a provider that came up without serving a used export is not-served, naming what is missing", () => {
    const served = new Set(["machines@2"]);
    expect(liveDependencyState(ok, { phase: "active", enabled: true }, served)).toMatchObject({
      state: "not-served",
      detail: "remote-host did not serve machines@1",
    });
    expect(liveDependencyState(ok, { phase: "active", enabled: true }, new Set(["machines@1"]))).toBe(ok);
    // Not known until its activate resolved: no `served`, no verdict.
    expect(liveDependencyState(ok, { phase: "active", enabled: true }, undefined)).toBe(ok);
  });
});

describe("the manifest's dependencies and provides", () => {
  const base = { id: "proxmox-terminal", name: "P", version: "0.2.0", dispatch: ">=1" };
  it("accepts the documented shape", () => {
    const m = PluginManifestSchema.parse({
      ...base,
      dependencies: { "remote-host": { uses: ["machines@1"], version: ">=0.10.0 <1", optional: true } },
      provides: { machines: [1, 2] },
    });
    expect(m.dependencies?.["remote-host"]?.uses).toEqual(["machines@1"]);
    expect(m.provides?.machines).toEqual([1, 2]);
  });

  it("refuses a self-dependency, a bad use, a bad range, a reserved id and an empty uses", () => {
    const bad = (extra: Record<string, unknown>) => PluginManifestSchema.safeParse({ ...base, ...extra }).success;
    expect(bad({ dependencies: { "proxmox-terminal": { uses: ["x@1"] } } })).toBe(false);
    expect(bad({ dependencies: { "remote-host": { uses: ["machines"] } } })).toBe(false);
    expect(bad({ dependencies: { "remote-host": { uses: ["machines@1"], version: "latest" } } })).toBe(false);
    expect(bad({ dependencies: { "dispatch-x": { uses: ["x@1"] } } })).toBe(false);
    expect(bad({ dependencies: { "remote-host": { uses: [] } } })).toBe(false);
    expect(bad({ provides: { Machines: [1] } })).toBe(false);
    expect(bad({ provides: { machines: [0] } })).toBe(false);
  });

  it("is stripped, not refused, by a schema that predates it (older hosts load the plugin)", () => {
    // What an older host does: the same object schema, minus these keys, non-strict.
    const m = PluginManifestSchema.parse({ ...base, somethingNewer: { a: 1 } });
    expect((m as Record<string, unknown>).somethingNewer).toBeUndefined();
  });
});
