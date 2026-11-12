import { describe, expect, it } from "vitest";
import type { PluginCollectionEntry, PluginInfo, PluginInspection, PluginInspectionDependency } from "@dispatch/shared";
import { collectionPicks, dependentsReach, skippedFor } from "./pluginDependencyPlan.js";

const dep = (id: string, subdir: string | undefined, extra: Partial<PluginInspectionDependency> = {}): PluginInspectionDependency => ({
  id,
  uses: ["machines@1"],
  optional: false,
  state: "ok",
  detail: "",
  from: subdir === undefined ? "installed" : "collection",
  line: "",
  ...(subdir !== undefined ? { subdir } : {}),
  ...extra,
});
const entry = (id: string, dependencies: PluginInspectionDependency[] = [], installed = false): PluginCollectionEntry => ({
  subdir: `plugins/${id}`,
  report: {
    id,
    name: id.toUpperCase(),
    dependencies,
    ...(installed ? { installed: { version: "0.9.2", comparison: "newer" } } : {}),
  } as unknown as PluginInspection,
});

const RH = entry("remote-host");
const PROXMOX = entry("proxmox-terminal", [dep("remote-host", "plugins/remote-host")]);

describe("collectionPicks", () => {
  it("ticking the consumer ticks its required provider, locked, and installs the provider first", () => {
    const picks = collectionPicks([PROXMOX, RH], new Set([PROXMOX.subdir]));
    expect(picks.map((p) => [p.entry.report!.id, p.why, p.neededBy])).toEqual([
      ["remote-host", "required", ["PROXMOX-TERMINAL"]],
      ["proxmox-terminal", "picked", []],
    ]);
  });

  it("an optional one is recommended — and stays out once declined", () => {
    const consumer = entry("proxmox-terminal", [dep("remote-host", "plugins/remote-host", { optional: true })]);
    expect(collectionPicks([consumer, RH], new Set([consumer.subdir])).map((p) => p.why)).toEqual(["recommended", "picked"]);
    expect(collectionPicks([consumer, RH], new Set([consumer.subdir]), new Set([RH.subdir])).map((p) => p.entry.subdir)).toEqual([
      consumer.subdir,
    ]);
  });

  it("a provider the owner ticked too reads as picked, whichever row comes first", () => {
    const picks = collectionPicks([PROXMOX, RH], new Set([PROXMOX.subdir, RH.subdir]));
    expect(picks.map((p) => [p.entry.report!.id, p.why])).toEqual([
      ["remote-host", "picked"],
      ["proxmox-terminal", "picked"],
    ]);
  });

  it("takes nothing for a dependency an installed plugin already satisfies, and replaces an older installed copy it needs", () => {
    const satisfied = entry("proxmox-terminal", [dep("remote-host", undefined)]);
    expect(collectionPicks([satisfied, RH], new Set([satisfied.subdir])).map((p) => p.entry.report!.id)).toEqual(["proxmox-terminal"]);
    const oldRh = entry("remote-host", [], true);
    const [first] = collectionPicks([PROXMOX, oldRh], new Set([PROXMOX.subdir]));
    expect(first).toMatchObject({ why: "required", replace: true });
  });

  it("follows a chain: what the provider needs comes first of all", () => {
    const base = entry("base");
    const rh = entry("remote-host", [dep("base", "plugins/base")]);
    const picks = collectionPicks([PROXMOX, rh, base], new Set([PROXMOX.subdir]));
    expect(picks.map((p) => p.entry.report!.id)).toEqual(["base", "remote-host", "proxmox-terminal"]);
  });
});

describe("skippedFor", () => {
  it("skips a pick whose required provider failed; an optional one failing does not", () => {
    const picks = collectionPicks([PROXMOX, RH], new Set([PROXMOX.subdir]));
    expect(skippedFor(picks[1]!, new Set([RH.subdir]), picks)).toBe("REMOTE-HOST");
    expect(skippedFor(picks[1]!, new Set(), picks)).toBeUndefined();
    const optional = entry("x", [dep("remote-host", "plugins/remote-host", { optional: true })]);
    const p2 = collectionPicks([optional, RH], new Set([optional.subdir]));
    expect(skippedFor(p2[1]!, new Set([RH.subdir]), p2)).toBeUndefined();
  });
});

describe("dependentsReach", () => {
  const info = (id: string, deps: Array<{ id: string; optional?: boolean }> = []) =>
    ({ id, name: id, dependencies: deps.map((d) => ({ id: d.id, uses: [], optional: !!d.optional, state: "ok", detail: "" })) }) as unknown as PluginInfo;

  it("stops required users through a chain; optional users run with less", () => {
    const all = [
      info("remote-host"),
      info("proxmox-terminal", [{ id: "remote-host" }]),
      info("top", [{ id: "proxmox-terminal" }]),
      info("dash", [{ id: "remote-host", optional: true }]),
    ];
    const r = dependentsReach("remote-host", all);
    expect(r.stops.map((p) => p.id)).toEqual(["proxmox-terminal", "top"]);
    expect(r.degrades.map((p) => p.id)).toEqual(["dash"]);
    expect(dependentsReach("dash", all)).toEqual({ stops: [], degrades: [] });
  });
});
