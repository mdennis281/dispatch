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
import { installCrashNet, CRASH_LOG_NAME } from "./crash-log.js";

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
});
