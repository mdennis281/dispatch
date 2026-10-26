import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveWorkflow,
  type ResolvedWorkflow,
  type WorkflowExemption,
  type WorkflowExemptionScope,
  type WorkflowViolation,
} from "@dispatch/shared";
import {
  buildWorkflowDirective,
  createWorkflowGuard,
  findGitDir,
  inspectCallSite,
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
    expect(await inspectCallSite(worktree)).toEqual({ branch: "feat/x", linked: true });
  });

  it("walks up from a subdirectory", async () => {
    const sub = join(repo, "nested", "deep");
    await mkdir(sub, { recursive: true });
    expect(await readCurrentBranch(sub)).toBe("main");
  });

  it("returns nothing outside a repo", async () => {
    expect(await inspectCwd(root)).toEqual({ branch: null, linked: false });
    expect(await inspectCwd(undefined)).toEqual({ branch: null, linked: false });
    // Distinguishable from a detached primary checkout, so the guard can fall
    // back to what the session knew instead of reading "no branch" as safe.
    expect(await inspectCallSite(root)).toBeNull();
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
    expect(out).toContain("mcp__dispatch-github__watch_pr");
    expect(out).toContain("Never commit or push to `main`");
    expect(out).toContain("You are in a task worktree on `feat/x`");
  });

  it("names `create_pr` as the ship step once the tool is available", () => {
    // The directive and the guard must agree: the guard refuses `gh pr create`
    // exactly where this sentence exists to point somewhere else.
    const wf = resolveWorkflow({ workflow: { profile: "review", ship: "pnpm ship" } });
    const out = buildWorkflowDirective(wf, { ...ctx, prCreate: true })!;
    expect(out).toContain("mcp__dispatch-github__create_pr");
    expect(out).toMatch(/never `gh pr create` by hand/);
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
    expect(out).not.toContain("mcp__dispatch-github__watch_pr");
  });

  it("tells a review project WITHOUT auto-merge to leave the merge alone", () => {
    const out = buildWorkflowDirective(resolveWorkflow({ workflow: { profile: "review" } }), ctx)!;
    expect(out).not.toContain("approve_pr");
    expect(out).toContain("You don't click merge");
  });

  it("tells a review project WITH auto-merge to land its own PR — unless told not to", () => {
    const wf = resolveWorkflow({ workflow: { profile: "review", autoMerge: "on-green" } });
    const out = buildWorkflowDirective(wf, ctx)!;
    expect(out).toContain("mcp__dispatch-github__approve_pr");
    expect(out).toContain("**Unless the user said otherwise.**");
    // "Let me look first" gets a review card, not a PR link left in the transcript.
    expect(out).toContain("mcp__dispatch-confirm__request_human_review");
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


/** A grant as the broker would have recorded it after the human said yes. */
function grant(
  scope: WorkflowExemptionScope,
  lifetime: WorkflowExemption["lifetime"] = "session",
): WorkflowExemption {
  return { id: `x-${scope}`, scope, lifetime, reason: "create_pr is down", grantedAt: 0, uses: 0 };
}

function guardFor(
  workflow: ResolvedWorkflow,
  inWorktree: boolean,
  seen: WorkflowViolation[] = [],
  exemptions: WorkflowExemption[] = [],
) {
  const used: WorkflowExemption[] = [];
  return {
    seen,
    used,
    hook: createWorkflowGuard({
      context: () => ({ workflow, trunk: "main", inWorktree }),
      onViolation: (v) => seen.push(v),
      exemptions: () => exemptions,
      onExempted: (e) => used.push(e),
    }),
  };
}

/**
 * Run the guard on a Bash call made in `cwd`, and report its verdict in the
 * shape a PreToolUse deny takes — so each assertion reads as "denied, and why".
 */
const run = async (
  hook: ReturnType<typeof createWorkflowGuard>,
  cmd: string,
  cwd: string | undefined,
): Promise<{
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision: string;
    permissionDecisionReason: string;
  };
}> => {
  const reason = await hook("Bash", { command: cmd }, { cwd });
  return reason
    ? {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }
    : {};
};

describe("createWorkflowGuard", () => {
  const review = resolveWorkflow({ workflow: { profile: "review" } });

  it("still denies `gh pr merge` under auto-merge, redirecting to approve_pr", async () => {
    const autoMerge = resolveWorkflow({ workflow: { profile: "review", autoMerge: "on-green" } });
    const { hook } = guardFor(autoMerge, true);
    const out = await run(hook, "gh pr merge 42 --squash", worktree);
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain(
      "mcp__dispatch-github__approve_pr",
    );
  });

  it("denies `gh pr create` on a PR project, redirecting to create_pr", async () => {
    // The gap that let a PR ship with no reviewer requested, no chat link and no
    // watcher armed. `gh pr merge` was guarded; its counterpart was not.
    const { hook, seen } = guardFor(review, true);
    const out = await run(hook, "gh pr create --fill --base main", worktree);
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain(
      "mcp__dispatch-github__create_pr",
    );
    expect(seen.map((v) => v.kind)).toEqual(["pr-create-by-hand"]);
  });

  it("leaves `gh pr create` alone on a rung with no PR loop", async () => {
    // No create_pr to point at — a refusal with no alternative is just a wall.
    const { hook, seen } = guardFor(
      resolveWorkflow({ workflow: { profile: "commit", guard: "deny" } }),
      false,
    );
    expect(await run(hook, "gh pr create --fill", repo)).toEqual({});
    expect(seen).toEqual([]);
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

  it("falls back to what the session knew when the runtime gives no cwd", async () => {
    // goose's permission requests carry no directory. Reading that as "no
    // branch" would wave a trunk commit through as if it were safe.
    const hook = createWorkflowGuard({
      context: () => ({ workflow: review, trunk: "main", inWorktree: false, branch: "main" }),
    });
    expect((await run(hook, "git commit -m 'x'", undefined)).hookSpecificOutput?.permissionDecision).toBe(
      "deny",
    );
    const onTask = createWorkflowGuard({
      context: () => ({ workflow: review, trunk: "main", inWorktree: true, branch: "feat/x" }),
    });
    expect(await run(onTask, "git commit -m 'x'", undefined)).toEqual({});
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
    expect(await hook("Read", { command: "git push origin main" }, { cwd: worktree })).toBeNull();
    expect(await run(hook, "   ", repo)).toEqual({});
  });

  it("tells a blocked agent it can ASK for an exemption, naming the guard it tripped", async () => {
    // The 2026-08-17 incident's agent was stuck between a broken create_pr and
    // this refusal because it had no idea a third option existed. This sentence
    // is the only text it is guaranteed to read at that moment.
    const { hook } = guardFor(review, true);
    const reason = (await run(hook, "gh pr create --fill", worktree)).hookSpecificOutput
      ?.permissionDecisionReason;
    expect(reason).toContain("mcp__dispatch-confirm__request_exemption");
    expect(reason).toContain('guard: "pr-create-by-hand"');
  });

  it("omits the exemption offer when no exemption surface is wired in", async () => {
    const hook = createWorkflowGuard({
      context: () => ({ workflow: review, trunk: "main", inWorktree: true }),
    });
    const reason = (await run(hook, "gh pr create --fill", worktree)).hookSpecificOutput
      ?.permissionDecisionReason;
    expect(reason).not.toContain("request_exemption");
  });
});

describe("createWorkflowGuard — human-approved exemptions", () => {
  const review = resolveWorkflow({ workflow: { profile: "review" } });

  it("lets the exempted command through and reports the grant that did it", async () => {
    const g = grant("pr-create-by-hand");
    const { hook, seen, used } = guardFor(review, true, [], [g]);
    expect(await run(hook, "gh pr create --fill", worktree)).toEqual({});
    expect(used).toEqual([g]);
    // Not ALSO a violation: `onViolation` publishes "Blocked: …", and this
    // command was not blocked. One event per outcome.
    expect(seen).toEqual([]);
  });

  it("is narrow — a grant for one guard does not lift another", async () => {
    const { hook, used } = guardFor(review, true, [], [grant("pr-create-by-hand")]);
    const out = await run(hook, "git push origin main", worktree);
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(used).toEqual([]);
  });

  it("`all` covers every kind", async () => {
    const { hook, used } = guardFor(review, true, [], [grant("all")]);
    expect(await run(hook, "gh pr create --fill", worktree)).toEqual({});
    expect(await run(hook, "git push origin main", worktree)).toEqual({});
    expect(await run(hook, "gh pr merge 3 --squash", worktree)).toEqual({});
    expect(used).toHaveLength(3);
  });

  it("never burns a grant under `warn`, where nothing was going to be blocked", async () => {
    // A one-shot spent on a command that would have run anyway is a grant the
    // human paid for and the agent never got.
    const warn = resolveWorkflow({ workflow: { profile: "review", guard: "warn" } });
    const { hook, seen, used } = guardFor(warn, true, [], [grant("pr-create-by-hand", "once")]);
    expect(await run(hook, "gh pr create --fill", worktree)).toEqual({});
    expect(used).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it("reads the list fresh, so a grant that lands mid-turn applies immediately", async () => {
    // The agent asks the instant it is refused and retries in the SAME turn.
    const live: WorkflowExemption[] = [];
    const hook = createWorkflowGuard({
      context: () => ({ workflow: review, trunk: "main", inWorktree: true }),
      exemptions: () => live,
    });
    expect(
      (await run(hook, "gh pr create --fill", worktree)).hookSpecificOutput?.permissionDecision,
    ).toBe("deny");
    live.push(grant("pr-create-by-hand"));
    expect(await run(hook, "gh pr create --fill", worktree)).toEqual({});
  });
});
