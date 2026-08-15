import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { spawn } from "node:child_process";
import { launchUpdate } from "./update-install.js";

/**
 * Real temp dirs, never literal absolute paths: a hardcoded "C:/root" is not
 * absolute on the Linux CI runner and `path.resolve` would prefix it with cwd.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

/** A payload directory with the installer bundled inside it, as a release ships. */
async function payload(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dispatch-install-test-"));
  roots.push(root);
  const appDir = join(root, "app");
  await mkdir(join(appDir, "tools"), { recursive: true });
  await writeFile(join(appDir, "tools", "install.mjs"), "// bundled desktopRoot installer\n", "utf8");
  return appDir;
}

/** A spawn stand-in that records its call and hands back an unref-able child. */
function fakeSpawn() {
  const unref = vi.fn();
  const impl = vi.fn(() => ({ pid: 4321, unref })) as unknown as typeof spawn;
  return { impl, unref, calls: () => (impl as unknown as ReturnType<typeof vi.fn>).mock.calls };
}

const OK_INSTALLER = "export function desktopRoot() {}\n";

function textResponse(body: string, status = 200): Response {
  return { ok: status < 400, status, text: async () => body } as unknown as Response;
}

describe("launchUpdate", () => {
  it("runs the release's own installer, detached, from outside app/", async () => {
    const appDir = await payload();
    const spawnImpl = fakeSpawn();
    const fetchImpl = vi.fn(async () => textResponse(OK_INSTALLER));

    const result = await launchUpdate({
      tag: "v2026.08.14.85068",
      appDir,
      env: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl: spawnImpl.impl,
    });

    expect(result.installerSource).toBe("release");
    expect(result.pid).toBe(4321);

    const [file, args, options] = spawnImpl.calls()[0] as [string, string[], Record<string, unknown>];
    expect(file).toBe(process.execPath);
    expect(args).toEqual([
      expect.stringContaining("install.mjs"),
      "--version",
      "v2026.08.14.85068",
      "--target",
      dirname(appDir),
      "--no-shortcut",
    ]);
    expect(options.detached).toBe(true);
    expect(options.windowsHide).toBe(true);

    // The load-bearing one: Windows will not rename a directory that is any
    // process's cwd, so an installer started inside app/ blocks its own swap.
    const cwd = options.cwd as string;
    expect(cwd.startsWith(appDir)).toBe(false);
    expect((options.env as Record<string, string>).DISPATCH_INSTALL_CWD).toBe(cwd);

    // Detaching without unref would still tie the installer's lifetime to ours.
    expect(spawnImpl.unref).toHaveBeenCalledOnce();
  });

  it("captures installer output to update.log, not to a console that is about to die", async () => {
    const appDir = await payload();
    const spawnImpl = fakeSpawn();
    const result = await launchUpdate({
      tag: "v2026.08.14.85068",
      appDir,
      env: {},
      fetchImpl: vi.fn(async () => textResponse(OK_INSTALLER)) as unknown as typeof fetch,
      spawnImpl: spawnImpl.impl,
    });

    expect(result.logFile).toBe(join(dirname(appDir), "update.log"));
    const [, , options] = spawnImpl.calls()[0] as [string, string[], Record<string, unknown>];
    const stdio = options.stdio as unknown[];
    expect(stdio[0]).toBe("ignore");
    expect(typeof stdio[1]).toBe("number");
    expect(stdio[2]).toBe(stdio[1]);
  });

  it("records the attempt in update.json before spawning anything", async () => {
    const appDir = await payload();
    const spawnImpl = fakeSpawn();
    await launchUpdate({
      tag: "v2026.08.14.85068",
      appDir,
      env: {},
      fetchImpl: vi.fn(async () => textResponse(OK_INSTALLER)) as unknown as typeof fetch,
      spawnImpl: spawnImpl.impl,
    });

    const state = JSON.parse(await readFile(join(dirname(appDir), "update.json"), "utf8")) as {
      phase: string;
      tag: string;
    };
    expect(state).toMatchObject({ phase: "launched", tag: "v2026.08.14.85068" });
  });

  it("falls back to the payload's bundled installer when the download fails", async () => {
    const appDir = await payload();
    const spawnImpl = fakeSpawn();
    const result = await launchUpdate({
      tag: "v2026.08.14.85068",
      appDir,
      env: {},
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      spawnImpl: spawnImpl.impl,
    });

    expect(result.installerSource).toBe("payload");
    const staged = (spawnImpl.calls()[0] as [string, string[]])[1][0]!;
    expect(await readFile(staged, "utf8")).toContain("bundled desktopRoot installer");
  });

  it("rejects a 200 that is not the installer rather than handing node an HTML page", async () => {
    const appDir = await payload();
    const spawnImpl = fakeSpawn();
    const result = await launchUpdate({
      tag: "v2026.08.14.85068",
      appDir,
      env: {},
      fetchImpl: vi.fn(async () =>
        textResponse("<!doctype html><title>Sign in to GitHub</title>"),
      ) as unknown as typeof fetch,
      spawnImpl: spawnImpl.impl,
    });

    expect(result.installerSource).toBe("payload");
  });

  it("copies the bundled installer out of app/ instead of running it in place", async () => {
    const appDir = await payload();
    const spawnImpl = fakeSpawn();
    await launchUpdate({
      tag: "v2026.08.14.85068",
      appDir,
      env: {},
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      spawnImpl: spawnImpl.impl,
    });

    // An open handle inside app/ is another way to block the rename.
    const staged = (spawnImpl.calls()[0] as [string, string[]])[1][0]!;
    expect(staged.startsWith(appDir)).toBe(false);
  });

  it("sends the token to GitHub when one is in the environment", async () => {
    const appDir = await payload();
    const spawnImpl = fakeSpawn();
    const fetchImpl = vi.fn(async () => textResponse(OK_INSTALLER));
    await launchUpdate({
      tag: "v2026.08.14.85068",
      appDir,
      env: { GITHUB_TOKEN: "ghp_secret" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl: spawnImpl.impl,
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/releases/download/v2026.08.14.85068/install.mjs");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ghp_secret");
  });
});
