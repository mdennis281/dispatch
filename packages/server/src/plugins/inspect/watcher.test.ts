/**
 * The background update pass: which policy checks what, `auto` installing only
 * an update that asks for nothing new, one notice per new update (not one per
 * pass), and an unreachable or refused plugin never stopping the rest.
 */
import { describe, expect, it } from "vitest";
import type { PluginAutoUpdate, PluginInfo, PluginUpdateCheck, PluginUpdateResult } from "@dispatch/shared";
import { PluginUpdateWatcher, autoApplicable, pluginUpdateHours } from "./watcher.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function row(id: string, autoUpdate?: PluginAutoUpdate, origin: PluginInfo["origin"] = "url"): PluginInfo {
  return { id, name: id.toUpperCase(), origin, ...(autoUpdate ? { autoUpdate } : {}) } as PluginInfo;
}

function available(id: string, opts: { escalate?: boolean; sha?: string; installable?: boolean } = {}): PluginUpdateCheck {
  return {
    id,
    status: "available",
    origin: "url",
    current: { ref: "main", refKind: "branch", sha: SHA_A, version: "1.0.0" },
    target: { ref: "main", sha: opts.sha ?? SHA_B, version: "1.1.0" },
    diff: {
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      escalations: opts.escalate ? [{ kind: "capability", change: "added", label: "chats:write", escalation: true }] : [],
      changes: [],
    },
    inspection: { id, installable: opts.installable ?? true } as PluginUpdateCheck["inspection"],
    checkedAt: 1,
  };
}

function harness(rows: PluginInfo[], checks: Record<string, PluginUpdateCheck | Error>, opts: { updateFails?: string[] } = {}) {
  const checked: string[] = [];
  const updated: string[] = [];
  const notices: string[] = [];
  const watcher = new PluginUpdateWatcher({
    intervalHours: 6,
    list: () => rows,
    notice: (_level, text) => void notices.push(text),
    inspector: {
      checkUpdate: async (id) => {
        checked.push(id);
        const c = checks[id];
        if (c instanceof Error) throw c;
        return c ?? { id, status: "up-to-date", origin: "url", checkedAt: 1 };
      },
      update: async (id, sha): Promise<PluginUpdateResult> => {
        if (opts.updateFails?.includes(id)) throw new Error("main has moved since you checked");
        updated.push(`${id}@${sha}`);
        return { id, fromSha: SHA_A, sha, ref: "main", needsRestart: true };
      },
    },
  });
  return { watcher, checked, updated, notices };
}

describe("pluginUpdateHours", () => {
  it("defaults to 6, honours 0 as off, and does not read garbage as off", () => {
    expect(pluginUpdateHours({})).toBe(6);
    expect(pluginUpdateHours({ DISPATCH_PLUGIN_UPDATE_HOURS: "0" })).toBe(0);
    expect(pluginUpdateHours({ DISPATCH_PLUGIN_UPDATE_HOURS: "1.5" })).toBe(1.5);
    expect(pluginUpdateHours({ DISPATCH_PLUGIN_UPDATE_HOURS: "soon" })).toBe(6);
    expect(pluginUpdateHours({ DISPATCH_PLUGIN_UPDATE_HOURS: "-2" })).toBe(6);
  });
});

describe("autoApplicable", () => {
  it("takes only an installable, same-id update that asks for nothing new", () => {
    expect(autoApplicable(available("p"))).toBe(true);
    expect(autoApplicable(available("p", { escalate: true }))).toBe(false);
    expect(autoApplicable(available("p", { installable: false }))).toBe(false);
    expect(autoApplicable({ ...available("p"), inspection: { id: "other", installable: true } as PluginUpdateCheck["inspection"] })).toBe(false);
    expect(autoApplicable({ id: "p", status: "up-to-date", origin: "url", checkedAt: 1 })).toBe(false);
  });
});

describe("PluginUpdateWatcher", () => {
  it("skips off and non-URL plugins, installs a safe auto update, and only announces the rest", async () => {
    const h = harness(
      [row("quiet", "off"), row("linked", undefined, "linked"), row("safe", "auto"), row("asks", "auto"), row("told")],
      { safe: available("safe"), asks: available("asks", { escalate: true }), told: available("told") },
    );
    await h.watcher.run();
    expect(h.checked).toEqual(["safe", "asks", "told"]);
    expect(h.updated).toEqual([`safe@${SHA_B}`]);
    const s = h.watcher.status();
    expect(Object.keys(s.applied)).toEqual(["safe"]);
    expect(s.applied.safe).toMatchObject({ fromSha: SHA_A, sha: SHA_B, fromVersion: "1.0.0", version: "1.1.0" });
    expect(Object.keys(s.checks).sort()).toEqual(["asks", "told"]);
    expect(h.notices).toEqual([
      "Updated plugin SAFE to v1.1.0. Restart Dispatch to load it.",
      "Plugin updates available: ASKS, TOLD — some ask for more access. Review in Settings → Plugins.",
    ]);
  });

  it("announces an update once, and again only when it moves to a new commit", async () => {
    const checks: Record<string, PluginUpdateCheck> = { p: available("p") };
    const h = harness([row("p")], checks);
    await h.watcher.run();
    await h.watcher.run();
    expect(h.notices).toHaveLength(1);
    checks.p = available("p", { sha: "c".repeat(40) });
    await h.watcher.run();
    expect(h.notices).toHaveLength(2);
  });

  it("keeps going past a plugin whose check throws, and announces an auto update it could not install", async () => {
    const h = harness([row("broken", "auto"), row("raced", "auto"), row("fine")], { broken: new Error("gone"), raced: available("raced"), fine: available("fine") }, { updateFails: ["raced"] });
    await h.watcher.run();
    const s = h.watcher.status();
    expect(s.checks.broken).toMatchObject({ status: "error", message: "gone" });
    expect(s.checks.raced?.message).toMatch(/auto-update failed: main has moved/);
    expect(s.applied).toEqual({});
    expect(h.notices).toEqual(["Plugin updates available: RACED, FINE. Review in Settings → Plugins."]);
  });

  it("forgets a plugin that was uninstalled or switched off since the last pass", async () => {
    const rows = [row("a"), row("b")];
    const h = harness(rows, { a: available("a"), b: available("b") });
    await h.watcher.run();
    rows.splice(1, 1);
    rows[0] = row("a", "off");
    await h.watcher.run();
    expect(h.watcher.status().checks).toEqual({});
  });

  it("joins a pass already running instead of starting a second", async () => {
    const h = harness([row("p")], { p: available("p") });
    await Promise.all([h.watcher.run(), h.watcher.run()]);
    expect(h.checked).toEqual(["p"]);
  });

  it("does not arm when the interval is 0, and stop() makes run() a no-op", async () => {
    const off = new PluginUpdateWatcher({ intervalHours: 0, list: () => [row("p")], notice: () => {}, inspector: harness([], {}).watcher["opts"].inspector });
    off.start();
    expect(off.status()).toMatchObject({ intervalHours: 0, running: false });
    expect(off.status().nextRunAt).toBeUndefined();
    const h = harness([row("p")], { p: available("p") });
    h.watcher.stop();
    await h.watcher.run();
    expect(h.checked).toEqual([]);
  });
});
