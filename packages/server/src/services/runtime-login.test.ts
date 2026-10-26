import { describe, expect, it } from "vitest";
import type { Harness } from "../harness/types.js";
import { probeRuntimeLogins } from "./runtime-login.js";

/**
 * The host no longer runs any probe itself — each provider brings one through
 * `Harness.probeLogin`. What is left to test here is the dispatch around it:
 * who gets asked, with which executable and env, and that nothing throws.
 */

type Env = Readonly<Record<string, string | undefined>>;

describe("probeRuntimeLogins", () => {
  const harness = (
    kind: string,
    runtime: Partial<ReturnType<Harness["runtime"]>>,
    probeLogin?: (exe: string, env: Env) => Promise<unknown>,
  ) =>
    ({
      kind,
      runtime: () => ({ kind, source: "installed", available: true, ...runtime }),
      ...(probeLogin ? { probeLogin } : {}),
    }) as unknown as Harness;

  it("asks a provider's own probe, with the resolved executable and env", async () => {
    const asked: Array<[string, string | undefined]> = [];
    const own = harness("goose", { path: "/x/goose", version: "1.51.0" }, async (exe, env) => {
      asked.push([exe, env.MARKER]);
      return { checked: true, loggedIn: true, notRequired: true };
    });
    const [status] = await probeRuntimeLogins([own], null, { env: { MARKER: "base" } });
    expect(asked).toEqual([["/x/goose", "base"]]);
    expect(status!.login).toMatchObject({ checked: true, notRequired: true });
  });

  it("reports a provider probe that throws as unchecked, not as a failed boot", async () => {
    const throwing = harness("codex", { path: "/x/codex" }, async () => {
      throw new Error("app-server exploded");
    });
    const [status] = await probeRuntimeLogins([throwing], null, { env: {} });
    expect(status!.login).toMatchObject({ checked: false, loggedIn: false, error: "app-server exploded" });
  });

  it("reports a provider with no probe as unchecked — never as if it were Claude", async () => {
    // Regression: the dispatcher's default used to be `claude auth status`, so
    // goose's CLI usage error landed on the setup card. Claude is not special
    // here any more; its probe is `ClaudeHarness.probeLogin`.
    for (const kind of ["opencode", "claude"]) {
      const [status] = await probeRuntimeLogins([harness(kind, { path: `/x/${kind}` })], null, { env: {} });
      expect(status!.login).toMatchObject({ checked: false, loggedIn: false, error: `no login probe for ${kind}` });
    }
  });

  it("downgrades `available` when the runtime resolved no executable", async () => {
    // `available: true` with nothing to spawn is a bundled runtime whose
    // platform package is absent — a chat would fail exactly the same way.
    let asked = false;
    const [status] = await probeRuntimeLogins(
      [harness("claude", { source: "bundled" }, async () => ((asked = true), { checked: true, loggedIn: true }))],
      null,
      { env: {} },
    );
    expect(asked).toBe(false);
    expect(status!.available).toBe(false);
    expect(status!.source).toBe("missing");
    expect(status!.login.checked).toBe(false);
  });

  it("does not probe a runtime that is not installed", async () => {
    let calls = 0;
    const [status] = await probeRuntimeLogins(
      [harness("codex", { source: "missing", available: false }, async () => (calls++, { checked: true, loggedIn: true }))],
      null,
      { env: {} },
    );
    expect(calls).toBe(0);
    expect(status).toMatchObject({ kind: "codex", available: false, login: { checked: false, loggedIn: false } });
  });

  it("probes under the default account's config dir when one is configured", async () => {
    let seen: Env | undefined;
    await probeRuntimeLogins(
      [
        harness("claude", { path: "/usr/local/bin/claude" }, async (_exe, env) => {
          seen = env;
          return { checked: true, loggedIn: true };
        }),
      ],
      {
        subscriptions: [{ id: "work", name: "Work", provider: "claude", configDir: "/home/ada/.claude-work" }],
        harness: { defaults: { claude: { subscriptionId: "work" } } },
      },
      { env: {} },
    );
    expect(seen?.CLAUDE_CONFIG_DIR).toMatch(/\.claude-work$/);
  });
});
