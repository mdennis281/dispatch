/**
 * What the owner reads about dependencies before installing or updating: the
 * consent sentences, and how an update's dependency changes are graded.
 */
import { describe, expect, it } from "vitest";
import { pluginDependencyLine, pluginProvidesLine } from "./plugin-inspection.js";
import { diffPluginSurfaces, type PluginSurface } from "./plugin-lifecycle.js";

describe("consent sentences", () => {
  it("names the provider and each API it uses, and says when it is optional", () => {
    expect(pluginDependencyLine({ id: "remote-host", uses: ["machines@1"] }, "Remote host")).toBe(
      "Uses Remote host (remote-host) — its `machines` API v1. Remote host acts on what this plugin hands it.",
    );
    expect(pluginDependencyLine({ id: "remote-host", uses: ["machines@1", "files@2"], optional: true })).toBe(
      "Uses remote-host — its `machines` API v1, its `files` API v2. remote-host acts on what this plugin hands it. Optional: it runs without it, with less.",
    );
  });

  it("says what a provider lets other plugins use, and nothing for one that exports nothing", () => {
    expect(pluginProvidesLine({ machines: [1], events: [1, 2] })).toBe("Lets other plugins use: `machines` v1, `events` v1 and v2.");
    expect(pluginProvidesLine({})).toBeUndefined();
    expect(pluginProvidesLine(undefined)).toBeUndefined();
  });
});

describe("diffPluginSurfaces — dependencies and exports", () => {
  const surface = (extra: Partial<PluginSurface> = {}): PluginSurface => ({
    version: "1.0.0",
    capabilities: [],
    secrets: [],
    oauth: [],
    contributions: { modes: [], skills: [], instructions: [], personas: [], mcpServers: [], processes: [] },
    mismatches: { undeclared: [], unused: [] },
    hooks: [],
    entries: {},
    ...extra,
  });
  const dep = (uses: string[], extra: { optional?: boolean; range?: string } = {}) => ({
    id: "remote-host",
    uses,
    optional: extra.optional ?? false,
    ...(extra.range ? { range: extra.range } : {}),
  });

  it("a new dependency, a newly used export and a new export are escalations — auto-update never takes them", () => {
    const d = diffPluginSurfaces(
      surface({ dependencies: [dep(["machines@1"])] }),
      surface({
        dependencies: [dep(["machines@1", "files@1"]), { id: "other", uses: ["x@1"], optional: true }],
        provides: ["machines@1"],
      }),
    );
    expect(d.escalations.map((c) => `${c.kind}:${c.change}:${c.label}`)).toEqual([
      "dependency:changed:uses:remote-host",
      "dependency:added:uses:other",
      "provides:added:provides:machines@1",
    ]);
    expect(d.escalations[0]!.detail).toBe("now also uses files@1");
  });

  it("dropping one, loosening one or dropping an export is a plain change", () => {
    const d = diffPluginSurfaces(
      surface({ dependencies: [dep(["machines@1"], { range: ">=0.10.0" })], provides: ["machines@1", "machines@2"] }),
      surface({ dependencies: [dep(["machines@1"], { optional: true, range: ">=0.11.0" })], provides: ["machines@2"] }),
    );
    expect(d.escalations).toEqual([]);
    expect(d.changes.map((c) => `${c.kind}:${c.change}:${c.label}:${c.detail}`)).toEqual([
      "dependency:changed:uses:remote-host:now optional; version >=0.11.0 (was >=0.10.0)",
      "provides:removed:provides:machines@1:a plugin using it stops working",
    ]);
  });
});
