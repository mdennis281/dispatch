import { describe, it, expect } from "vitest";
import type {
  PreToolUseHookSpecificOutput,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createBackgroundShellGuardHook,
  createWorktreeGuardHook,
} from "./shell-guard.js";

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
      "mcp__dispatch-workspace__terminal",
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

describe("worktree guard", () => {
  const wtGuard = (over: { enabled?: boolean; onBlocked?: (c: string) => void } = {}) => {
    const hook = createWorktreeGuardHook({
      enabled: () => over.enabled ?? true,
      onBlocked: over.onBlocked,
    });
    return async (tool: string, input: Record<string, unknown>): Promise<PreOut> =>
      (await hook(pre(tool, input), "t1", {
        signal: new AbortController().signal,
      })) as PreOut;
  };

  it("denies `git worktree add` and names the recording tool", async () => {
    const out = await wtGuard()("Bash", {
      command: "git worktree add -b feat/x ../wt/feat-x origin/main",
    });
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain(
      "mcp__dispatch-workspace__worktree",
    );
  });

  it("denies it through mcp__dispatch-workspace__terminal too — the obvious bypass", async () => {
    const out = await wtGuard()("mcp__dispatch-workspace__terminal", {
      name: "wt",
      command: "cd /repo && git worktree add -b feat/y ../wt/feat-y",
    });
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("denies a package-manager worktree script", async () => {
    const out = await wtGuard()("PowerShell", { command: "pnpm worktree feat/z" });
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("does not fire on a command that merely MENTIONS a worktree path", async () => {
    // The word is in a FILENAME here, not the script being run. This exact shape
    // — running the worktree tests — used to be refused, which blocked anyone
    // working on worktree code from testing the code they were working on.
    for (const command of [
      "npx vitest run packages/server/src/services/worktree-reaper.test.ts",
      "pnpm test -- worktree",
      "npm run build --filter worktree-ui",
      "pnpm exec tsc -p packages/server --noEmit # worktree types",
    ]) {
      expect(await wtGuard()("Bash", { command }), command).toEqual({});
    }
  });

  it("still fires on every package-manager script shape", async () => {
    for (const command of [
      "pnpm worktree feat/z",
      "npm run worktree feat/z",
      "pnpm -C /repo worktree feat/z",
      "cd /repo && pnpm run worktree feat/z",
      "FOO=1 pnpm worktree feat/z",
    ]) {
      const out = await wtGuard()("Bash", { command });
      expect(out.hookSpecificOutput?.permissionDecision, command).toBe("deny");
    }
  });

  it("leaves inspection and teardown alone", async () => {
    expect(await wtGuard()("Bash", { command: "git worktree list" })).toEqual({});
    expect(await wtGuard()("Bash", { command: "git worktree remove ../wt/x" })).toEqual({});
    expect(await wtGuard()("Bash", { command: "git worktree prune" })).toEqual({});
  });

  it("ignores tools that don't run commands", async () => {
    expect(await wtGuard()("Read", { command: "git worktree add -b x ./x" })).toEqual({});
  });

  it("stands down when there is no worktree service to redirect to", async () => {
    const out = await wtGuard({ enabled: false })("Bash", {
      command: "git worktree add -b feat/x ./x",
    });
    expect(out).toEqual({});
  });

  it("reports the blocked command to its caller", async () => {
    const seen: string[] = [];
    await wtGuard({ onBlocked: (c) => seen.push(c) })("Bash", {
      command: "git worktree add -b feat/x ./x",
    });
    expect(seen).toEqual(["git worktree add -b feat/x ./x"]);
  });
});
