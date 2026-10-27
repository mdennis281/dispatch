import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPluginCommand } from "./plugin.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A directory holding plugins `ids`, and an empty config root. */
async function collection(ids: string[]): Promise<{ src: string; configDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "cm-plugin-cmd-"));
  dirs.push(root);
  const src = join(root, "src");
  for (const id of ids) {
    await mkdir(join(src, id), { recursive: true });
    await writeFile(join(src, id, "plugin.yaml"), `id: ${id}\nname: ${id}\nversion: 1.0.0\ndispatch: ">=1"\n`);
  }
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  return { src, configDir };
}

describe("dispatch plugin add <collection>", () => {
  it("reports the picks that landed before failing on the one that did not", async () => {
    const { src, configDir } = await collection(["alpha", "beta"]);
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
    await expect(
      runPluginCommand(["add", src, "--plugin", "alpha", "--plugin", "gamma", "--plugin", "beta", "--config-dir", configDir]),
    ).rejects.toThrow(/1 of 3 not installed:\n {2}gamma: no plugin "gamma"/);
    expect(out).toMatch(/Installed alpha/);
    expect(out).toMatch(/Installed beta/);
    expect(out).toMatch(/Restart Dispatch/);
    expect(existsSync(join(configDir, "plugins", "alpha", "plugin.yaml"))).toBe(true);
  });

  it("installs every member with --all", async () => {
    const { src, configDir } = await collection(["alpha", "beta"]);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runPluginCommand(["add", src, "--all", "--config-dir", configDir]);
    expect(existsSync(join(configDir, "plugins", "alpha"))).toBe(true);
    expect(existsSync(join(configDir, "plugins", "beta"))).toBe(true);
  });
});
