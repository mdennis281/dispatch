/**
 * The net that makes the NEXT crash diagnosable. See crash-log.ts for why this
 * exists: the 2026-08-07 deaths left no record anywhere — not on stderr (the
 * launcher runs under pythonw, so there is no console), and not in the Windows
 * Application log (a Node fatal error is an orderly exit, not an SEH fault).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installCrashNet,
  attachCrashBus,
  CRASH_LOG_NAME,
  CRASH_LOG_MAX_BYTES,
} from "./crash-log.js";
import { EventBus } from "./bus.js";
import type { WsServerEvent } from "@dispatch/shared";

let dir: string;
let uninstall: (() => void) | undefined;
let logged: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-crashlog-"));
  logged = [];
});

afterEach(async () => {
  uninstall?.();
  uninstall = undefined;
  await rm(dir, { recursive: true, force: true });
});

const logFile = (): string => join(dir, CRASH_LOG_NAME);

describe("installCrashNet", () => {
  it("records an unhandled rejection to the crash log with its stack", async () => {
    uninstall = installCrashNet({ dataDir: dir, log: (m) => logged.push(m) });

    const err = new Error("stray rejection");
    process.emit("unhandledRejection", err, Promise.resolve());

    const text = await readFile(logFile(), "utf8");
    expect(text).toContain("unhandledRejection");
    expect(text).toContain("stray rejection");
    // The stack, not just the message — attribution is the whole point.
    expect(text).toContain("crash-log.test");
    // And it was loud on stderr too.
    expect(logged.join("\n")).toContain("stray rejection");
  });

  it("records an uncaught exception and appends rather than truncating", async () => {
    uninstall = installCrashNet({ dataDir: dir, log: (m) => logged.push(m) });

    process.emit("uncaughtException", new Error("first"));
    process.emit("uncaughtException", new Error("second"));

    const text = await readFile(logFile(), "utf8");
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(text.match(/uncaughtException/g)).toHaveLength(2);
  });

  it("survives a non-Error rejection value", async () => {
    uninstall = installCrashNet({ dataDir: dir, log: (m) => logged.push(m) });

    process.emit("unhandledRejection", { code: "ENOENT" }, Promise.resolve());

    expect(await readFile(logFile(), "utf8")).toContain("ENOENT");
  });

  it("uninstall removes the handlers so tests can't stack them", () => {
    const before = process.listenerCount("unhandledRejection");
    const off = installCrashNet({ dataDir: dir, log: () => {} });
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    off();
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });

  it("installing twice replaces rather than stacks", async () => {
    // Review flagged that the docblock promised a no-stacking guard that did not
    // exist. Two live nets means two handler pairs and every crash written to
    // crash.log twice.
    const before = process.listenerCount("unhandledRejection");
    installCrashNet({ dataDir: dir, log: () => {} });
    uninstall = installCrashNet({ dataDir: dir, log: () => {} });
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);

    process.emit("uncaughtException", new Error("only once"));
    const text = await readFile(logFile(), "utf8");
    expect(text.match(/only once/g)).toHaveLength(1);
  });

  it("a stale uninstall does not tear down the net that replaced it", () => {
    const before = process.listenerCount("unhandledRejection");
    const first = installCrashNet({ dataDir: dir, log: () => {} });
    uninstall = installCrashNet({ dataDir: dir, log: () => {} });
    // `first` no longer owns the slot; calling it must be inert, not a way to
    // silently disarm the live net.
    first();
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
  });
});

/**
 * The 2026-08-08 regression: the net turned a fatal crash into an infinite one.
 * One `MaxListenersExceededWarning` -> stderr write -> EPIPE (the launcher's
 * stderr has no reader) -> uncaughtException -> this handler -> stderr write ->
 * EPIPE -> ... 391,428 entries and 106 MB in about three minutes.
 */
describe("the net is not itself the crash", () => {
  const epipe = (): never => {
    throw Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });
  };

  it("survives a console whose pipe has no reader", async () => {
    uninstall = installCrashNet({ dataDir: dir, log: epipe });

    // The throw must not escape: out of an uncaughtException handler, an
    // escaping throw IS the next uncaughtException.
    expect(() => process.emit("uncaughtException", new Error("seed"))).not.toThrow();

    const text = await readFile(logFile(), "utf8");
    expect(text).toContain("seed");
    expect(text.match(/uncaughtException/g)).toHaveLength(1);
  });

  it("still writes the disk record when stderr is dead", async () => {
    // The console is the nice-to-have; the file is the thing being protected.
    uninstall = installCrashNet({ dataDir: dir, log: epipe });
    process.emit("unhandledRejection", new Error("unreadable stderr"), Promise.resolve());
    expect(await readFile(logFile(), "utf8")).toContain("unreadable stderr");
  });

  it("refuses to re-enter, and says how many faults it swallowed", async () => {
    let depth = 0;
    let deepest = 0;
    uninstall = installCrashNet({
      dataDir: dir,
      log: () => {
        depth++;
        deepest = Math.max(deepest, depth);
        try {
          // Stand in for what Node does with a throw from this handler.
          process.emit("uncaughtException", new Error("secondary"));
        } finally {
          depth--;
        }
      },
    });

    process.emit("uncaughtException", new Error("seed"));

    expect(deepest).toBe(1);
    const text = await readFile(logFile(), "utf8");
    expect(text.match(/uncaughtException/g)).toHaveLength(1);
    expect(text).toContain("seed");
    expect(text).toContain("1 further fault(s) suppressed");
    expect(text).not.toContain("secondary");
  });

  /**
   * The failure the FIRST fix missed. `try/catch` around the console write is
   * useless here: on Windows these are async pipe writes, so the EPIPE arrives
   * later as an `error` event on the stream — and a stream `error` with no
   * listener is itself an uncaught exception. The net must adopt those events.
   */
  it("adopts stdout/stderr error events instead of letting them crash", () => {
    const before = {
      out: process.stdout.listenerCount("error"),
      err: process.stderr.listenerCount("error"),
    };
    uninstall = installCrashNet({ dataDir: dir, log: () => {} });

    expect(process.stdout.listenerCount("error")).toBe(before.out + 1);
    expect(process.stderr.listenerCount("error")).toBe(before.err + 1);

    // With a listener attached this is delivered, not thrown. Without one it
    // would take the process down.
    expect(() =>
      process.stderr.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" })),
    ).not.toThrow();

    uninstall();
    uninstall = undefined;
    // And it gives them back — otherwise every install leaks a listener on the
    // real streams, which is the exact bug class this module exists for.
    expect(process.stdout.listenerCount("error")).toBe(before.out);
    expect(process.stderr.listenerCount("error")).toBe(before.err);
  });

  it("stops writing to the console once a stream has reported an error", async () => {
    const seen: string[] = [];
    uninstall = installCrashNet({ dataDir: dir, log: (m) => seen.push(m) });

    process.emit("uncaughtException", new Error("before the pipe died"));
    expect(seen).toHaveLength(1);

    // The async EPIPE lands.
    process.stderr.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));

    process.emit("uncaughtException", new Error("after the pipe died"));
    // No second console write — that write is what kept feeding the loop.
    expect(seen).toHaveLength(1);
    // The disk record is unaffected: it is the one that matters.
    const text = await readFile(logFile(), "utf8");
    expect(text).toContain("before the pipe died");
    expect(text).toContain("after the pipe died");
  });

  it("rotates rather than growing without bound", async () => {
    uninstall = installCrashNet({ dataDir: dir, log: () => {} });
    await writeFile(logFile(), "x".repeat(CRASH_LOG_MAX_BYTES + 1), "utf8");

    process.emit("uncaughtException", new Error("after the flood"));

    // The fresh fault is readable, and the flood is kept exactly one deep.
    const text = await readFile(logFile(), "utf8");
    expect(text).toContain("after the flood");
    expect(text.length).toBeLessThan(CRASH_LOG_MAX_BYTES);
    expect((await readFile(`${logFile()}.1`, "utf8")).length).toBeGreaterThan(CRASH_LOG_MAX_BYTES);
  });
});

describe("attachCrashBus", () => {
  /**
   * The gap review found: `start()` installs the net before `buildApp()` — it
   * has to, everything after can reject — so it had no bus to pass, and the
   * publish was a permanent no-op in production. A crash could never reach the
   * UI, only crash.log.
   */
  it("delivers to a bus attached after install, and not before", async () => {
    const bus = new EventBus();
    const seen: WsServerEvent[] = [];
    bus.on("error", (e) => seen.push(e));

    uninstall = installCrashNet({ dataDir: dir, log: () => {} });

    process.emit("uncaughtException", new Error("before wiring"));
    expect(seen).toHaveLength(0);

    attachCrashBus(bus);
    process.emit("uncaughtException", new Error("after wiring"));

    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).toContain("after wiring");
    // The disk record is unconditional either way — it never depended on a bus.
    const text = await readFile(logFile(), "utf8");
    expect(text).toContain("before wiring");
    expect(text).toContain("after wiring");
  });

  it("is a no-op when nothing is installed", () => {
    expect(() => attachCrashBus(new EventBus())).not.toThrow();
  });
});
