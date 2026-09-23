import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountOf,
  chatSubscription,
  defaultConfigDir,
  subscriptionStatuses,
  transferClaudeSession,
} from "./subscriptions.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "dispatch-subs-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("accountOf", () => {
  it("overlays no env for the provider's default dir, and the var for any other", () => {
    const machine = { env: {}, home };
    expect(accountOf({ id: "claude1", name: "one", provider: "claude" }, machine)).toEqual({
      subscriptionId: "claude1",
      configDir: join(home, ".claude"),
      env: {},
    });
    const second = accountOf(
      { id: "claude2", name: "two", provider: "claude", configDir: join(home, ".claude2") },
      machine,
    );
    expect(second.env).toEqual({ CLAUDE_CONFIG_DIR: join(home, ".claude2") });
  });

  it("treats the server's own env var as the default dir", () => {
    const machine = { env: { CODEX_HOME: join(home, "elsewhere") }, home };
    expect(defaultConfigDir("codex", machine)).toBe(join(home, "elsewhere"));
    const explicit = accountOf(
      { id: "c", name: "c", provider: "codex", configDir: join(home, "elsewhere") },
      machine,
    );
    expect(explicit.env).toEqual({});
  });

  it("carries a goose account's Ollama host as OLLAMA_HOST", () => {
    // What distinguishes two goose accounts is the MACHINE serving the models,
    // not a login directory — goose has no login to put in one.
    const account = accountOf(
      { id: "gpu", name: "3090 box", provider: "goose", host: "192.0.2.10:11434" },
      { env: {}, home },
    );
    // Stored as Ollama's own bare `host:port` spelling, handed over as an origin.
    expect(account.env.OLLAMA_HOST).toBe("http://192.0.2.10:11434");
  });

  it("overlays a goose host even when it equals the default, unlike a config dir", () => {
    // Not the same case as a dir that happens to match: a dir equal to the
    // default was never chosen, a host equal to it was. Falling back would let
    // the server's ambient OLLAMA_HOST override a deliberate choice.
    const account = accountOf(
      { id: "local", name: "this box", provider: "goose", host: "http://127.0.0.1:11434" },
      { env: { OLLAMA_HOST: "http://192.0.2.10:11434" }, home },
    );
    expect(account.env.OLLAMA_HOST).toBe("http://127.0.0.1:11434");
  });

  it("leaves a goose account with no host alone, so it inherits the server's", () => {
    const account = accountOf({ id: "g", name: "g", provider: "goose" }, { env: {}, home });
    expect(account.env.OLLAMA_HOST).toBeUndefined();
  });

  it("ignores a host on a provider that has no endpoint", () => {
    // `host` is meaningless for a hosted provider; it must not leak into the env.
    const account = accountOf(
      { id: "claude1", name: "one", provider: "claude", host: "192.0.2.10:11434" },
      { env: {}, home },
    );
    expect(account.env.OLLAMA_HOST).toBeUndefined();
  });
});

describe("chatSubscription", () => {
  const settings = () => ({
    subscriptions: [
      { id: "claude2", name: "two", provider: "claude" as const, configDir: join(home, ".claude2") },
      { id: "claude1", name: "one", provider: "claude" as const, configDir: join(home, ".claude") },
    ],
  });

  it("honours the chosen default for goose, where every account shares one directory", () => {
    // Two goose accounts, neither with a configDir — the pane does not offer
    // one, because GOOSE_CONFIG_DIR is inert. So both resolve to the SAME
    // default path, and the directory rule would always take the first in the
    // list, silently outranking the default set under Chat. An unpinned chat
    // would then run against loopback instead of the GPU box.
    const settings = {
      subscriptions: [
        { id: "goose1", name: "this box", provider: "goose" as const },
        { id: "goose2", name: "3090 box", provider: "goose" as const, host: "192.0.2.10:11434" },
      ],
      harness: { defaults: { goose: { subscriptionId: "goose2" } } },
    };
    const sub = chatSubscription(settings, { harness: "goose" }, { env: {}, home });
    expect(sub.id).toBe("goose2");
    expect(accountOf(sub, { env: {}, home }).env.OLLAMA_HOST).toBe("http://192.0.2.10:11434");
  });

  it("keeps an unpinned legacy chat on the default DIRECTORY, not the default account", () => {
    // claude2 is listed first, so it is the provider default — but every session
    // an unpinned chat has was written under ~/.claude.
    const sub = chatSubscription(settings(), { harness: "claude" }, { env: {}, home });
    expect(sub.id).toBe("claude1");
  });

  it("sends a pin that no longer resolves back to the default DIRECTORY", () => {
    // Pinned `claude` (an implicit id) before a list existed; the saved list
    // dropped that id. The session is in ~/.claude, so that is where it runs.
    const sub = chatSubscription(
      settings(),
      { harness: "claude", subscriptionId: "claude" },
      { env: {}, home },
    );
    expect(sub.id).toBe("claude1");
  });

  it("honours a pin", () => {
    const sub = chatSubscription(
      settings(),
      { harness: "claude", subscriptionId: "claude2" },
      { env: {}, home },
    );
    expect(sub.id).toBe("claude2");
  });
});

describe("subscriptionStatuses", () => {
  it("reports login presence from the login file's existence alone", async () => {
    await mkdir(join(home, ".claude2"), { recursive: true });
    await writeFile(join(home, ".claude2", ".credentials.json"), "{}");
    const statuses = subscriptionStatuses(
      {
        subscriptions: [
          { id: "claude2", name: "two", provider: "claude", configDir: join(home, ".claude2") },
          { id: "nope", name: "nope", provider: "claude", configDir: join(home, "missing") },
        ],
      },
      { env: {}, home },
    );
    expect(statuses.find((s) => s.id === "claude2")).toMatchObject({
      dirExists: true,
      loggedIn: true,
      isDefault: true,
    });
    expect(statuses.find((s) => s.id === "nope")).toMatchObject({
      dirExists: false,
      loggedIn: false,
    });
  });
});

describe("transferClaudeSession", () => {
  const id = "0b7e3d1c-2f7a-4d8e-9c1a-5b6f7e8d9a0b";

  async function seed(dir: string, body: string) {
    const slug = join(dir, "projects", "C--repo");
    await mkdir(join(slug, id, "subagents"), { recursive: true });
    await writeFile(join(slug, `${id}.jsonl`), body);
    await writeFile(join(slug, id, "subagents", "a.jsonl"), "sub");
  }

  it("copies the session and its subagent sidecar into the same slug dir", async () => {
    const from = join(home, ".claude");
    const to = join(home, ".claude2");
    await seed(from, "from");
    expect(await transferClaudeSession(id, from, to)).toBe(true);
    expect(await readFile(join(to, "projects", "C--repo", `${id}.jsonl`), "utf8")).toBe("from");
    expect(existsSync(join(to, "projects", "C--repo", id, "subagents", "a.jsonl"))).toBe(true);
  });

  it("replaces a stale copy when switching BACK to an account the chat left", async () => {
    // The source is where the chat last ran, so it holds the newest turns; the
    // target's leftover copy predates them.
    const from = join(home, ".claude2");
    const to = join(home, ".claude");
    await seed(to, "stale, from before the switch");
    await seed(from, "with the turns taken since");
    expect(await transferClaudeSession(id, from, to)).toBe(true);
    expect(await readFile(join(to, "projects", "C--repo", `${id}.jsonl`), "utf8")).toBe(
      "with the turns taken since",
    );
  });

  it("reports false when there is nothing to carry", async () => {
    expect(await transferClaudeSession(id, join(home, ".claude"), join(home, "x"))).toBe(false);
    expect(await transferClaudeSession("../escape", home, join(home, "x"))).toBe(false);
  });
});
