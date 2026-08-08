/**
 * The net that makes the NEXT crash diagnosable. See crash-log.ts for why this
 * exists: the 2026-08-07 deaths left no record anywhere — not on stderr (the
 * launcher runs under pythonw, so there is no console), and not in the Windows
 * Application log (a Node fatal error is an orderly exit, not an SEH fault).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCrashNet, attachCrashBus, CRASH_LOG_NAME } from "./crash-log.js";
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
