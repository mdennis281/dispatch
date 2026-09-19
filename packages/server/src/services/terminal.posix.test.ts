import { describe, expect, it } from "vitest";
import { EventBus } from "../bus.js";
import { TerminalService, defaultSpawnShell, probeLine } from "./terminal.js";

/**
 * The REAL shell, on the two platforms that never had one.
 *
 * Every other terminal test drives a scripted fake, which is why the service
 * shipped spawning `powershell.exe` unconditionally and nobody noticed until
 * the install smoke ran a terminal on a macOS runner. This file is the only
 * check that a piped `bash` executes incrementally, keeps its cwd, and prints
 * a marker the parser can read — so it runs the real thing, and only where
 * the real thing is bash.
 */
describe.skipIf(process.platform === "win32")("terminal over a real POSIX shell", () => {
  const service = () =>
    new TerminalService({ bus: new EventBus(), deps: { spawn: defaultSpawnShell } });

  it("runs a command, reports its exit code, and keeps cwd across runs", async () => {
    const t = service();
    try {
      const echo = await t.run({ chatId: "c", name: "t", command: "echo smoke-ok", cwd: "/" });
      expect(echo.exitCode).toBe(0);
      expect(echo.output).toContain("smoke-ok");
      expect(echo.output).not.toContain("CMTERMSENTINEL");

      const failed = await t.run({ chatId: "c", name: "t", command: "(exit 3)", cwd: "/" });
      expect(failed.exitCode).toBe(3);

      await t.run({ chatId: "c", name: "t", command: "cd /tmp", cwd: "/" });
      const pwd = await t.run({ chatId: "c", name: "t", command: "pwd", cwd: "/" });
      expect(pwd.output.trim()).toMatch(/\/tmp$/);
      expect(pwd.cwd).toMatch(/\/tmp$/);
    } finally {
      t.dispose();
    }
  }, 20_000);
});

describe("probeLine", () => {
  it("speaks each shell's dialect but prints one marker shape", () => {
    expect(probeLine("M", "powershell")).toContain('Write-Output ("M|"');
    const posix = probeLine("M", "posix");
    expect(posix).toContain("printf '%s|%s|%s|%s\\n' 'M'");
    // `$?` is read FIRST on the line — anything before it would overwrite it.
    expect(posix.startsWith("__cm_ec=$?;")).toBe(true);
  });
});
