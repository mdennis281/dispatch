import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loginFailureText, parseClaudeLoginOutput, startClaudeLogin } from "./login-flow.js";

/** What `claude auth login` printed with no TTY (Claude Code 2.x, Windows). */
const PRINTED = [
  "Opening browser to sign in…",
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y",
  "Paste code here if prompted > ",
].join("\n");

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: string[] = [];
  const stdin = new PassThrough();
  stdin.on("data", (b: Buffer) => written.push(String(b)));
  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    kill: () => {
      child.emit("close", null);
      return true;
    },
  });
  return { child: child as ChildProcess, stdout, written, exit: (code: number) => child.emit("close", code) };
}

describe("parseClaudeLoginOutput", () => {
  it("finds the manual URL and the paste prompt", () => {
    expect(parseClaudeLoginOutput(PRINTED)).toEqual({
      url: "https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y",
      awaitingCode: true,
    });
  });

  it("reports nothing before the CLI has printed anything", () => {
    expect(parseClaudeLoginOutput("Opening browser to sign in…")).toEqual({});
  });

  it("ignores colour codes around the URL", () => {
    const p = parseClaudeLoginOutput("visit: \x1b[4mhttps://claude.com/cai/oauth/authorize?a=1\x1b[24m\n");
    expect(p.url).toBe("https://claude.com/cai/oauth/authorize?a=1");
  });
});

describe("loginFailureText", () => {
  it("keeps the verdict that shares a line with the prompt", () => {
    // Measured: the prompt has no newline, so the failure follows it directly.
    const out = `${PRINTED}Login failed: That code wasn't accepted.\n`;
    expect(loginFailureText(out)).toBe("Login failed: That code wasn't accepted.");
  });
});

describe("startClaudeLogin", () => {
  it("runs `auth login` under the given env, relays a code, and succeeds on exit 0", async () => {
    const fake = fakeChild();
    let ran: { args: string[]; env: Record<string, string | undefined> } | undefined;
    const flow = startClaudeLogin("claude", { CLAUDE_CONFIG_DIR: "/acct" }, (_exe, args, env) => {
      ran = { args, env: { ...env } };
      return fake.child;
    });
    const seen: unknown[] = [];
    flow.onProgress((p) => seen.push(p));
    fake.stdout.write(PRINTED);
    await new Promise((r) => setImmediate(r));
    expect(ran).toEqual({ args: ["auth", "login"], env: { CLAUDE_CONFIG_DIR: "/acct" } });
    expect(seen.at(-1)).toMatchObject({ awaitingCode: true });

    flow.submitCode?.("  abc#def \n");
    await new Promise((r) => setImmediate(r));
    expect(fake.written).toEqual(["abc#def\n"]);

    fake.exit(0);
    expect(await flow.done).toEqual({ ok: true });
  });

  it("fails with the CLI's reason on a non-zero exit", async () => {
    const fake = fakeChild();
    const flow = startClaudeLogin("claude", {}, () => fake.child);
    fake.stdout.write(`${PRINTED}Login failed: That code wasn't accepted.\n`);
    await new Promise((r) => setImmediate(r));
    fake.exit(1);
    expect(await flow.done).toEqual({ ok: false, error: "Login failed: That code wasn't accepted." });
  });

  it("cancel kills the CLI and never reports success", async () => {
    const fake = fakeChild();
    const flow = startClaudeLogin("claude", {}, () => fake.child);
    flow.cancel();
    expect(await flow.done).toMatchObject({ ok: false });
  });

  it("a spawn that throws settles as a failure, not a rejection", async () => {
    const flow = startClaudeLogin("claude", {}, () => {
      throw new Error("EINVAL");
    });
    expect(await flow.done).toEqual({ ok: false, error: "EINVAL" });
  });
});
