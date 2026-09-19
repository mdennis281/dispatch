/**
 * Is each agent runtime installed, and is it LOGGED IN? The setup wizard's
 * runtime step, probed live.
 *
 * `Harness.runtime()` answers the first question and always will — it is
 * resolved once at boot and read on every chat spawn. It cannot answer the
 * second, and for Claude it cannot even say "no" to the first: the SDK ships a
 * binary, so `available` is unconditionally true. That left the wizard's only
 * blocking step unable to block. A brand-new machine with no Claude subscription
 * and no API key passed every check and found out on its first send.
 *
 * So this asks the runtimes themselves. `claude auth status` prints JSON that
 * names the method and plan; `codex login status` exits 0 when a login exists.
 * Neither reads a credential here, and neither is cached — the step has a
 * Re-check button, and a cached "not logged in" after the user has just logged
 * in is worse than no check (see `routes/setup.ts` on the `gh` probe).
 *
 * The probe runs under the DEFAULT account's env overlay for each provider, so
 * an install that has pointed Claude at a non-default `CLAUDE_CONFIG_DIR` gets
 * the answer for the directory its chats will actually use.
 */
import { execFile } from "node:child_process";
import {
  subscriptionFor,
  type RuntimeLoginStatus,
  type RuntimeSetupStatus,
  type SubscriptionSettings,
} from "@dispatch/shared";
import type { Harness, HarnessRuntimeInfo } from "../harness/types.js";
import { accountOf } from "./subscriptions.js";
import { bundledExecutable } from "./runtime.js";

/** A login probe that hangs is a wedged runtime, not a slow one. */
const PROBE_TIMEOUT_MS = 15_000;

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawn-level failure (ENOENT, EACCES) — the binary did not run at all. */
  spawnError?: string;
}

export type RunProbe = (exe: string, args: string[], env: NodeJS.ProcessEnv) => Promise<Ran>;

const runProbe: RunProbe = (exe, args, env) =>
  new Promise((resolve) => {
    execFile(
      exe,
      args,
      { env, timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: "utf8", maxBuffer: 1 << 20 },
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
  env: NodeJS.ProcessEnv,
  run: RunProbe = runProbe,
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

/**
 * `codex login status` → exit 0 with "Logged in using ChatGPT" (or an API key),
 * non-zero with "Not logged in". The method is scraped from the prose because
 * that is all the command offers.
 */
export async function probeCodexLogin(
  exe: string,
  env: NodeJS.ProcessEnv,
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

export interface RuntimeLoginDeps {
  run?: RunProbe;
  /** Where the bundled Claude binary lives; injectable so tests never resolve the SDK. */
  bundled?: () => string | undefined;
  env?: NodeJS.ProcessEnv;
}

/** The executable a login probe should ask, given how the runtime resolved. */
function executableFor(rt: HarnessRuntimeInfo, bundled: () => string | undefined): string | undefined {
  if (rt.path) return rt.path;
  return rt.source === "bundled" ? bundled() : undefined;
}

/** One `RuntimeSetupStatus` per registered harness. Never throws. */
export async function probeRuntimeLogins(
  harnesses: Harness[],
  settings: SubscriptionSettings | null | undefined,
  deps: RuntimeLoginDeps = {},
): Promise<RuntimeSetupStatus[]> {
  const run = deps.run ?? runProbe;
  const bundled = deps.bundled ?? bundledExecutable;
  const baseEnv = deps.env ?? process.env;
  return Promise.all(
    harnesses.map(async (harness): Promise<RuntimeSetupStatus> => {
      const rt = harness.runtime();
      const exe = rt.available ? executableFor(rt, bundled) : undefined;
      const base = {
        kind: rt.kind,
        available: rt.available,
        ...(rt.version ? { version: rt.version } : {}),
        source: rt.source,
        ...(exe ? { path: exe } : {}),
      };
      if (!rt.available) {
        return { ...base, login: { checked: false, loggedIn: false, error: "not installed" } };
      }
      if (!exe) {
        // `available` without a binary: the SDK's platform package is missing
        // from this install. The chat would fail to spawn the same way.
        return {
          ...base,
          available: false,
          source: "missing",
          login: { checked: false, loggedIn: false, error: "the bundled Claude Code binary for this platform is not installed" },
        };
      }
      const env = { ...baseEnv, ...accountOf(subscriptionFor(settings, rt.kind)).env };
      const login =
        rt.kind === "codex" ? await probeCodexLogin(exe, env, run) : await probeClaudeLogin(exe, env, run);
      return { ...base, login };
    }),
  );
}
