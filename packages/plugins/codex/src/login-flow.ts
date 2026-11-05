/**
 * `codex login`, driven from Settings → Accounts (`Harness.startLogin`).
 *
 * Codex's ChatGPT sign-in is a localhost-callback flow: the CLI starts a
 * server on `localhost:1455`, opens a browser on the HOST, and prints the same
 * URL ("If your browser did not open, navigate to this URL…"). The redirect
 * lands on the host's loopback, so the link only completes from a browser on
 * the machine Dispatch runs on — which the pane says, rather than letting a
 * phone user stare at a "can't connect to localhost" page. There is no code to
 * paste back, so this flow has no `submitCode`.
 *
 * The driver is a copy of the Claude plugin's, as the login probes are: each
 * provider plugin builds on its own and shares no runtime code but the types.
 * Nothing here reads the token; the CLI writes it under the account's
 * `CODEX_HOME` as it would from a terminal.
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
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // An npm-global install resolves to a `.cmd` shim, which Node refuses to
    // spawn without a shell since the CVE-2024-27980 fix (EINVAL). The args
    // are constants, so the shell has nothing to mis-parse.
    shell: /\.(cmd|bat)$/i.test(exe),
  });

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const URL_RE = /https:\/\/[^\s"'<>]+/g;

/** The CLI's own last words, for a failure the human can act on. */
const tail = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/https?:\/\//.test(l))
    .slice(-3)
    .join(" ")
    .slice(0, 300);

/** Read the progress out of everything printed so far. */
export function parseCodexLoginOutput(text: string): HarnessLoginProgress {
  const clean = text.replace(ANSI, "");
  const urls = clean.match(URL_RE) ?? [];
  // The loopback server's own address is printed first; it is not a page to sign in on.
  const url = urls.find((u) => /oauth\/authorize/.test(u)) ?? urls.find((u) => !/\/\/(localhost|127\.0\.0\.1)[:/]/.test(u));
  return {
    ...(url ? { url } : {}),
    hint: "Finish this in a browser on the machine Dispatch runs on: Codex signs in through a callback to that machine's localhost.",
  };
}

export function startCodexLogin(
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
    child = spawn(exe, ["login"], env);
  } catch (err) {
    spawnError = err instanceof Error ? err.message : String(err);
  }

  const onData = (chunk: Buffer | string) => {
    output = (output + String(chunk)).slice(-MAX_OUTPUT);
    const next = parseCodexLoginOutput(output);
    if (JSON.stringify(next) === JSON.stringify(progress)) return;
    progress = next;
    for (const cb of listeners) cb(progress);
  };

  const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const proc = child;
    if (!proc) {
      resolve({ ok: false, error: spawnError ?? "codex did not start" });
      return;
    }
    const timer = setTimeout(() => {
      cancelled = true;
      proc.kill();
    }, timeoutMs);
    timer.unref?.();
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.once("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    proc.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !cancelled) resolve({ ok: true });
      else if (cancelled) resolve({ ok: false, error: "sign-in was cancelled or timed out" });
      else resolve({ ok: false, error: tail(output.replace(ANSI, "")) || `codex login exited ${code}` });
    });
  });

  return {
    onProgress(cb) {
      listeners.add(cb);
      if (Object.keys(progress).length > 0) cb(progress);
      return () => listeners.delete(cb);
    },
    cancel() {
      cancelled = true;
      child?.kill();
    },
    done,
  };
}
