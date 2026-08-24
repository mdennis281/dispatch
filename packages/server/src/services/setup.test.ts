/**
 * ensureSetupState / completeSetup — the one-time "does this install still owe
 * its owner the wizard" decision.
 *
 * The cases that matter are all about telling a NEW install from an UPGRADED
 * one, because getting that backwards in either direction is bad in a way a
 * user notices: an upgrade that reopens the wizard puts a four-step takeover
 * over a working install, and a new install that skips it lands on an app with
 * no project and no way to make one except a menu it hasn't been shown.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import { completeSetup, ensureSetupState, readSetupState } from "./setup.js";

let dir: string;
let store: Store;

async function open(root: string): Promise<Store> {
  const s = new Store(root);
  await s.init();
  return s;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-setup-"));
});

afterEach(async () => {
  store?.close();
  await rm(dir, { recursive: true, force: true });
});

describe("ensureSetupState", () => {
  it("marks a fresh install as pending", async () => {
    store = await open(dir);
    expect(await ensureSetupState(store)).toEqual({ completed: false });
    expect(await readSetupState(store)).toEqual({ completed: false });
  });

  it("marks an EXISTING install complete without ever showing the wizard", async () => {
    // Anything at the root before `init()` is what makes a store an upgrade —
    // see Store.init. `crash.log` is a real artifact a running install leaves at
    // the data root, and deliberately NOT one of the pre-SQLite entity files
    // (`runners.json` and friends), which `assertStateMigrated` refuses to open
    // at all: that path is a different failure, tested elsewhere.
    await writeFile(join(dir, "crash.log"), "\n");
    store = await open(dir);

    const state = await ensureSetupState(store);
    expect(state.completed).toBe(true);
    expect(state.completedAt).toBeGreaterThan(0);
  });

  /**
   * The reason this is persisted rather than derived. `isFreshInstall()` is a
   * snapshot taken before seeding, so it is only true on the very first boot; a
   * wizard gated on it directly would vanish the moment the server restarted,
   * stranding a half-configured install with no route back to the screen that
   * creates its first project.
   */
  it("survives a restart with the wizard still owed", async () => {
    store = await open(dir);
    expect((await ensureSetupState(store)).completed).toBe(false);
    store.close();

    // Second boot: the data root now has content, so `isFreshInstall()` is
    // false — and the answer must still be "pending".
    store = await open(dir);
    expect(store.isFreshInstall()).toBe(false);
    expect((await ensureSetupState(store)).completed).toBe(false);
  });

  it("never re-opens the wizard once it has been finished", async () => {
    store = await open(dir);
    await ensureSetupState(store);
    const done = await completeSetup(store);
    expect(done.completed).toBe(true);
    store.close();

    store = await open(dir);
    const after = await ensureSetupState(store);
    expect(after.completed).toBe(true);
    expect(after.completedAt).toBe(done.completedAt);
  });
});

describe("completeSetup", () => {
  it("keeps the FIRST timestamp when called twice", async () => {
    store = await open(dir);
    const first = await completeSetup(store);
    const second = await completeSetup(store);
    expect(second.completedAt).toBe(first.completedAt);
  });

  it("does not disturb other settings", async () => {
    store = await open(dir);
    await store.saveSettings({ theme: "light", defaultModeId: "plan" });
    await completeSetup(store);
    const settings = await store.getSettings();
    expect(settings.theme).toBe("light");
    expect(settings.defaultModeId).toBe("plan");
    expect(settings.setup?.completed).toBe(true);
  });
});

describe("readSetupState", () => {
  it("reads a never-resolved store as pending rather than throwing", async () => {
    store = await open(dir);
    expect(await readSetupState(store)).toEqual({ completed: false });
  });
});
