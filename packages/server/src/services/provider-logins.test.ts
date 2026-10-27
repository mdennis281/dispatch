import { describe, expect, it } from "vitest";
import { registerProvider, type RuntimeLoginStatus } from "@dispatch/shared";
import { CODEX_PROVIDER } from "@dispatch/plugin-codex/descriptor";
import { HarnessRegistry } from "../harness/index.js";
import type { Harness } from "../harness/types.js";
import { ProviderLogins } from "./provider-logins.js";

registerProvider(CODEX_PROVIDER);

/** A Codex that counts its login probes and answers whatever `state.login` says. */
function codex(state: { login: RuntimeLoginStatus; probes: string[] }): Harness {
  return {
    kind: "codex",
    capabilities: {} as Harness["capabilities"],
    runtime: () => ({ kind: "codex", source: "installed", available: true, path: process.execPath }),
    listModels: async () => [],
    probeLogin: async (_exe: string, env: Readonly<Record<string, string | undefined>>) => {
      state.probes.push(env.CODEX_HOME ?? "default");
      return state.login;
    },
  } as unknown as Harness;
}

function setup(login: RuntimeLoginStatus = { checked: true, loggedIn: false }) {
  const state = { login, probes: [] as string[] };
  const harnesses = new HarnessRegistry({ providers: [{ harness: codex(state), descriptor: CODEX_PROVIDER }] });
  const changed: string[] = [];
  let now = 0;
  const logins = new ProviderLogins({
    harnesses,
    settings: async () => ({
      subscriptions: [
        { id: "codex1", name: "Main", provider: "codex" },
        { id: "codex2", name: "Second", provider: "codex", configDir: "/tmp/codex-two" },
      ],
    }),
    onChange: (kind) => changed.push(kind),
    now: () => now,
    ttlMs: 1000,
  });
  return { state, harnesses, logins, changed, tick: (ms: number) => (now += ms) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("ProviderLogins", () => {
  it("never waits on a probe: an unknown login is undefined, and learnt in the background", async () => {
    const { logins, state } = setup();
    expect(logins.peek("codex")).toBeUndefined();
    await settle();
    await settle();
    expect(state.probes).toEqual(["default"]);
    expect(logins.peek("codex")).toMatchObject({ checked: true, loggedIn: false });
  });

  it("probes once per TTL, not once per send", async () => {
    const { logins, state, tick } = setup();
    await logins.refresh("codex");
    for (let i = 0; i < 5; i++) logins.peek("codex");
    await settle();
    expect(state.probes).toHaveLength(1);
    tick(1001);
    logins.peek("codex");
    await settle();
    await settle();
    expect(state.probes).toHaveLength(2);
  });

  it("judges each account by its own directory", async () => {
    const { logins, state } = setup();
    await logins.refresh("codex");
    state.login = { checked: true, loggedIn: true };
    const second = { subscriptionId: "codex2", configDir: "/tmp/codex-two", env: { CODEX_HOME: "/tmp/codex-two" } };
    await logins.refresh("codex", second);
    expect(state.probes).toEqual(["default", "/tmp/codex-two"]);
    expect(logins.peek("codex")).toMatchObject({ loggedIn: false });
    expect(logins.peek("codex", second)).toMatchObject({ loggedIn: true });
  });

  it("announces only a flip in whether a chat may run", async () => {
    const { logins, state, changed } = setup({ checked: true, loggedIn: true });
    await logins.refresh("codex");
    expect(changed).toEqual([]);
    state.login = { checked: true, loggedIn: false };
    await logins.refresh("codex");
    expect(changed).toEqual(["codex"]);
    // A probe that could not run is not news: it never refuses a turn either.
    state.login = { checked: false, loggedIn: false, error: "timed out" };
    await logins.refresh("codex");
    expect(changed).toEqual(["codex", "codex"]);
    await logins.refresh("codex");
    expect(changed).toEqual(["codex", "codex"]);
  });

  it("takes the setup card's answer at once, so Re-check clears the banner", async () => {
    const { logins, changed } = setup();
    await logins.refresh("codex");
    await logins.recordDefault("codex", { checked: true, loggedIn: true });
    expect(logins.peek("codex")).toMatchObject({ loggedIn: true });
    expect(changed).toEqual(["codex", "codex"]);
  });

  it("probes nothing for a provider that is not registered", async () => {
    const { logins, state } = setup();
    expect(await logins.refresh("claude")).toBeUndefined();
    logins.peek("claude");
    await settle();
    expect(state.probes).toEqual([]);
  });

  it("forgets a provider whose plugin went away", async () => {
    const { logins } = setup();
    await logins.refresh("codex");
    logins.forget("codex");
    expect(logins.peek("codex")).toBeUndefined();
  });
});
