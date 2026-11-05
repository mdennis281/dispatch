import { describe, expect, it } from "vitest";
import { registerProvider, type HarnessLoginFlow, type HarnessLoginProgress } from "@dispatch/shared";
import { CODEX_PROVIDER } from "@dispatch/plugin-codex/descriptor";
import { HarnessRegistry } from "../harness/index.js";
import type { Harness } from "../harness/types.js";
import { AccountLoginError, AccountLogins } from "./account-login.js";
import type { ProviderLogins } from "./provider-logins.js";

registerProvider(CODEX_PROVIDER);

/** A sign-in the test drives by hand. */
function scripted() {
  const listeners = new Set<(p: HarnessLoginProgress) => void>();
  let settle!: (r: { ok: boolean; error?: string }) => void;
  const codes: string[] = [];
  let cancelled = false;
  const flow: HarnessLoginFlow = {
    onProgress: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    submitCode: (c) => codes.push(c),
    cancel: () => {
      cancelled = true;
      settle({ ok: false });
    },
    done: new Promise((r) => (settle = r)),
  };
  return {
    flow,
    codes,
    cancelled: () => cancelled,
    show: (p: HarnessLoginProgress) => listeners.forEach((cb) => cb(p)),
    finish: (r: { ok: boolean; error?: string }) => settle(r),
  };
}

function setup(opts: { withLogin?: boolean } = {}) {
  const started: { exe: string; env: Record<string, string | undefined>; s: ReturnType<typeof scripted> }[] = [];
  const harness = {
    kind: "codex",
    capabilities: {} as Harness["capabilities"],
    runtime: () => ({ kind: "codex", source: "installed", available: true, path: "/bin/codex" }),
    listModels: async () => [],
    ...(opts.withLogin === false
      ? {}
      : {
          startLogin: (exe: string, env: Readonly<Record<string, string | undefined>>) => {
            const s = scripted();
            started.push({ exe, env: { ...env }, s });
            return s.flow;
          },
        }),
  } as unknown as Harness;
  const harnesses = new HarnessRegistry({ providers: [{ harness, descriptor: CODEX_PROVIDER }] });
  const refreshed: (string | undefined)[] = [];
  const logins = {
    refresh: async (_kind: string, account?: { configDir: string }) => {
      refreshed.push(account?.configDir);
      return undefined;
    },
  } as unknown as ProviderLogins;
  const service = new AccountLogins({
    harnesses,
    logins,
    env: {},
    settings: async () => ({
      subscriptions: [{ id: "codex2", name: "Second", provider: "codex", configDir: "/tmp/codex-two" }],
    }),
  });
  return { service, started, refreshed };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("AccountLogins", () => {
  it("starts the provider's flow under the ACCOUNT's env, not the default's", async () => {
    const { service, started } = setup();
    const view = await service.start("codex2");
    expect(view).toMatchObject({ subscriptionId: "codex2", provider: "codex", state: "running" });
    expect(started[0]!.exe).toBe("/bin/codex");
    expect(started[0]!.env.CODEX_HOME).toBe("/tmp/codex-two");
  });

  it("shows progress, relays a code, and re-probes the account when it ends", async () => {
    const { service, started, refreshed } = setup();
    await service.start("codex2");
    const s = started[0]!.s;
    s.show({ url: "https://example/sign-in", awaitingCode: true });
    expect(service.get("codex2")).toMatchObject({ url: "https://example/sign-in", awaitingCode: true });

    service.submitCode("codex2", "abc");
    expect(s.codes).toEqual(["abc"]);

    s.finish({ ok: true });
    await tick();
    await tick();
    const done = service.get("codex2");
    expect(done?.state).toBe("succeeded");
    expect(done?.awaitingCode).toBeUndefined();
    // The banner on this account's chats clears off this probe, not the 15 s re-check.
    expect(refreshed).toEqual(["/tmp/codex-two"]);
  });

  it("a second start cancels the first — two CLIs must not race one directory", async () => {
    const { service, started } = setup();
    await service.start("codex2");
    await service.start("codex2");
    expect(started).toHaveLength(2);
    expect(started[0]!.s.cancelled()).toBe(true);
    expect(service.get("codex2")?.state).toBe("running");
  });

  it("a failure keeps the CLI's reason", async () => {
    const { service, started } = setup();
    await service.start("codex2");
    started[0]!.s.finish({ ok: false, error: "Login failed: That code wasn't accepted." });
    await tick();
    expect(service.get("codex2")).toMatchObject({
      state: "failed",
      error: "Login failed: That code wasn't accepted.",
    });
  });

  it("refuses an unknown account, and a provider with no sign-in", async () => {
    await expect(setup().service.start("nope")).rejects.toMatchObject({ status: 404 });
    const none = setup({ withLogin: false });
    expect(none.service.supports("codex")).toBe(false);
    await expect(none.service.start("codex2")).rejects.toBeInstanceOf(AccountLoginError);
  });

  it("refuses a code when nothing is running", () => {
    expect(() => setup().service.submitCode("codex2", "abc")).toThrow(AccountLoginError);
  });
});
