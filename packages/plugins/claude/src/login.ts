/**
 * Is Claude Code logged in — the provider's half of the setup wizard's runtime
 * step (`Harness.probeLogin`).
 *
 * This used to be the host's: `services/runtime-login.ts` switched on
 * `harness.kind === "claude"` and ran `claude auth status` itself, which is the
 * kind of branch that made a provider the host did not know fall through to a
 * Claude-shaped probe. Owning it here is also what lets this directory leave
 * the host as a plugin without the setup card losing its Claude answer.
 *
 * Reads no credential: `claude auth status` reports the method and plan itself.
 */
import { execFile } from "node:child_process";
import type { RuntimeLoginStatus } from "@dispatch/shared";

/** A login probe that hangs is a wedged runtime, not a slow one. */
const PROBE_TIMEOUT_MS = 15_000;

export interface ProbeRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawn-level failure (ENOENT, EACCES) — the binary did not run at all. */
  spawnError?: string;
}

export type RunLoginProbe = (
  exe: string,
  args: string[],
  env: Readonly<Record<string, string | undefined>>,
) => Promise<ProbeRun>;

const runProbe: RunLoginProbe = (exe, args, env) =>
  new Promise((resolve) => {
    execFile(
      exe,
      args,
      { env: env as NodeJS.ProcessEnv, timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: "utf8", maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        const code: unknown = (error as { code?: unknown } | null)?.code;
        // execFile reports a non-zero exit as an Error whose `code` is the
        // numeric status; a spawn failure has a string code (ENOENT). Only the
        // latter means "did not run".
        if (error && typeof code !== "number") {
          resolve({ code: null, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), spawnError: error.message });
          return;
        }
        resolve({ code: typeof code === "number" ? code : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });

const trim = (s: string): string => s.trim().replace(/\s+/g, " ").slice(0, 300);

/**
 * `claude auth status` → `{ loggedIn, authMethod, subscriptionType, email }`.
 * It exits 1 when logged out but STILL prints the JSON, so the exit code is not
 * the signal; the body is. An unparseable body is a probe failure, not a "no".
 */
export async function probeClaudeLogin(
  exe: string,
  env: Readonly<Record<string, string | undefined>>,
  run: RunLoginProbe = runProbe,
): Promise<RuntimeLoginStatus> {
  const ran = await run(exe, ["auth", "status"], env);
  if (ran.spawnError) return { checked: false, loggedIn: false, error: trim(ran.spawnError) };
  const start = ran.stdout.indexOf("{");
  const end = ran.stdout.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return {
      checked: false,
      loggedIn: false,
      error: trim(ran.stderr || ran.stdout || `claude auth status exited ${ran.code}`) || "claude auth status printed nothing",
    };
  }
  let body: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown; email?: unknown };
  try {
    body = JSON.parse(ran.stdout.slice(start, end + 1)) as typeof body;
  } catch {
    return { checked: false, loggedIn: false, error: "claude auth status printed unreadable JSON" };
  }
  const loggedIn = body.loggedIn === true;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  return {
    checked: true,
    loggedIn,
    ...(loggedIn && str(body.authMethod) ? { method: str(body.authMethod) } : {}),
    ...(loggedIn && str(body.subscriptionType) ? { subscription: str(body.subscriptionType) } : {}),
    ...(loggedIn && str(body.email) ? { account: str(body.email) } : {}),
    ...(loggedIn ? {} : { error: "not logged in — run `claude` and use /login, or `claude auth login`" }),
  };
}
