/**
 * Is each agent runtime installed, and is it LOGGED IN? The setup wizard's
 * runtime step, probed live.
 *
 * `Harness.runtime()` answers the first question and always will — it is
 * resolved once and read on every chat spawn. It cannot answer the second, and
 * for Claude it cannot even say "no" to the first: the SDK ships a binary, so
 * `available` is unconditionally true. That left the wizard's only blocking
 * step unable to block. A brand-new machine with no Claude subscription and no
 * API key passed every check and found out on its first send.
 *
 * So this asks the runtimes themselves, through `Harness.probeLogin` — each
 * provider knows its own CLI (`claude auth status`, `codex login status`). The
 * host runs nothing itself: when it used to, it ran Claude's probe for any
 * provider it did not recognise. None of them read a credential, and none is
 * cached — the step has a Re-check button, and a cached "not logged in" after
 * the user has just logged in is worse than no check (see `routes/setup.ts` on
 * the `gh` probe).
 *
 * The probe runs under the DEFAULT account's env overlay for each provider, so
 * an install that has pointed Claude at a non-default `CLAUDE_CONFIG_DIR` gets
 * the answer for the directory its chats will actually use.
 */
import {
  subscriptionFor,
  type RuntimeLoginStatus,
  type RuntimeSetupStatus,
  type SubscriptionSettings,
} from "@dispatch/shared";
import type { Harness } from "../harness/types.js";
import { accountOf } from "./subscriptions.js";

const trim = (s: string): string => s.trim().replace(/\s+/g, " ").slice(0, 300);

/** A provider's own probe, or "not checked" when it brings none. Never throws. */
async function probeLogin(
  harness: Harness,
  exe: string,
  env: NodeJS.ProcessEnv,
): Promise<RuntimeLoginStatus> {
  if (!harness.probeLogin) {
    return { checked: false, loggedIn: false, error: `no login probe for ${harness.kind}` };
  }
  return harness.probeLogin(exe, env).catch((err: unknown) => ({
    checked: false,
    loggedIn: false,
    error: trim(err instanceof Error ? err.message : String(err)),
  }));
}

export interface RuntimeLoginDeps {
  env?: NodeJS.ProcessEnv;
}

/** One `RuntimeSetupStatus` per registered harness. Never throws. */
export async function probeRuntimeLogins(
  harnesses: Harness[],
  settings: SubscriptionSettings | null | undefined,
  deps: RuntimeLoginDeps = {},
): Promise<RuntimeSetupStatus[]> {
  const baseEnv = deps.env ?? process.env;
  return Promise.all(
    harnesses.map(async (harness): Promise<RuntimeSetupStatus> => {
      const rt = harness.runtime();
      // `rt.path` is the file the provider will spawn. A provider whose runtime
      // ships inside a dependency (Claude's bundled binary) resolves that file
      // itself — the host used to, which is how it came to know the layout of
      // the Claude SDK's platform packages.
      const exe = rt.available ? rt.path : undefined;
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
        // `available` without a binary: a runtime bundled in a dependency whose
        // platform package is missing from this install. The chat would fail to
        // spawn the same way.
        return {
          ...base,
          available: false,
          source: "missing",
          login: { checked: false, loggedIn: false, error: `no ${rt.kind} executable was found for this platform` },
        };
      }
      const env = { ...baseEnv, ...accountOf(subscriptionFor(settings, rt.kind)).env };
      return { ...base, login: await probeLogin(harness, exe, env) };
    }),
  );
}
