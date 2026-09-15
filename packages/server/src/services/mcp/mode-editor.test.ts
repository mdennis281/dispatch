import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectPaths } from "@dispatch/cli/core";
import type { ModeConfig } from "@dispatch/shared";
import { createModeEditor, readModesDir, type ModeStore } from "./mode-editor.js";

/** An in-memory `.data` — the `global` scope. */
function fakeStore(seed: ModeConfig[] = []): ModeStore & { rows: Map<string, ModeConfig> } {
  const rows = new Map(seed.map((m) => [m.id, m]));
  return {
    rows,
    listModes: async () => [...rows.values()],
    getMode: async (id) => rows.get(id) ?? null,
    saveMode: async (mode) => {
      rows.set(mode.id, mode);
      return mode;
    },
    deleteMode: async (id) => {
      rows.delete(id);
    },
  };
}

const BUILTIN = { plan: "plan", auto: "auto" } as const;

describe("mode-editor", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mode-editor-"));
    await mkdir(join(root, ".dispatch"), { recursive: true });
    await writeFile(join(root, ".dispatch", "project.yaml"), "name: t\n", "utf8");
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("writes a project mode as YAML the config loader's shape, and reads it back", async () => {
    const editor = createModeEditor({
      store: fakeStore(),
      configPaths: resolveProjectPaths(root),
      builtin: BUILTIN,
    });
    const written = await editor.write({
      scope: "project",
      name: "Careful review",
      permissionMode: "default",
      description: "Reviewing someone else's PR",
      instructions: "Never push to their branch.",
    });
    expect(written.id).toBe("careful-review");
    const path = join(root, ".dispatch", "modes", "careful-review.yaml");
    expect(written.path).toBe(path);
    const text = await readFile(path, "utf8");
    // The keys the loader reads, in reading order — name first so a human
    // opening the file sees what it is before what it permits.
    expect(text.split("\n").map((l) => l.split(":")[0])).toEqual(
      expect.arrayContaining(["name", "description", "permissionMode", "instructions"]),
    );
    expect(text.indexOf("name:")).toBeLessThan(text.indexOf("permissionMode:"));

    const read = await editor.read("careful-review");
    expect(read).toMatchObject({
      scope: "project",
      permissionMode: "default",
      instructions: "Never push to their branch.",
    });
  });

  it("lists project before global before builtin, so the first hit per id is the effective one", async () => {
    const store = fakeStore([
      { id: "plan", name: "My plan", permissionMode: "acceptEdits", scope: "global" },
    ]);
    const editor = createModeEditor({ store, configPaths: resolveProjectPaths(root), builtin: BUILTIN });
    await editor.write({ scope: "project", name: "plan", permissionMode: "plan" });
    const scopes = (await editor.list()).filter((m) => m.id === "plan").map((m) => m.scope);
    expect(scopes).toEqual(["project", "global", "builtin"]);
    // A scoped read reaches past the shadow.
    expect((await editor.read("plan", "global"))?.permissionMode).toBe("acceptEdits");
    expect((await editor.read("plan"))?.permissionMode).toBe("plan");
  });

  it("global writes land in the store with description and overlay intact", async () => {
    const store = fakeStore();
    const editor = createModeEditor({ store, configPaths: null, builtin: BUILTIN });
    expect(editor.hasProject).toBe(false);
    await editor.write({
      scope: "global",
      name: "Trusted",
      permissionMode: "bypassPermissions",
      description: "when nothing can go wrong",
      instructions: "Go.",
    });
    expect(store.rows.get("trusted")).toEqual({
      id: "trusted",
      name: "Trusted",
      description: "when nothing can go wrong",
      permissionMode: "bypassPermissions",
      instructions: "Go.",
      scope: "global",
    });
    await expect(
      editor.write({ scope: "project", name: "x", permissionMode: "plan" }),
    ).rejects.toThrow(/no project/);
  });

  it("removes either YAML extension for a project mode, and never a builtin", async () => {
    const editor = createModeEditor({
      store: fakeStore(),
      configPaths: resolveProjectPaths(root),
      builtin: BUILTIN,
    });
    const dir = join(root, ".dispatch", "modes");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "audit.yml"), "name: Audit\npermissionMode: plan\n", "utf8");
    expect((await editor.read("audit"))?.scope).toBe("project");
    expect(await editor.remove("audit", "project")).toBe(true);
    expect(existsSync(join(dir, "audit.yml"))).toBe(false);
    expect(await editor.remove("audit", "project")).toBe(false);
    expect(await editor.remove("plan", "global")).toBe(false);
    expect((await editor.read("plan"))?.scope).toBe("builtin");
  });

  it("readModesDir skips a file with no usable posture rather than failing the listing", async () => {
    const dir = join(root, "modes");
    await mkdir(dir);
    await writeFile(join(dir, "good.yaml"), "name: Good\npermissionMode: auto\n", "utf8");
    await writeFile(join(dir, "bad.yaml"), "name: Bad\npermissionMode: sudo\n", "utf8");
    await writeFile(join(dir, "broken.yaml"), "name: [\n", "utf8");
    expect((await readModesDir(dir)).map((m) => m.id)).toEqual(["good"]);
  });
});
