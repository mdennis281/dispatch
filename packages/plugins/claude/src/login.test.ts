import { describe, expect, it } from "vitest";
import { probeClaudeLogin, type RunLoginProbe } from "./login.js";

/**
 * The runtime step used to read `available` alone, which for Claude is always
 * true. Every case here is about the second fact — logged in — and about the
 * probe never turning a machine's honest answer into a thrown error.
 */

function ran(over: Partial<Awaited<ReturnType<RunLoginProbe>>>): RunLoginProbe {
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
    let seen: Readonly<Record<string, string | undefined>> | undefined;
    const run: RunLoginProbe = async (_exe, _args, env) => {
      seen = env;
      return { code: 0, stdout: '{"loggedIn": true}', stderr: "" };
    };
    await probeClaudeLogin("/x/claude", { CLAUDE_CONFIG_DIR: "/home/ada/.claude-work" }, run);
    expect(seen?.CLAUDE_CONFIG_DIR).toBe("/home/ada/.claude-work");
  });
});
