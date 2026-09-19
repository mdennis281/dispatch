import { describe, expect, it } from "vitest";
import type { Harness } from "../harness/types.js";
import {
  probeClaudeLogin,
  probeCodexLogin,
  probeRuntimeLogins,
  type RunProbe,
} from "./runtime-login.js";

/**
 * The runtime step used to read `available` alone, which for Claude is always
 * true. Every case here is about the second fact — logged in — and about the
 * probe never turning a machine's honest answer into a thrown error.
 */

function ran(over: Partial<Awaited<ReturnType<RunProbe>>>): RunProbe {
  return async () => ({ code: 0, stdout: "", stderr: "", ...over });
}

describe("probeClaudeLogin", () => {
  it("reads the method, plan and account out of `claude auth status`", async () => {
    const run = ran({
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        email: "ada@example.com",
        subscriptionType: "max",
      }),
    });
    expect(await probeClaudeLogin("/x/claude", {}, run)).toEqual({
      checked: true,
      loggedIn: true,
      method: "claude.ai",
      subscription: "max",
      account: "ada@example.com",
    });
  });

  it("treats a logged-out exit 1 as an ANSWER, not a probe failure", async () => {
    // `auth status` exits 1 when logged out but still prints the JSON.
    const run = ran({ code: 1, stdout: '{"loggedIn": false, "authMethod": "none"}\n' });
    const status = await probeClaudeLogin("/x/claude", {}, run);
    expect(status.checked).toBe(true);
    expect(status.loggedIn).toBe(false);
    expect(status.error).toContain("/login");
    expect(status.method).toBeUndefined();
  });

  it("reports an unrunnable binary as unchecked", async () => {
    const run = ran({ code: null, spawnError: "spawn /x/claude ENOENT" });
    expect(await probeClaudeLogin("/x/claude", {}, run)).toEqual({
      checked: false,
      loggedIn: false,
      error: "spawn /x/claude ENOENT",
    });
  });

  it("reports a runtime too old to know `auth status` as unchecked, with its complaint", async () => {
    const run = ran({ code: 1, stderr: "error: unknown command 'auth'" });
    const status = await probeClaudeLogin("/x/claude", {}, run);
    expect(status.checked).toBe(false);
    expect(status.error).toContain("unknown command");
  });

  it("passes the account env through to the spawn", async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const run: RunProbe = async (_exe, _args, env) => {
      seen = env;
      return { code: 0, stdout: '{"loggedIn": true}', stderr: "" };
    };
    await probeClaudeLogin("/x/claude", { CLAUDE_CONFIG_DIR: "/home/ada/.claude-work" }, run);
    expect(seen?.CLAUDE_CONFIG_DIR).toBe("/home/ada/.claude-work");
  });
});

describe("probeCodexLogin", () => {
  it("exit 0 is logged in, with the method scraped from the prose", async () => {
    const run = ran({ stdout: "Logged in using ChatGPT\n" });
    expect(await probeCodexLogin("/x/codex", {}, run)).toEqual({
      checked: true,
      loggedIn: true,
      method: "ChatGPT",
    });
  });

  it("non-zero is logged out, and the fix is named", async () => {
    const run = ran({ code: 1, stderr: "Not logged in\n" });
    const status = await probeCodexLogin("/x/codex", {}, run);
    expect(status).toMatchObject({ checked: true, loggedIn: false });
    expect(status.error).toContain("codex login");
  });
});

describe("probeRuntimeLogins", () => {
  const harness = (kind: "claude" | "codex", runtime: Partial<ReturnType<Harness["runtime"]>>) =>
    ({ kind, runtime: () => ({ kind, source: "installed", available: true, ...runtime }) }) as unknown as Harness;

  it("probes the bundled Claude binary when nothing newer is installed", async () => {
    const asked: string[] = [];
    const run: RunProbe = async (exe) => {
      asked.push(exe);
      return { code: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}', stderr: "" };
    };
    const [status] = await probeRuntimeLogins(
      [harness("claude", { source: "bundled", version: "2.1.222" })],
      null,
      { run, bundled: () => "/sdk/claude-agent-sdk-linux-x64/claude", env: {} },
    );
    expect(asked).toEqual(["/sdk/claude-agent-sdk-linux-x64/claude"]);
    expect(status).toMatchObject({
      kind: "claude",
      available: true,
      source: "bundled",
      version: "2.1.222",
      path: "/sdk/claude-agent-sdk-linux-x64/claude",
      login: { checked: true, loggedIn: true, method: "claude.ai" },
    });
  });

  it("downgrades `available` when the bundled platform binary is missing", async () => {
    // `available: true` with nothing to spawn is the SDK's optional platform
    // package being absent — a chat would fail exactly the same way.
    const [status] = await probeRuntimeLogins(
      [harness("claude", { source: "bundled" })],
      null,
      { run: ran({}), bundled: () => undefined, env: {} },
    );
    expect(status.available).toBe(false);
    expect(status.source).toBe("missing");
    expect(status.login.checked).toBe(false);
  });

  it("does not probe a runtime that is not installed", async () => {
    let calls = 0;
    const run: RunProbe = async () => {
      calls++;
      return { code: 0, stdout: "", stderr: "" };
    };
    const [status] = await probeRuntimeLogins(
      [harness("codex", { source: "missing", available: false })],
      null,
      { run, bundled: () => undefined, env: {} },
    );
    expect(calls).toBe(0);
    expect(status).toMatchObject({ kind: "codex", available: false, login: { checked: false, loggedIn: false } });
  });

  it("probes under the default account's config dir when one is configured", async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const run: RunProbe = async (_exe, _args, env) => {
      seen = env;
      return { code: 0, stdout: '{"loggedIn": true}', stderr: "" };
    };
    await probeRuntimeLogins(
      [harness("claude", { path: "/usr/local/bin/claude" })],
      {
        subscriptions: [{ id: "work", name: "Work", provider: "claude", configDir: "/home/ada/.claude-work" }],
        harness: { defaults: { claude: { subscriptionId: "work" } } },
      },
      { run, bundled: () => undefined, env: {} },
    );
    expect(seen?.CLAUDE_CONFIG_DIR).toMatch(/\.claude-work$/);
  });
});
