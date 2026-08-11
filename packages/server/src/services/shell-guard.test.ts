import { describe, it, expect } from "vitest";
import type {
  PreToolUseHookSpecificOutput,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { createBackgroundShellGuardHook } from "./shell-guard.js";

/** A PreToolUse hook's real return shape (`HookJSONOutput` unions them all). */
type PreOut = Omit<SyncHookJSONOutput, "hookSpecificOutput"> & {
  hookSpecificOutput?: PreToolUseHookSpecificOutput;
};

/** A PreToolUse hook input, with only the fields the guard reads. */
function pre(tool: string, input: Record<string, unknown>) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: input,
    cwd: "C:\\repo",
    session_id: "s1",
    transcript_path: "",
    permission_mode: "bypassPermissions",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const guard = (over: { enabled?: boolean; onBlocked?: (c: string) => void } = {}) => {
  const hook = createBackgroundShellGuardHook({
    enabled: () => over.enabled ?? true,
    onBlocked: over.onBlocked,
  });
  return async (tool: string, input: Record<string, unknown>): Promise<PreOut> =>
    (await hook(pre(tool, input), "t1", {
      signal: new AbortController().signal,
    })) as PreOut;
};

describe("background shell guard", () => {
  it("denies Bash run_in_background and names the tracked replacement", async () => {
    const out = await guard()("Bash", { command: "npm run dev", run_in_background: true });
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain(
      "mcp__manager__terminal",
    );
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("background: true");
  });

  it("denies PowerShell too — the same flag, the same orphan", async () => {
    const out = await guard()("PowerShell", {
      command: "node vite.js --port 47820",
      run_in_background: true,
    });
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("allows a foreground shell command", async () => {
    expect(await guard()("Bash", { command: "npm test" })).toEqual({});
  });

  it("allows run_in_background: false", async () => {
    expect(
      await guard()("Bash", { command: "npm test", run_in_background: false }),
    ).toEqual({});
  });

  it("ignores non-shell tools", async () => {
    expect(await guard()("Read", { run_in_background: true })).toEqual({});
  });

  it("stands down when there is no TerminalService to redirect to", async () => {
    const out = await guard({ enabled: false })("Bash", {
      command: "npm run dev",
      run_in_background: true,
    });
    expect(out).toEqual({});
  });

  it("reports the blocked command to its caller", async () => {
    const seen: string[] = [];
    await guard({ onBlocked: (c) => seen.push(c) })("Bash", {
      command: "npm run dev",
      run_in_background: true,
    });
    expect(seen).toEqual(["npm run dev"]);
  });
});
