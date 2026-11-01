/**
 * `ctx.instance` (E25). The case that matters is the COPIED data dir: dev's
 * `.data` seeded from stable's brings stable's `instance.json` with it, and a
 * plugin namespacing remote work by a copied id lets dev's orphan sweep reap
 * stable's live sessions. Real directories throughout, because the defence is
 * the filesystem's own file ids.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTANCE_FILE, instanceRole, resolveInstance } from "./instance.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "dispatch-instance-"));
  roots.push(r);
  return r;
}

/** Nobody's installed deployment: keeps `role` off the developer's real install. */
const ENV = { DISPATCH_HOME: join(tmpdir(), "dispatch-instance-no-install") };
const resolve = (dataDir: string, extra: { hostname?: string; dev?: boolean } = {}) =>
  resolveInstance({ dataDir, env: ENV, hostname: "box", log: () => {}, ...extra });

describe("resolveInstance", () => {
  it("mints an id once and keeps it, and its fingerprint, across restarts", () => {
    const dataDir = join(root(), "data");
    const first = resolve(dataDir);
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.dataDirFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(first.previousId).toBeUndefined();
    expect(first.reminted).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dataDir, INSTANCE_FILE), "utf8")).id).toBe(first.id);

    expect(resolve(dataDir)).toEqual(first);
  });

  it("gives a COPIED data dir its own id, and names the original's as previousId", () => {
    const r = root();
    const stable = join(r, "stable-data");
    const dev = join(r, "dev-data");
    const original = resolve(stable);
    cpSync(stable, dev, { recursive: true });

    const copy = resolve(dev, { dev: true });
    expect(copy.id).not.toBe(original.id);
    expect(copy.dataDirFingerprint).not.toBe(original.dataDirFingerprint);
    expect(copy.previousId).toBe(original.id);
    expect(copy.reminted).toEqual({ at: expect.any(String), reason: "copied" });

    // Both keep what they now have: the original is untouched, the copy's new id sticks.
    expect(resolve(stable)).toEqual(original);
    expect(resolve(dev, { dev: true })).toEqual(copy);
  });

  it("keeps the id through a rename on the same volume, though the fingerprint follows the path", () => {
    const r = root();
    const before = resolve(join(r, "data"));
    renameSync(join(r, "data"), join(r, "data-renamed"));

    const after = resolve(join(r, "data-renamed"));
    expect(after.id).toBe(before.id);
    expect(after.reminted).toBeUndefined();
    expect(after.dataDirFingerprint).not.toBe(before.dataDirFingerprint);
  });

  it("keeps the id through a restore in place: a new directory at the same path", () => {
    const r = root();
    const dataDir = join(r, "data");
    const before = resolve(dataDir);
    cpSync(dataDir, join(r, "backup"), { recursive: true });
    rmSync(dataDir, { recursive: true });
    cpSync(join(r, "backup"), dataDir, { recursive: true });

    const after = resolve(dataDir);
    expect(after.id).toBe(before.id);
    expect(after.reminted).toBeUndefined();
  });

  it("re-mints as `moved` when the directory it was minted for no longer holds the id", () => {
    const r = root();
    const original = resolve(join(r, "old"));
    // A move across volumes is a copy plus a delete: a new file id at a new path.
    cpSync(join(r, "old"), join(r, "new"), { recursive: true });
    rmSync(join(r, "old"), { recursive: true });

    const moved = resolve(join(r, "new"));
    expect(moved.id).not.toBe(original.id);
    expect(moved.previousId).toBe(original.id);
    expect(moved.reminted?.reason).toBe("moved");
  });

  it("re-mints as `hostname` when the record names another machine", () => {
    const dataDir = join(root(), "data");
    const before = resolve(dataDir, { hostname: "old-pc" });
    const after = resolve(dataDir, { hostname: "new-pc" });
    expect(after.id).not.toBe(before.id);
    expect(after.previousId).toBe(before.id);
    expect(after.reminted?.reason).toBe("hostname");
    // Host names compare case-insensitively: Windows reports either.
    expect(resolve(dataDir, { hostname: "NEW-PC" }).id).toBe(after.id);
  });

  it("mints a fresh id over an unreadable record, and says so", () => {
    const dataDir = join(root(), "data");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, INSTANCE_FILE), "{ not json");
    const lines: string[] = [];
    const fresh = resolveInstance({ dataDir, env: ENV, hostname: "box", log: (l) => lines.push(l) });
    expect(fresh.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh.previousId).toBeUndefined();
    expect(lines.join("\n")).toMatch(/unreadable/);
  });
});

describe("instanceRole", () => {
  it("is stable for the installed deployment's data dir, dev for pnpm dev, other otherwise", () => {
    const home = join(root(), "dispatch-home");
    const env = { DISPATCH_HOME: home };
    expect(instanceRole(join(home, "data"), false, env)).toBe("stable");
    // The data dir decides first: dev code pointed at the installed data IS that instance.
    expect(instanceRole(join(home, "data"), true, env)).toBe("stable");
    expect(instanceRole(join(home, "elsewhere"), true, env)).toBe("dev");
    expect(instanceRole(join(home, "elsewhere"), false, env)).toBe("other");
  });
});
