/**
 * The spawn seam's two promises: a command name resolves to ONE absolute path
 * and stays resolved, and every spawn is counted where the perf monitor can
 * see it. The resolution cases mirror what cross-spawn's `which` would have
 * picked, because the point is to spawn the same binary it did — just without
 * re-walking PATH to find it every time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  configureSpawnGate,
  execBinary,
  execStats,
  isCoalescibleRead,
  resetExecStats,
  resetResolvedBinaries,
  resetSpawnGate,
  resolveBinary,
  setSpawnImplForTest,
  subcommandOf,
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

/* ------------------------------------------------------------------ gate */

interface FakeCall {
  args: readonly string[];
  cwd: string | undefined;
  at: number;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/**
 * A spawn that never touches the OS: each call is recorded and stays "running"
 * until the test settles it, so queue order and slot counts are observable
 * without racing real processes.
 */
function fakeSpawn(): { calls: FakeCall[]; live: () => number; maxLive: () => number } {
  const calls: FakeCall[] = [];
  let live = 0;
  let maxLive = 0;
  setSpawnImplForTest((_bin, args, options) => {
    live += 1;
    maxLive = Math.max(maxLive, live);
    return new Promise((resolve, reject) => {
      calls.push({
        args,
        cwd: (options as { cwd?: string } | undefined)?.cwd,
        at: performance.now(),
        resolve: (v) => {
          live -= 1;
          resolve(v);
        },
        reject: (e) => {
          live -= 1;
          reject(e);
        },
      });
    });
  });
  return { calls, live: () => live, maxLive: () => maxLive };
}

const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("spawn gate", () => {
  beforeEach(() => {
    resetSpawnGate();
    resetExecStats();
    // Pacing off unless a test is about pacing, so the others are about order.
    configureSpawnGate({ minGapMs: 0, dutyRatio: 0 });
  });
  afterEach(() => {
    setSpawnImplForTest(null);
    resetSpawnGate();
    resetExecStats();
  });

  it("starts queued requests in the order they were made", async () => {
    configureSpawnGate({ concurrency: { default: 4, git: 1 } });
    const { calls } = fakeSpawn();
    // `add` is a write, so nothing here can coalesce — this is pure ordering.
    const runs = ["a", "b", "c", "d", "e"].map((p) => execBinary("git", ["add", p]));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    for (let i = 0; i < 5; i++) {
      expect(calls[i]!.args).toEqual(["add", "abcde"[i]]);
      calls[i]!.resolve({ stdout: String(i) });
      if (i < 4) await vi.waitFor(() => expect(calls).toHaveLength(i + 2));
    }
    expect((await Promise.all(runs)).map((r) => r.stdout)).toEqual(["0", "1", "2", "3", "4"]);
  });

  it("hands a freed slot to the OLDEST waiter, whichever child finished", async () => {
    configureSpawnGate({ concurrency: { default: 4, git: 2 } });
    const { calls } = fakeSpawn();
    const runs = ["1", "2", "3", "4"].map((p) => execBinary("git", ["add", p]));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    // The SECOND child finishes first; the next to start must still be #3.
    calls[1]!.resolve({});
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]!.args).toEqual(["add", "3"]);
    calls[0]!.resolve({});
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls[3]!.args).toEqual(["add", "4"]);
    calls[2]!.resolve({});
    calls[3]!.resolve({});
    await Promise.all(runs);
  });

  it("never runs more live children per family than the cap", async () => {
    configureSpawnGate({ concurrency: { default: 4, git: 3 } });
    const fake = fakeSpawn();
    const runs = Array.from({ length: 12 }, (_, i) => execBinary("git", ["add", String(i)]));
    for (let done = 0; done < 12; done++) {
      await vi.waitFor(() => expect(fake.calls.length).toBe(Math.min(12, done + 3)));
      expect(fake.live()).toBeLessThanOrEqual(3);
      fake.calls[done]!.resolve({});
    }
    await Promise.all(runs);
    expect(fake.maxLive()).toBe(3);
  });

  it("gives each family its own lane — a jammed git never blocks gh", async () => {
    configureSpawnGate({ concurrency: { default: 4, git: 1, gh: 1 } });
    const { calls } = fakeSpawn();
    const g1 = execBinary("git", ["add", "x"]);
    const g2 = execBinary("git", ["add", "y"]);
    const h = execBinary("gh", ["pr", "create"]);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => c.args[0])).toEqual(["add", "pr"]);
    for (const c of calls) c.resolve({});
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    calls[2]!.resolve({});
    await Promise.all([g1, g2, h]);
  });

  it("paces starts: at least minGapMs between two spawns, even in one burst", async () => {
    configureSpawnGate({ minGapMs: 40, dutyRatio: 0 });
    const { calls } = fakeSpawn();
    const runs = ["1", "2", "3"].map((p) => execBinary("git", ["add", p]));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    // Timers can fire a hair early relative to performance.now(); 35 of 40 ms
    // still proves the gap exists.
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(35);
    expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(35);
    for (const c of calls) c.resolve({});
    await Promise.all(runs);
  });

  it("yields the loop between two spawns — the whole point of the pacer", async () => {
    configureSpawnGate({ minGapMs: 1, dutyRatio: 0 });
    let turned = false;
    const seenAtSecond: boolean[] = [];
    let n = 0;
    setSpawnImplForTest(() => {
      n += 1;
      if (n === 1) setImmediate(() => (turned = true));
      else seenAtSecond.push(turned);
      return Promise.resolve({});
    });
    await Promise.all([execBinary("git", ["add", "1"]), execBinary("git", ["add", "2"])]);
    // A macrotask queued by the first spawn ran before the second one started.
    expect(seenAtSecond).toEqual([true]);
  });

  it("stretches the gap to the last spawn's own blocking time (duty cycle)", async () => {
    configureSpawnGate({ minGapMs: 1, dutyRatio: 1 });
    const ends: number[] = [];
    const starts: number[] = [];
    setSpawnImplForTest(() => {
      starts.push(performance.now());
      // A CreateProcess that holds the loop for 40 ms, as it did under load.
      const until = performance.now() + 40;
      while (performance.now() < until) {
        /* spin */
      }
      ends.push(performance.now());
      return Promise.resolve({});
    });
    await Promise.all([execBinary("git", ["add", "1"]), execBinary("git", ["add", "2"])]);
    expect(starts[1]! - ends[0]!).toBeGreaterThanOrEqual(35);
  });

  it("coalesces identical QUEUED reads into one spawn, and every waiter gets its result", async () => {
    configureSpawnGate({ concurrency: { default: 4, git: 1 } });
    const { calls } = fakeSpawn();
    const blocker = execBinary("git", ["add", "-A"], { cwd: "/r" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const reads = [1, 2, 3].map(() => execBinary("git", ["status", "--porcelain"], { cwd: "/r" }));
    // Same args, different cwd: a different question, never shared.
    const other = execBinary("git", ["status", "--porcelain"], { cwd: "/elsewhere" });
    calls[0]!.resolve({});
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1]!.resolve({ stdout: "M a" });
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]!.cwd).toBe("/elsewhere");
    calls[2]!.resolve({ stdout: "" });
    const results = await Promise.all(reads);
    expect(results.map((r) => r.stdout)).toEqual(["M a", "M a", "M a"]);
    await Promise.all([blocker, other]);
    expect(calls).toHaveLength(3);
    const git = execStats().find((s) => s.file === "git")!;
    expect(git).toMatchObject({ count: 3, coalesced: 2 });
    expect(git.subs).toEqual({ add: 1, status: 2 });
  });

  it("never joins a read that is already RUNNING — it could predate the caller's write", async () => {
    const { calls } = fakeSpawn();
    const first = execBinary("git", ["status"], { cwd: "/r" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = execBinary("git", ["status"], { cwd: "/r" });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[0]!.resolve({ stdout: "before" });
    calls[1]!.resolve({ stdout: "after" });
    expect((await first).stdout).toBe("before");
    expect((await second).stdout).toBe("after");
  });

  it("never coalesces writes, even identical queued ones", async () => {
    configureSpawnGate({ concurrency: { default: 4, git: 1, gh: 1 } });
    const { calls } = fakeSpawn();
    const runs = [
      execBinary("git", ["commit", "-m", "x"], { cwd: "/r" }),
      execBinary("git", ["commit", "-m", "x"], { cwd: "/r" }),
    ];
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(calls).toHaveLength(i + 1));
      calls[i]!.resolve({});
    }
    await Promise.all(runs);
    expect(calls).toHaveLength(2);
  });

  it("propagates a failure to EVERY coalesced waiter, and frees the slot", async () => {
    configureSpawnGate({ concurrency: { default: 4, git: 1 } });
    const { calls } = fakeSpawn();
    const blocker = execBinary("git", ["add", "-A"]);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const reads = [1, 2, 3].map(() => execBinary("git", ["rev-parse", "HEAD"]));
    calls[0]!.resolve({});
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    const boom = new Error("fatal: not a git repository");
    calls[1]!.reject(boom);
    const outcomes = await Promise.allSettled(reads);
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected", "rejected"]);
    for (const o of outcomes) expect((o as PromiseRejectedResult).reason).toBe(boom);
    await blocker;
    // The failed spawn gave its slot back: the next call runs.
    const next = execBinary("git", ["add", "z"]);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    calls[2]!.resolve({ stdout: "ok" });
    expect((await next).stdout).toBe("ok");
  });

  it("frees the slot and the pacer when the spawn itself throws synchronously", async () => {
    configureSpawnGate({ concurrency: { default: 4, git: 1 } });
    let n = 0;
    setSpawnImplForTest(() => {
      n += 1;
      if (n === 1) throw new Error("spawn EINVAL");
      return Promise.resolve({ stdout: "second" });
    });
    await expect(execBinary("git", ["add", "1"])).rejects.toThrow("spawn EINVAL");
    expect((await execBinary("git", ["add", "2"])).stdout).toBe("second");
  });

  it("stops counting a wedged child against the cap after the lease", async () => {
    configureSpawnGate({ concurrency: { default: 4, git: 1 }, leaseMs: 50 });
    const { calls } = fakeSpawn();
    void execBinary("git", ["add", "wedged"]); // never settles
    const next = execBinary("git", ["add", "next"]);
    await settle(10);
    expect(calls).toHaveLength(1);
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 1000 });
    calls[1]!.resolve({});
    await next;
  });

  it("records queue depth and time spent waiting", async () => {
    configureSpawnGate({ concurrency: { default: 4, git: 1 } });
    const { calls } = fakeSpawn();
    const runs = ["1", "2", "3", "4"].map((p) => execBinary("git", ["add", p]));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await settle(30);
    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(calls).toHaveLength(i + 1));
      calls[i]!.resolve({});
    }
    await Promise.all(runs);
    const git = execStats().find((s) => s.file === "git")!;
    expect(git.maxQueue).toBe(4);
    expect(git.maxWaitMs).toBeGreaterThanOrEqual(25);
    expect(git.waitMs).toBeGreaterThanOrEqual(git.maxWaitMs);
  });
});

describe("subcommandOf / isCoalescibleRead", () => {
  it("labels calls past git's global options", () => {
    expect(subcommandOf("git", ["-c", "core.autocrlf=false", "add", "-A"])).toBe("add");
    expect(subcommandOf("git", ["-C", "/repo", "status"])).toBe("status");
    expect(subcommandOf("git", ["worktree", "list", "--porcelain"])).toBe("worktree list");
    expect(subcommandOf("gh", ["repo", "view", "--json", "nameWithOwner"])).toBe("repo view");
    expect(subcommandOf("gh", ["api", "graphql", "-f", "query=x"])).toBe("api graphql");
    expect(subcommandOf("gh", ["api", "repos/a/b/pulls"])).toBe("api rest");
    expect(subcommandOf("netstat", ["-ano"])).toBe("(none)");
  });

  it("treats only reads as shareable", () => {
    expect(isCoalescibleRead("git", ["status", "--porcelain"])).toBe(true);
    expect(isCoalescibleRead("git", ["worktree", "list", "--porcelain"])).toBe(true);
    expect(isCoalescibleRead("git", ["worktree", "add", "x"])).toBe(false);
    expect(isCoalescibleRead("git", ["-c", "a=b", "add", "-A"])).toBe(false);
    expect(isCoalescibleRead("git", ["fetch", "origin"])).toBe(false);
    expect(isCoalescibleRead("gh", ["repo", "view"])).toBe(true);
    expect(isCoalescibleRead("gh", ["pr", "create"])).toBe(false);
    expect(isCoalescibleRead("gh", ["api", "graphql", "-f", "query=query($n:Int!){x}"])).toBe(true);
    expect(isCoalescibleRead("gh", ["api", "graphql", "-f", "query=mutation($id:ID!){x}"])).toBe(false);
    expect(isCoalescibleRead("gh", ["api", "repos/a/b/pulls"])).toBe(true);
    expect(isCoalescibleRead("gh", ["api", "-X", "POST", "repos/a/b/issues"])).toBe(false);
    expect(isCoalescibleRead("gh", ["api", "--method=PATCH", "repos/a/b"])).toBe(false);
    expect(isCoalescibleRead("gh", ["api", "repos/a/b/issues", "-f", "title=x"])).toBe(false);
    expect(isCoalescibleRead("netstat", ["-ano"])).toBe(false);
  });
});
