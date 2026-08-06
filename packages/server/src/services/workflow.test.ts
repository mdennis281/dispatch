import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkflow, type ResolvedWorkflow, type WorkflowViolation } from "@dispatch/shared";
import type {
  PreToolUseHookInput,
  PreToolUseHookSpecificOutput,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import {
  buildWorkflowDirective,
  createWorkflowGuardHook,
  findGitDir,
  inspectCwd,
  readCurrentBranch,
} from "./workflow.js";

/* ------------------------------------------------ real git repo + worktree fixture */

let root: string;
let repo: string;
let worktree: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execa("git", args, { cwd, reject: false });
  return r.stdout;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cm-workflow-"));
  repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "T");
  await writeFile(join(repo, "a.txt"), "a\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "init");
  worktree = join(root, "wt", "feat-x");
  await git(repo, "worktree", "add", "-b", "feat/x", worktree, "main");
}, 30_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("git dir inspection", () => {
  it("reads the branch + checkout-ness of a primary checkout", async () => {
    expect(await readCurrentBranch(repo)).toBe("main");
    expect(await inspectCwd(repo)).toEqual({ branch: "main", linked: false });
    expect((await findGitDir(repo))?.linked).toBe(false);
  });

  it("recognizes a linked worktree and reads its branch", async () => {
    // `.git` is a FILE here — this is how the guard tells a worktree from the checkout.
    expect(await inspectCwd(worktree)).toEqual({ branch: "feat/x", linked: true });
  });

  it("walks up from a subdirectory", async () => {
    const sub = join(repo, "nested", "deep");
    await mkdir(sub, { recursive: true });
    expect(await readCurrentBranch(sub)).toBe("main");
  });

  it("returns nothing outside a repo", async () => {
    expect(await inspectCwd(root)).toEqual({ branch: null, linked: false });
    expect(await inspectCwd(undefined)).toEqual({ branch: null, linked: false });
  });
});

/* --------------------------------------------------------------- the directive */

const ctx = { defaultBranch: "main", inWorktree: true, branch: "feat/x", github: true, memory: true };

describe("buildWorkflowDirective", () => {
  it("tells a `none` project NOT to branch, PR or self-commit", () => {
    const out = buildWorkflowDirective(resolveWorkflow({ workflow: { profile: "none" } }), {
      ...ctx,
      inWorktree: false,
      branch: "main",
    })!;
    expect(out).toContain("`none`");
    expect(out).toMatch(/Don't.*create branches, worktrees, or pull requests/s);
    expect(out).toMatch(/Don't.*commit on your own initiative/s);
  });

  it("gives a `commit` project a commit obligation but no PRs", () => {
    const out = buildWorkflowDirective(resolveWorkflow({ workflow: { profile: "commit" } }), {
      ...ctx,
      inWorktree: false,
      branch: "main",
    })!;
    expect(out).toContain("`commit`");
    expect(out).toContain("conventional commits");
    expect(out).toMatch(/Don't.*open pull requests/s);
  });

  it("gives a `review` project the full loop, naming its own commands", () => {
    const wf = resolveWorkflow({
      workflow: { profile: "review", worktree: "pnpm worktree", ship: "pnpm ship" },
    });
    const out = buildWorkflowDirective(wf, ctx)!;
    expect(out).toContain("pnpm worktree <type>/<slug>");
    expect(out).toContain("pnpm ship");
    expect(out).toContain("mcp__manager__watch_pr");
    expect(out).toContain("Never commit or push to `main`");
    expect(out).toContain("You are in a task worktree on `feat/x`");
  });

  it("warns a `review` session that is sitting in the primary checkout", () => {
    const out = buildWorkflowDirective(resolveWorkflow({ workflow: { profile: "review" } }), {
      ...ctx,
      inWorktree: false,
      branch: "main",
    })!;
    expect(out).toContain("You are running in the primary checkout");
  });

  it("omits the watch_pr step when GitHub isn't wired up", () => {
    const out = buildWorkflowDirective(resolveWorkflow({ workflow: { profile: "review" } }), {
      ...ctx,
      github: false,
    })!;
    expect(out).not.toContain("mcp__manager__watch_pr");
  });

  it("tells a review project WITHOUT auto-merge to leave the merge alone", () => {
    const out = buildWorkflowDirective(resolveWorkflow({ workflow: { profile: "review" } }), ctx)!;
    expect(out).not.toContain("approve_pr");
    expect(out).toContain("You don't click merge");
  });

  it("tells a review project WITH auto-merge to land its own PR — unless told not to", () => {
    const wf = resolveWorkflow({ workflow: { profile: "review", autoMerge: "on-green" } });
    const out = buildWorkflowDirective(wf, ctx)!;
    expect(out).toContain("mcp__manager__approve_pr");
    expect(out).toContain("**Unless the user said otherwise.**");
    expect(out).toContain("`hold` label");
    // The hand-merge ban stays — approve_pr is the only sanctioned path.
    expect(out).toMatch(/Never merge by hand/);
    expect(out).not.toContain("You don't click merge");
  });

  it("keeps the plain merge rule when auto-merge is on but GitHub isn't wired", () => {
    const wf = resolveWorkflow({ workflow: { profile: "review", autoMerge: "on-green" } });
    const out = buildWorkflowDirective(wf, { ...ctx, github: false })!;
    expect(out).not.toContain("approve_pr");
    expect(out).toContain("You don't click merge");
  });

  it("tells worktree sessions never to hand-edit memory files", () => {
    const out = buildWorkflowDirective(resolveWorkflow({ workflow: { profile: "review" } }), ctx)!;
    expect(out).toContain("never** hand-edit those files");
    expect(out).toContain("your worktree's copy is not the live one");
    expect(out).toContain("don't add them to your PR");
  });

  it("says nothing about memory when the tools aren't available", () => {
    const out = buildWorkflowDirective(resolveWorkflow({ workflow: { profile: "none" } }), {
      ...ctx,
      memory: false,
    })!;
    expect(out).not.toContain("Recording what you learn");
  });

  it("does not reuse the memory injection's own section heading", () => {
    // Two "Project memory" headings in one prompt read as a duplicated section.
    const out = buildWorkflowDirective(resolveWorkflow({ workflow: { profile: "none" } }), ctx)!;
    expect(out).toContain("Recording what you learn");
    expect(out).not.toContain("Project memory");
  });
});

/* ------------------------------------------------------------------- the guard */

function preToolUse(command: string, cwd: string): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "t1",
    session_id: "s1",
    transcript_path: "",
    cwd,
  };
}

function guardFor(workflow: ResolvedWorkflow, inWorktree: boolean, seen: WorkflowViolation[] = []) {
  return {
    seen,
    hook: createWorkflowGuardHook({
      context: () => ({ workflow, trunk: "main", inWorktree }),
      onViolation: (v) => seen.push(v),
    }),
  };
}

/**
 * Run the hook, narrowed to the shape a PreToolUse hook can actually return
 * (`HookJSONOutput` unions in every other hook's output shape).
 */
const run = async (
  hook: ReturnType<typeof createWorkflowGuardHook>,
  cmd: string,
  cwd: string,
): Promise<Omit<SyncHookJSONOutput, "hookSpecificOutput"> & {
  hookSpecificOutput?: PreToolUseHookSpecificOutput;
}> =>
  (await hook(preToolUse(cmd, cwd), "t1", {
    signal: new AbortController().signal,
  })) as Omit<SyncHookJSONOutput, "hookSpecificOutput"> & {
    hookSpecificOutput?: PreToolUseHookSpecificOutput;
  };

describe("createWorkflowGuardHook", () => {
  const review = resolveWorkflow({ workflow: { profile: "review" } });

  it("still denies `gh pr merge` under auto-merge, redirecting to approve_pr", async () => {
    const autoMerge = resolveWorkflow({ workflow: { profile: "review", autoMerge: "on-green" } });
    const { hook } = guardFor(autoMerge, true);
    const out = await run(hook, "gh pr merge 42 --squash", worktree);
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain(
      "mcp__manager__approve_pr",
    );
  });

  it("denies a push to the trunk from a worktree", async () => {
    const { hook, seen } = guardFor(review, true);
    const out = await run(hook, "git push origin main", worktree);
    expect(out.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("`review` workflow profile");
    expect(seen).toHaveLength(1);
  });

  it("denies a commit made in the primary checkout on the trunk", async () => {
    const { hook } = guardFor(review, false);
    const out = await run(hook, "git commit -m 'direct'", repo);
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("allows normal work on a task branch", async () => {
    const { hook, seen } = guardFor(review, true);
    for (const cmd of ["git commit -m 'feat: x'", "git push -u origin feat/x", "pnpm build"]) {
      expect(await run(hook, cmd, worktree)).toEqual({});
    }
    expect(seen).toEqual([]);
  });

  it("reads the branch fresh from the hook's cwd, not from turn start", async () => {
    // Same guard object, two cwds: the worktree commit is fine, the checkout one isn't.
    const { hook } = guardFor(review, true);
    expect(await run(hook, "git commit -m 'x'", worktree)).toEqual({});
    expect((await run(hook, "git commit -m 'x'", repo)).hookSpecificOutput?.permissionDecision).toBe(
      "deny",
    );
  });

  it("warns without blocking when guard is `warn`", async () => {
    const warn = resolveWorkflow({ workflow: { profile: "review", guard: "warn" } });
    const { hook, seen } = guardFor(warn, true);
    expect(await run(hook, "git push origin main", worktree)).toEqual({});
    expect(seen).toHaveLength(1);
  });

  it("does nothing at all when guard is `off` (the `none`/`commit` rungs)", async () => {
    const { hook, seen } = guardFor(resolveWorkflow({ workflow: { profile: "commit" } }), false);
    expect(await run(hook, "git push origin main", repo)).toEqual({});
    expect(seen).toEqual([]);
  });

  it("ignores non-Bash tools and empty commands", async () => {
    const { hook } = guardFor(review, true);
    const readInput = { ...preToolUse("", worktree), tool_name: "Read" };
    expect(await hook(readInput, "t1", { signal: new AbortController().signal })).toEqual({});
    expect(await run(hook, "   ", repo)).toEqual({});
  });
});
