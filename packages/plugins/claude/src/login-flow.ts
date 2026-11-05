/**
 * `claude auth login`, driven from Settings → Accounts (`Harness.startLogin`).
 *
 * Before this the only way back in after a logout was a terminal, and the
 * recipe for a second account — `CLAUDE_CONFIG_DIR=<dir> claude auth login` —
 * is exactly the line that gets mis-quoted in PowerShell and logs the DEFAULT
 * account in instead. Here the env overlay is the host's, so it cannot be.
 *
 * What the CLI does with no TTY (measured, Claude Code 2.x on Windows):
 *
 *   Opening browser to sign in…
 *   If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&…
 *   Paste code here if prompted >
 *
 * It opens a browser on the HOST itself (a localhost-callback flow that
 * finishes on its own when the browser is on this machine) and prints a
 * second, manual URL whose redirect shows a code to paste back. That second
 * one is what makes this usable from a phone or another PC: the human opens it
 * wherever they are and pastes the code into the pane, which writes it to the
 * CLI's stdin. Either path ends with the CLI exiting 0.
 *
 * Nothing here reads or stores the resulting token — the CLI writes it into
 * the account's own directory, as it would from a terminal.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { HarnessLoginFlow, HarnessLoginProgress } from "@dispatch/shared";

/** A sign-in nobody finishes is abandoned, not left holding a process. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** Enough of the CLI's output to find the URL and quote an error; no more. */
const MAX_OUTPUT = 64 * 1024;

export type SpawnLogin = (
  exe: string,
  args: string[],
  env: Readonly<Record<string, string | undefined>>,
) => ChildProcess;

const defaultSpawn: SpawnLogin = (exe, args, env) =>
  nodeSpawn(exe, args, {
    env: env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // An npm-global install resolves to a `.cmd` shim, which Node refuses to
    // spawn without a shell since the CVE-2024-27980 fix (EINVAL). The args
    // are constants, so the shell has nothing to mis-parse.
    shell: /\.(cmd|bat)$/i.test(exe),
  });

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const URL_RE = /https:\/\/[^\s"'<>]+/g;

/**
 * The CLI's own last words, for a failure the human can act on. The prompt has
 * no newline, so a rejected code's verdict lands on the SAME line as it —
 * `Paste code here if prompted > Login failed: That code wasn't accepted…` —
 * and dropping prompt lines dropped the one sentence worth showing.
 */
export const loginFailureText = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((l) => l.replace(/^.*paste code[^>]*>\s*/i, "").trim())
    .filter((l) => l && !/https:\/\//.test(l) && !/^opening browser/i.test(l))
    .slice(-3)
    .join(" ")
    .slice(0, 300);

/**
 * Read the progress out of everything printed so far. The manual URL is the
 * one wanted: it is the only one that works from a browser on another machine,
 * and the only one the CLI prints at all.
 */
export function parseClaudeLoginOutput(text: string): HarnessLoginProgress {
  const clean = text.replace(ANSI, "");
  const urls = clean.match(URL_RE) ?? [];
  const url = urls.find((u) => /oauth\/authorize/.test(u)) ?? urls[0];
  return {
    ...(url ? { url } : {}),
    ...(/paste code/i.test(clean) ? { awaitingCode: true } : {}),
  };
}

export function startClaudeLogin(
  exe: string,
  env: Readonly<Record<string, string | undefined>>,
  spawn: SpawnLogin = defaultSpawn,
  timeoutMs = LOGIN_TIMEOUT_MS,
): HarnessLoginFlow {
  const listeners = new Set<(p: HarnessLoginProgress) => void>();
  let progress: HarnessLoginProgress = {};
  let output = "";
  let cancelled = false;

  let child: ChildProcess | undefined;
  let spawnError: string | undefined;
  try {
    child = spawn(exe, ["auth", "login"], env);
  } catch (err) {
    spawnError = err instanceof Error ? err.message : String(err);
  }

  const onData = (chunk: Buffer | string) => {
    output = (output + String(chunk)).slice(-MAX_OUTPUT);
    const next = parseClaudeLoginOutput(output);
    if (JSON.stringify(next) === JSON.stringify(progress)) return;
    progress = next;
    for (const cb of listeners) cb(progress);
  };

  const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const proc = child;
    if (!proc) {
      resolve({ ok: false, error: spawnError ?? "claude did not start" });
      return;
    }
    const timer = setTimeout(() => {
      cancelled = true;
      proc.kill();
    }, timeoutMs);
    timer.unref?.();
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    // A closed stdin (the CLI exited) must not crash the host on a late write.
    proc.stdin?.on("error", () => {});
    proc.once("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    proc.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !cancelled) resolve({ ok: true });
      else if (cancelled) resolve({ ok: false, error: "sign-in was cancelled or timed out" });
      else resolve({ ok: false, error: loginFailureText(output.replace(ANSI, "")) || `claude auth login exited ${code}` });
    });
  });

  return {
    onProgress(cb) {
      listeners.add(cb);
      if (Object.keys(progress).length > 0) cb(progress);
      return () => listeners.delete(cb);
    },
    submitCode(code) {
      const clean = code.trim();
      if (!clean || !child?.stdin || child.stdin.destroyed) return;
      child.stdin.write(`${clean}\n`);
    },
    cancel() {
      cancelled = true;
      child?.kill();
    },
    done,
  };
}
