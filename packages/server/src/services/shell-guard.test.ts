import { describe, it, expect } from "vitest";
import type { HarnessToolGuard } from "@dispatch/shared";
import {
  createBackgroundShellGuard,
  createWorktreeGuard,
  createModePolicyGuard,
  createIssueCreateGuard,
  looksLikeGhIssueCreate,
  ghIssueCreateRepo,
} from "./shell-guard.js";

/**
 * A guard's verdict in the shape a PreToolUse deny takes. The guards are plain
 * functions now; this keeps every assertion below reading as "was it denied,
 * and with what reason", whichever runtime ends up carrying the refusal.
 */
interface PreOut {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}

/** Run one guard on one call, as an adapter would. */
async function verdict(
  guard: HarnessToolGuard,
  tool: string,
  input: Record<string, unknown>,
): Promise<PreOut> {
  const reason = await guard(tool, input, { cwd: "C:\\repo" });
  return reason
    ? { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: reason } }
    : {};
}

const guard = (over: { enabled?: boolean; onBlocked?: (c: string) => void } = {}) => {
  const hook = createBackgroundShellGuard({
    enabled: () => over.enabled ?? true,
    onBlocked: over.onBlocked,
  });
  return async (tool: string, input: Record<string, unknown>): Promise<PreOut> =>
    verdict(hook, tool, input);
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
    const hook = createWorktreeGuard({
      enabled: () => over.enabled ?? true,
      onBlocked: over.onBlocked,
    });
    return async (tool: string, input: Record<string, unknown>): Promise<PreOut> =>
      verdict(hook, tool, input);
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

describe("issue create guard", () => {
  const issueGuard = (enabled = true, own = "acme/api") => {
    const hook = createIssueCreateGuard({ applies: async (repo) => enabled && (!repo || repo === own) });
    return async (tool: string, input: Record<string, unknown>): Promise<PreOut> =>
      verdict(hook, tool, input);
  };

  it("recognises gh issue create in the shapes agents actually write", () => {
    expect(looksLikeGhIssueCreate('gh issue create --title "x" --body-file b.md')).toBe(true);
    expect(looksLikeGhIssueCreate("cd /repo && gh -R acme/api issue create -t x -b y")).toBe(true);
    expect(looksLikeGhIssueCreate("for n in 1 2; do gh.exe issue new --title $n; done")).toBe(true);
    expect(looksLikeGhIssueCreate("gh issue list --label bug")).toBe(false);
    expect(looksLikeGhIssueCreate("gh issue edit 5 --add-label dispatch:manual")).toBe(false);
    expect(looksLikeGhIssueCreate("pnpm test -- gh-issue-create.test.ts")).toBe(false);
  });

  it("denies it on a watched project and names issue_create", async () => {
    const out = await issueGuard()("Bash", { command: 'gh issue create --title "x"' });
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("issue_create");
  });

  it("reads the -R target off the gh invocation only", () => {
    expect(ghIssueCreateRepo('gh issue create -t x')).toBeNull();
    expect(ghIssueCreateRepo('gh -R Acme/API issue create -t x')).toBe("acme/api");
    expect(ghIssueCreateRepo('gh issue create --repo=github.com/up/lib.git -t x')).toBe("up/lib");
    expect(ghIssueCreateRepo('gh issue create -t x && gh pr list -R other/repo')).toBeNull();
  });

  it("lets an upstream report through — the watcher never sees it and issue_create can't file it there", async () => {
    const out = await issueGuard()("Bash", { command: 'gh issue create -R upstream/lib --title "bug"' });
    expect(out.hookSpecificOutput).toBeUndefined();
    const own = await issueGuard()("Bash", { command: 'gh issue create -R acme/api --title "bug"' });
    expect(own.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("lets it through where no watcher would take the issue", async () => {
    const out = await issueGuard(false)("PowerShell", { command: 'gh issue create --title "x"' });
    expect(out.hookSpecificOutput).toBeUndefined();
  });
});

/**
 * The mode tool policy — the only unconditional veto there is, on every
 * provider. The SDK's own `disallowedTools` is advisory and does not filter
 * MCP tools, so this is what actually holds a posture.
 */
describe("mode tool policy guard", () => {
  const policyGuard = (
    policy: { allowedTools?: string[]; disallowedTools?: string[] },
    mode = { name: "Global", id: "global" },
  ) => {
    const hook = createModePolicyGuard({ policy: () => policy, mode: () => mode });
    return async (tool: string): Promise<PreOut> =>
      verdict(hook, tool, {});
  };

  it("denies an MCP tool on the denylist — the case the SDK option does not cover", async () => {
    const out = await policyGuard({
      disallowedTools: ["mcp__dispatch-workspace__worktree"],
    })("mcp__dispatch-workspace__worktree");
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("Global mode");
    // The global posture redirects rather than merely refusing.
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("spawn_chat");
  });

  it("allows anything the policy does not name", async () => {
    const out = await policyGuard({ disallowedTools: ["Bash"] })("Read");
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it("enforces an allowlist, including the empty one that permits nothing", async () => {
    expect(
      (await policyGuard({ allowedTools: ["Read"] })("Write")).hookSpecificOutput
        ?.permissionDecision,
    ).toBe("deny");
    expect((await policyGuard({ allowedTools: ["Read"] })("Read")).hookSpecificOutput).toBeUndefined();
    expect(
      (await policyGuard({ allowedTools: [] })("Read")).hookSpecificOutput?.permissionDecision,
    ).toBe("deny");
  });

  it("keeps the refusal honest for an ordinary mode", async () => {
    const out = await policyGuard({ disallowedTools: ["WebFetch"] }, {
      name: "Audit",
      id: "audit",
    })("WebFetch");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("Audit mode");
    expect(out.hookSpecificOutput?.permissionDecisionReason).not.toContain("spawn_chat");
  });

  it("is a no-op when the mode has no policy at all", async () => {
    expect((await policyGuard({})("Bash")).hookSpecificOutput).toBeUndefined();
  });
});
