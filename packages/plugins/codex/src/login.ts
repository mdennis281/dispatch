/**
 * `codex login status` → exit 0 with "Logged in using ChatGPT" (or an API key),
 * non-zero with "Not logged in". The method is scraped from the prose because
 * that is all the command offers.
 *
 * Moved here from the host's `runtime-login.ts` with the rest of Codex: the
 * host now asks `Harness.probeLogin` instead of switching on the provider id.
 */
import { execFile } from "node:child_process";
import type { RuntimeLoginStatus } from "@dispatch/shared";

const PROBE_TIMEOUT_MS = 15_000;

export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawn-level failure (ENOENT, EACCES) — the binary did not run at all. */
  spawnError?: string;
}

export type RunProbe = (
  exe: string,
  args: string[],
  env: Readonly<Record<string, string | undefined>>,
) => Promise<Ran>;

const runProbe: RunProbe = (exe, args, env) =>
  new Promise((resolve) => {
    execFile(
      exe,
      args,
      { env: { ...env }, timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: "utf8", maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        const code: unknown = (error as { code?: unknown } | null)?.code;
        // A non-zero exit is an Error whose `code` is the numeric status; a
        // spawn failure has a string code (ENOENT). Only the latter means
        // "did not run".
        if (error && typeof code !== "number") {
          resolve({ code: null, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), spawnError: error.message });
          return;
        }
        resolve({ code: typeof code === "number" ? code : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });

const trim = (s: string): string => s.trim().replace(/\s+/g, " ").slice(0, 300);

export async function probeCodexLogin(
  exe: string,
  env: Readonly<Record<string, string | undefined>>,
  run: RunProbe = runProbe,
): Promise<RuntimeLoginStatus> {
  const ran = await run(exe, ["login", "status"], env);
  if (ran.spawnError) return { checked: false, loggedIn: false, error: trim(ran.spawnError) };
  const text = trim(`${ran.stdout}\n${ran.stderr}`);
  if (ran.code === 0) {
    const method = /logged in (?:using|with|via) (.+?)(?:[.,]|$)/i.exec(text)?.[1]?.trim();
    return { checked: true, loggedIn: true, ...(method ? { method } : {}) };
  }
  return {
    checked: true,
    loggedIn: false,
    error: text ? `${text} — run \`codex login\`` : "not logged in — run `codex login`",
  };
}
