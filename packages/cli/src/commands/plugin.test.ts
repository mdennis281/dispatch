import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const RH = (version = "0.10.0", majors = "[1]") => `id: remote-host\nname: Remote host\nversion: ${version}\ndispatch: ">=1"\nprovides:\n  machines: ${majors}\n`;
const PROXMOX = `id: proxmox-terminal\nname: Proxmox terminal\nversion: 0.2.0\ndispatch: ">=1"\ndependencies:\n  remote-host:\n    uses: [machines@1]\n    version: ">=0.10.0"\n`;

/** A collection of remote-host and proxmox-terminal, as the remote-machines repo will ship them. */
async function pair(rh = RH()): Promise<{ src: string; configDir: string }> {
  const { src, configDir } = await collection([]);
  for (const [id, yaml] of [["remote-host", rh], ["proxmox-terminal", PROXMOX]] as const) {
    await mkdir(join(src, "plugins", id), { recursive: true });
    await writeFile(join(src, "plugins", id, "plugin.yaml"), yaml);
  }
  return { src, configDir };
}

function capture(): { out: () => string } {
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => ((out += String(chunk)), true));
  return { out: () => out };
}

describe("dispatch plugin add — dependencies", () => {
  it("refuses a pick whose provider is in the collection, and --with-deps installs both, provider first", async () => {
    const { src, configDir } = await pair();
    const io = capture();
    await expect(runPluginCommand(["add", src, "--plugin", "proxmox-terminal", "--config-dir", configDir])).rejects.toThrow(
      "needs remote-host (machines@1): add --plugin plugins/remote-host, or --with-deps",
    );
    expect(existsSync(join(configDir, "plugins"))).toBe(false);

    await runPluginCommand(["add", src, "--plugin", "proxmox-terminal", "--with-deps", "--config-dir", configDir]);
    const out = io.out();
    expect(out.indexOf("Installed remote-host")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("Installed remote-host")).toBeLessThan(out.indexOf("Installed proxmox-terminal"));
    expect(out).toContain("  Uses remote-host — its `machines` API v1. remote-host acts on what this plugin hands it.");
    expect(out).toContain("Lets other plugins use: `machines` v1.");
  });

  it("list shows what the next boot would block, and why", async () => {
    const { src, configDir } = await pair();
    const io = capture();
    await runPluginCommand(["add", src, "--all", "--config-dir", configDir]);
    await runPluginCommand(["disable", "remote-host", "--config-dir", configDir]);
    expect(io.out()).toContain("Also stops (they need it): proxmox-terminal");
    await runPluginCommand(["list", "--config-dir", configDir]);
    expect(io.out()).toMatch(/proxmox-terminal\s+blocked\s+Proxmox terminal v0\.2\.0/);
    expect(io.out()).toContain("needs remote-host (machines@1): remote-host is switched off");
  });

  it("remove refuses a provider in use; --force removes it and says who is blocked", async () => {
    const { src, configDir } = await pair();
    const io = capture();
    await runPluginCommand(["add", src, "--all", "--config-dir", configDir]);
    await expect(runPluginCommand(["remove", "remote-host", "--config-dir", configDir])).rejects.toThrow(
      "remote-host is used by proxmox-terminal — remove it first, or re-run with --force (proxmox-terminal will be blocked)",
    );
    expect(existsSync(join(configDir, "plugins", "remote-host"))).toBe(true);
    await runPluginCommand(["remove", "remote-host", "--force", "--config-dir", configDir]);
    expect(existsSync(join(configDir, "plugins", "remote-host"))).toBe(false);
    expect(io.out()).toContain("Now blocked (they need it): proxmox-terminal");
  });

  it("a replace that breaks an installed user needs --allow-breaking, and the old copy stays until then", async () => {
    const { src, configDir } = await pair();
    capture();
    await runPluginCommand(["add", src, "--all", "--config-dir", configDir]);
    const next = await pair(RH("1.0.0", "[2]"));
    await expect(
      runPluginCommand(["add", next.src, "--plugin", "remote-host", "--force", "--config-dir", configDir]),
    ).rejects.toThrow(/breaks proxmox-terminal .* re-run with --allow-breaking/);
    expect(await readFile(join(configDir, "plugins", "remote-host", "plugin.yaml"), "utf8")).toContain("0.10.0");
    await runPluginCommand(["add", next.src, "--plugin", "remote-host", "--force", "--allow-breaking", "--config-dir", configDir]);
    expect(await readFile(join(configDir, "plugins", "remote-host", "plugin.yaml"), "utf8")).toContain("1.0.0");
  });
});
