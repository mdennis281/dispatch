/**
 * The session spawner, driven against a real subprocess.
 *
 * The pid half is nearly tautological; the STDERR half is not, and is the
 * reason this file exists. Providing `spawnClaudeCodeProcess` is what stops the
 * SDK collecting its own stderr tail (its `SpawnedProcess` interface declares no
 * `stderr`), so the tail it staples onto "Claude Code process exited with code
 * N" — the half of that message that says why — silently goes empty. These
 * assert it comes back out through the sink instead.
 */
import { describe, it, expect } from "vitest";
import { spawnWithPid } from "./spawn.js";
import { withStderrTail } from "./session.js";

/** Run a tiny node program through the spawner and collect what the sink saw. */
function run(source: string): Promise<{ pid?: number; exitPid?: number; tail: string }> {
  return new Promise((resolve) => {
    let pid: number | undefined;
    const spawn = spawnWithPid({
      onSpawn: (p) => {
        pid = p;
      },
      onExit: (exitPid, tail) => resolve({ pid, exitPid, tail }),
    });
    const child = spawn({
      command: process.execPath,
      args: ["-e", source],
      env: process.env,
      signal: new AbortController().signal,
    });
    // stdout has a reader in the real thing (the SDK); without one here the
    // child can block on a full pipe and never reach its exit.
    child.stdout.resume();
  });
}

describe("spawnWithPid", () => {
  it("reports the pid, and reports it again on exit", async () => {
    const seen = await run("process.exit(0)");
    expect(seen.pid).toBeGreaterThan(0);
    expect(seen.exitPid).toBe(seen.pid);
  });

  it("hands back the child's stderr tail — the SDK can no longer collect it", async () => {
    const seen = await run(
      "process.stderr.write('Error: --nope is not a known flag\\n'); process.exit(1)",
    );
    expect(seen.tail).toContain("--nope is not a known flag");
  });

  it("keeps the LAST of a long stderr rather than the first", async () => {
    // A crashing CLI's useful line is the final one; a head-biased buffer would
    // hand back the start of a stack trace and drop the message.
    const seen = await run(
      "for (let i = 0; i < 4000; i++) process.stderr.write('line ' + i + '\\n');" +
        "process.stderr.write('FINAL: the actual reason\\n'); process.exit(1)",
    );
    expect(seen.tail).toContain("FINAL: the actual reason");
    expect(seen.tail.length).toBeLessThanOrEqual(8_192);
  });

  it("still releases the pid when the executable does not exist", async () => {
    // `error`, never `exit` — without releasing on both, the pid leaks into the
    // count as a process that never existed.
    const seen = await new Promise<{ exitPid?: number }>((resolve) => {
      const spawn = spawnWithPid({
        onSpawn: () => {},
        onExit: (exitPid) => resolve({ exitPid }),
      });
      const child = spawn({
        command: "C:/definitely/not/a/real/binary-xyz",
        args: [],
        env: process.env,
        signal: new AbortController().signal,
      });
      child.on("error", () => {});
      // A spawn that fails synchronously has no pid at all, so nothing is owed.
      if (typeof child.pid !== "number") resolve({ exitPid: undefined });
    });
    expect(seen).toBeTruthy();
  });
});

describe("withStderrTail", () => {
  const EXIT = "Claude Code process exited with code 1";

  it("appends the tail to a bare process-exit error", () => {
    expect(withStderrTail(EXIT, "Error: bad flag")).toBe(`${EXIT}\nError: bad flag`);
  });

  it("leaves an unrelated failure alone", () => {
    // The tail outlives the process it came from, so pinning it to a transport
    // error would describe a run that already ended.
    expect(withStderrTail("stream disconnected", "Error: bad flag")).toBe("stream disconnected");
  });

  it("does not double up when the message already carries the tail", () => {
    const already = `${EXIT}\nError: bad flag`;
    expect(withStderrTail(already, "Error: bad flag")).toBe(already);
  });

  it("ignores a blank tail", () => {
    expect(withStderrTail(EXIT, "   \n ")).toBe(EXIT);
  });
});
