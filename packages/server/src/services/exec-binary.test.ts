/**
 * The spawn seam's two promises: a command name resolves to ONE absolute path
 * and stays resolved, and every spawn is counted where the perf monitor can
 * see it. The resolution cases mirror what cross-spawn's `which` would have
 * picked, because the point is to spawn the same binary it did — just without
 * re-walking PATH to find it every time.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  execBinary,
  execStats,
  resetExecStats,
  resetResolvedBinaries,
  resolveBinary,
} from "./exec-binary.js";

const win32 = process.platform === "win32";

describe("resolveBinary", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetResolvedBinaries();
    root = await mkdtemp(join(tmpdir(), "cm-exec-bin-"));
    await mkdir(join(root, "a"));
    await mkdir(join(root, "b"));
    // `tool` exists in both dirs; PATH order must decide, as it does for which.
    await writeFile(join(root, "a", "tool.cmd"), "@echo a");
    await writeFile(join(root, "b", "tool.exe"), "");
    await writeFile(join(root, "b", "only.exe"), "");
    env = {
      PATH: [join(root, "a"), join(root, "b")].join(delimiter),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    };
  });

  afterEach(async () => {
    resetResolvedBinaries();
    await rm(root, { recursive: true, force: true });
  });

  it.runIf(win32)("walks PATH then PATHEXT, first hit wins", async () => {
    // Dir `a` comes first in PATH, so its .cmd beats dir `b`'s .exe even though
    // .EXE precedes .CMD in PATHEXT — exactly which's order.
    expect(await resolveBinary("tool", env)).toBe(join(root, "a", "tool.cmd"));
    expect(await resolveBinary("only", env)).toBe(join(root, "b", "only.exe"));
  });

  it.runIf(win32)("tries a name that already has an extension bare first", async () => {
    expect(await resolveBinary("tool.exe", env)).toBe(join(root, "b", "tool.exe"));
  });

  it.runIf(win32)("memoises a hit and shares the in-flight promise", async () => {
    const first = resolveBinary("only", env);
    const second = resolveBinary("only", env);
    expect(second).toBe(first);
    expect(await first).toBe(join(root, "b", "only.exe"));
    // A later call with a DIFFERENT env still answers from the memo: PATH does
    // not change under a running process, and the memo is the whole point.
    expect(await resolveBinary("only", { PATH: "" })).toBe(join(root, "b", "only.exe"));
  });

  it.runIf(win32)("returns the bare name on a miss and does not cache it", async () => {
    expect(await resolveBinary("nothere", env)).toBe("nothere");
    // Install it, ask again: the miss was not pinned.
    await writeFile(join(root, "b", "nothere.exe"), "");
    expect(await resolveBinary("nothere", env)).toBe(join(root, "b", "nothere.exe"));
  });

  it("passes an absolute or dir-qualified command through untouched", async () => {
    const abs = join(root, "b", "tool.exe");
    expect(await resolveBinary(abs, env)).toBe(abs);
    expect(await resolveBinary("./tool", env)).toBe("./tool");
  });

  it.skipIf(win32)("is a no-op off Windows", async () => {
    expect(await resolveBinary("tool", env)).toBe("tool");
  });
});

describe("execBinary", () => {
  beforeEach(() => resetExecStats());
  afterEach(() => resetExecStats());

  it("runs the command and counts it under the caller's spelling", async () => {
    const r = await execBinary("node", ["-e", "process.stdout.write('hi')"], { reject: false });
    expect(r.stdout).toBe("hi");
    const [stat] = execStats();
    expect(stat).toMatchObject({ file: "node", count: 1 });
    expect(stat!.syncMs).toBeGreaterThanOrEqual(0);
    expect(stat!.wallMs).toBeGreaterThan(0);
    expect(stat!.maxSyncMs).toBeLessThanOrEqual(stat!.syncMs);
  });

  it("keeps counting when the child fails, and resets on demand", async () => {
    await execBinary("node", ["-e", "process.exit(3)"], { reject: false });
    await execBinary("node", ["-e", "process.exit(3)"], { reject: false });
    expect(execStats()[0]).toMatchObject({ file: "node", count: 2 });
    resetExecStats();
    expect(execStats()).toEqual([]);
  });
});
