import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { EventBus } from "../bus.js";
import {
  TerminalService,
  commandWrite,
  defaultSpawnShell,
  probeLine,
  type ShellFlavour,
  type ShellProcess,
  type SpawnShell,
} from "./terminal.js";
import { unwrapCommandWrite } from "./terminal.testkit.js";

/**
 * A command that reads stdin, over the REAL shells.
 *
 * Core writes the command, its probe and the next command down one pipe, and
 * a program the command starts inherits that pipe. Before `commandWrite`, a
 * stdin reader ate the probe: `cat`, `ssh`, a credential prompt. The marker
 * never printed, the run sat out its whole timeout, and the following command
 * became that program's input. A fake shell can't show any of this, since the
 * bug lives in how a real shell hands its stdin to a child. So each case here
 * runs the platform's own shell. On Windows that is PowerShell, which needs a
 * different fix from bash, and Git Bash too when it is installed.
 */

/** Reads stdin to EOF, then says how much it got. Valid in bash and PowerShell. */
const READ_STDIN = `node -e "let n=0;process.stdin.on('data',d=>n+=d.length);process.stdin.on('end',()=>console.log('STDIN-BYTES='+n))"`;

/**
 * A watcher in miniature: quits the moment stdin ends, as `esbuild --watch`
 * does, says so if anything arrives on it, and otherwise stops itself after
 * 3 s so the test can see how it ended.
 */
const WATCHER =
  `node -e "process.stdin.on('data',d=>console.log('WATCHER-GOT '+JSON.stringify(String(d))));` +
  `process.stdin.on('end',()=>{console.log('WATCHER-EOF');process.exit(0)});` +
  `setTimeout(()=>{console.log('WATCHER-TIMER');process.exit(0)},3000)"`;

interface Shell {
  label: string;
  flavour: ShellFlavour;
  spawn: SpawnShell;
  setVars: string;
  readVars: string;
  exit3: string;
}

const posix = (label: string, spawn: SpawnShell): Shell => ({
  label,
  flavour: "posix",
  spawn,
  setVars: "export CM_STDIN_ENV=kept; cm_stdin_var=also",
  readVars: 'echo "$CM_STDIN_ENV $cm_stdin_var"',
  exit3: "(exit 3)",
});

const powershell = (label: string, spawn: SpawnShell): Shell => ({
  label,
  flavour: "powershell",
  spawn,
  setVars: "$env:CM_STDIN_ENV = 'kept'; $cm_stdin_var = 'also'",
  readVars: 'Write-Output "$env:CM_STDIN_ENV $cm_stdin_var"',
  exit3: "cmd /c exit 3",
});

const shells: Shell[] = [];
if (process.platform === "win32") {
  shells.push(powershell("Windows PowerShell", defaultSpawnShell));
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  // PowerShell 7 is what a Windows backend may well run. The stdin detach
  // relies on the shell reading its own input through a reader it opened
  // before the detach; were pwsh to re-read the live handle, it would see EOF
  // and exit after the first command.
  const pwsh = join(programFiles, "PowerShell", "7", "pwsh.exe");
  if (existsSync(pwsh)) {
    shells.push(
      powershell("PowerShell 7", (cwd) =>
        nodeSpawn(pwsh, ["-NoLogo", "-NoProfile", "-Command", "-"], {
          cwd,
          windowsHide: true,
          env: process.env,
        }) as unknown as ShellProcess,
      ),
    );
  }
  // Git for Windows' bash, never `bash` off PATH: that can be WSL's launcher.
  const gitBash = join(programFiles, "Git", "bin", "bash.exe");
  if (existsSync(gitBash)) {
    shells.push(
      posix("Git Bash", (cwd) => nodeSpawn(gitBash, [], { cwd, env: process.env }) as unknown as ShellProcess),
    );
  }
} else {
  shells.push(posix("bash", defaultSpawnShell));
}

const root = mkdtempSync(join(tmpdir(), "cm-stdin-"));
// Retried: on Windows a shell that `dispose` just killed still holds the
// directory as its cwd for a moment, and the delete fails with EPERM.
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

describe.each(shells)("a command that reads stdin, under $label", (shell) => {
  const service = () =>
    new TerminalService({ bus: new EventBus(), deps: { spawn: shell.spawn, flavour: shell.flavour } });
  // Short: the unfixed shell waits the full deadline, and that wait IS the bug.
  const timeoutMs = 10_000;

  it("gets EOF at once, and the shell's next command still runs", async () => {
    const t = service();
    try {
      const read = await t.run({ chatId: "c", name: "t", command: READ_STDIN, cwd: root, timeoutMs });
      expect(read.timedOut).toBeFalsy();
      expect(read.output).toContain("STDIN-BYTES=0");
      expect(read.exitCode).toBe(0);

      const next = await t.run({ chatId: "c", name: "t", command: "echo after-reader", cwd: root, timeoutMs });
      expect(next.timedOut).toBeFalsy();
      expect(next.output.trim()).toBe("after-reader");

      // Again: PowerShell detaches stdin per command and the probe restores it.
      // If the restore broke the next detach, this one would hang.
      const again = await t.run({ chatId: "c", name: "t", command: READ_STDIN, cwd: root, timeoutMs });
      expect(again.output).toContain("STDIN-BYTES=0");
    } finally {
      await t.reap();
      t.dispose();
    }
  }, 60_000);

  // Foreground EOF killed the dev loop `background: true` exists for: a
  // watcher that quits on EOF died the moment it started (#478).
  it("a background command's stdin never ends and never carries the probe", async () => {
    const t = service();
    try {
      const started = await t.run({ chatId: "c", name: "bg", command: WATCHER, cwd: root, background: true });
      expect(started.backgrounded).toBe(true);
      // Its own timer ends it, and then its probe lands and frees the shell.
      await vi.waitFor(
        () => {
          const info = t.listChat("c").find((x) => x.name === "bg");
          expect(info && !info.busy && !info.background).toBe(true);
        },
        { timeout: 30_000, interval: 200 },
      );
      const { output } = await t.tail("c", "bg");
      expect(output).toContain("WATCHER-TIMER");
      expect(output).not.toContain("WATCHER-EOF");
      expect(output).not.toContain("WATCHER-GOT");

      // The next command still gets EOF, and the shell is fine.
      const read = await t.run({ chatId: "c", name: "bg", command: READ_STDIN, cwd: root, timeoutMs });
      expect(read.output).toContain("STDIN-BYTES=0");
    } finally {
      await t.reap();
      t.dispose();
    }
  }, 60_000);

  it("still keeps cwd, variables and the exit code across runs", async () => {
    const t = service();
    const sub = mkdtempSync(join(root, "sub-"));
    try {
      await t.run({ chatId: "c", name: "t", command: `cd ${basename(sub)}`, cwd: root, timeoutMs });
      await t.run({ chatId: "c", name: "t", command: shell.setVars, cwd: root, timeoutMs });

      const vars = await t.run({ chatId: "c", name: "t", command: shell.readVars, cwd: root, timeoutMs });
      expect(vars.output.trim()).toBe("kept also");
      expect(basename(vars.cwd)).toBe(basename(sub));

      const failed = await t.run({ chatId: "c", name: "t", command: shell.exit3, cwd: root, timeoutMs });
      expect(failed.exitCode).toBe(3);
      // A native command: PowerShell reports a cmdlet's run with whatever
      // `$LASTEXITCODE` the last native one left, which here is 3.
      const ok = await t.run({ chatId: "c", name: "t", command: "node -e 0", cwd: root, timeoutMs });
      expect(ok.exitCode).toBe(0);
    } finally {
      await t.reap();
      t.dispose();
    }
  }, 60_000);

  it.runIf(shell.flavour === "posix")(
    "survives a command that is only a comment, or ends in a continuation",
    async () => {
      const t = service();
      try {
        const comment = await t.run({ chatId: "c", name: "t", command: "# nothing to run", cwd: root, timeoutMs });
        expect(comment.timedOut).toBeFalsy();
        expect(comment.exitCode).toBe(0);
        const split = await t.run({ chatId: "c", name: "t", command: "echo split \\", cwd: root, timeoutMs });
        expect(split.timedOut).toBeFalsy();
        expect(split.output.trim()).toBe("split");
        const quoted = await t.run({ chatId: "c", name: "t", command: `echo "it's" 'single'`, cwd: root, timeoutMs });
        expect(quoted.output.trim()).toBe("it's single");
      } finally {
        await t.reap();
        t.dispose();
      }
    },
    60_000,
  );

  // The first cut wrapped the command in `{ …; } </dev/null`. bash parses a
  // group whole before running any of it, so a line that changes how the next
  // one PARSES stopped working, and the syntax error that followed ended the
  // shell. Review caught it on #478.
  it.runIf(shell.flavour === "posix")(
    "runs a multi-line command line by line, and outlives a syntax error",
    async () => {
      const t = service();
      try {
        const glob = await t.run({
          chatId: "c",
          name: "t",
          command: "shopt -s extglob\nls -d !(zzz-no-such) >/dev/null && echo extglob-ok",
          cwd: root,
          timeoutMs,
        });
        expect(glob.output).toContain("extglob-ok");
        expect(glob.exitCode).toBe(0);

        // A syntax error at the top level ends a non-interactive bash; inside
        // `eval` it is just exit 2.
        const broken = await t.run({ chatId: "c", name: "t", command: "echo (", cwd: root, timeoutMs });
        expect(broken.timedOut).toBeFalsy();
        expect(broken.exitCode).toBe(2);
        const after = await t.run({ chatId: "c", name: "t", command: "echo still-here", cwd: root, timeoutMs });
        expect(after.output.trim()).toBe("still-here");
      } finally {
        await t.reap();
        t.dispose();
      }
    },
    60_000,
  );
});

describe("commandWrite", () => {
  it("hands a posix command to `eval` single-quoted, with stdin from /dev/null", () => {
    expect(commandWrite("echo hi", "posix", true)).toBe("eval 'echo hi\n' </dev/null\n");
    expect(commandWrite("echo hi", "posix", false)).toBe("eval 'echo hi\n' </dev/null\n");
    // A `'` closes the quote, adds an escaped one, and reopens.
    expect(commandWrite("echo 'a'", "posix", true)).toBe("eval 'echo '\\''a'\\''\n' </dev/null\n");
  });

  it("leaves a background posix command's line open for the probe to finish", () => {
    // No redirect and NO newline: bash reads the probe with the command's line.
    expect(commandWrite("vite", "posix", false, true)).toBe("eval 'vite\n' ; ");
  });

  it("holds a background PowerShell command's stdin on a pipe instead of NUL", () => {
    const fg = commandWrite("vite", "powershell", false);
    const bg = commandWrite("vite", "powershell", false, true);
    expect(fg).toContain("::Detach()");
    expect(bg).toContain("::Hold()");
    expect(bg).not.toContain("::Detach()");
    expect(bg.endsWith("\nvite\n")).toBe(true);
  });

  it("is what the test fakes unwrap back to the command", () => {
    for (const flavour of ["posix", "powershell"] as const) {
      for (const cmd of ["say hi", "echo 'a' \"b\"\nsecond line"]) {
        for (const background of [false, true]) {
          expect(unwrapCommandWrite(commandWrite(cmd, flavour, true, background))).toBe(cmd + "\n");
          expect(unwrapCommandWrite(commandWrite(cmd, flavour, false, background))).toBe(cmd + "\n");
        }
      }
    }
  });

  it("detaches PowerShell's stdin on the line before the command, compiling the helper only once", () => {
    const first = commandWrite("Get-Date", "powershell", true);
    const later = commandWrite("Get-Date", "powershell", false);
    expect(later).toBe(
      "try { if ('DispatchTerminal.Stdin' -as [type]) { [DispatchTerminal.Stdin]::Detach() } } catch { }\nGet-Date\n",
    );
    expect(first).toContain("Add-Type -TypeDefinition '");
    expect(first.endsWith(later)).toBe(true);
    // The C# rides inside a single-quoted PowerShell string: one `'` ends it.
    const cs = first.slice(first.indexOf("-TypeDefinition '") + "-TypeDefinition '".length, first.indexOf("' -ErrorAction"));
    expect(cs).toContain("SetStdHandle");
    expect(cs).not.toContain("'");
  });

  it("restores PowerShell's stdin in the probe only after reading $? and $LASTEXITCODE", () => {
    const probe = probeLine("M", "powershell");
    expect(probe.startsWith("$__cm_ok = $?; $__cm_ec = $LASTEXITCODE;")).toBe(true);
    expect(probe.indexOf("::Restore()")).toBeGreaterThan(probe.indexOf("$LASTEXITCODE"));
    expect(probe.indexOf("::Restore()")).toBeLessThan(probe.indexOf("Write-Output"));
  });
});

/** Records every write and answers each probe, in either dialect. */
class RecordingShell extends EventEmitter implements ShellProcess {
  readonly writes: string[] = [];
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    write: (chunk: string): void => {
      this.writes.push(chunk);
      const marker = chunk.match(/CMTERMSENTINEL_[A-Za-z0-9_-]+/);
      if (marker) this.stdout.emit("data", Buffer.from(`${marker[0]}|0|True|/w\n`));
    },
  };
  kill(): void {
    this.emit("exit", 0);
  }
}

describe("TerminalService writes", () => {
  it.each(["powershell", "posix"] as const)(
    "%s: every command goes out isolated, and the probe stays a write of its own",
    async (flavour) => {
      const shells: RecordingShell[] = [];
      const t = new TerminalService({
        bus: new EventBus(),
        deps: { spawn: () => (shells.push(new RecordingShell()), shells.at(-1)!), flavour },
      });
      try {
        await t.run({ chatId: "c", name: "t", command: "first", cwd: "/w" });
        await t.run({ chatId: "c", name: "t", command: "second", cwd: "/w" });
        const w = shells[0]!.writes;
        expect(w).toEqual([
          commandWrite("first", flavour, true),
          probeLine(w[1]!.match(/CMTERMSENTINEL_[A-Za-z0-9_-]+/)![0], flavour) + "\n",
          commandWrite("second", flavour, false),
          probeLine(w[3]!.match(/CMTERMSENTINEL_[A-Za-z0-9_-]+/)![0], flavour) + "\n",
        ]);
      } finally {
        await t.reap();
        t.dispose();
      }
    },
  );
});
