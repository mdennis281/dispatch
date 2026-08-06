import { describe, it, expect } from "vitest";
import { resolveWorkflow, classifyWorkflowViolation } from "./workflow.js";

describe("resolveWorkflow", () => {
  it("resolves `none` to the no-ceremony posture", () => {
    const wf = resolveWorkflow({ workflow: { profile: "none" } });
    expect(wf).toMatchObject({
      profile: "none",
      isolate: false,
      requireCommit: false,
      requirePr: false,
      reviewLoop: false,
      syncMainAfter: "never",
      memory: "ignore",
      guard: "off",
    });
  });

  it("resolves `commit` to trunk work with a commit obligation", () => {
    const wf = resolveWorkflow({ workflow: { profile: "commit" } });
    expect(wf).toMatchObject({
      isolate: false,
      requireCommit: true,
      requirePr: false,
      memory: "commit",
      // Committing on the trunk IS the rung — the guard must stay off.
      guard: "off",
    });
  });

  it("resolves `review` to the full worktree + PR loop", () => {
    const wf = resolveWorkflow({ workflow: { profile: "review" } });
    expect(wf).toMatchObject({
      isolate: true,
      requireCommit: true,
      requirePr: true,
      reviewLoop: true,
      syncMainAfter: "merge",
      memory: "commit",
      guard: "deny",
    });
  });

  it("applies per-field overrides on top of the profile", () => {
    const wf = resolveWorkflow({
      workflow: { profile: "review", guard: "warn", syncMainAfter: "ship", memory: "ignore" },
    });
    expect(wf).toMatchObject({
      profile: "review",
      isolate: true,
      guard: "warn",
      syncMainAfter: "ship",
      memory: "ignore",
    });
  });

  it("infers `review` for a legacy project that has a ship command", () => {
    const wf = resolveWorkflow({ shipCmd: "pnpm ship", worktreeCmd: "pnpm worktree" });
    expect(wf.profile).toBe("review");
    expect(wf.shipCmd).toBe("pnpm ship");
    expect(wf.worktreeCmd).toBe("pnpm worktree");
  });

  it("infers `none` for a legacy project with no ship command", () => {
    expect(resolveWorkflow({}).profile).toBe("none");
    expect(resolveWorkflow(null).profile).toBe("none");
  });

  it("leaves auto-merge OFF until a project opts in", () => {
    // Landing your own work is a delegation, not something picking `review` hands
    // over silently — every profile defaults to off.
    for (const profile of ["none", "commit", "review"] as const) {
      expect(resolveWorkflow({ workflow: { profile } }).autoMerge, profile).toBe("off");
    }
    expect(resolveWorkflow({ workflow: { profile: "review", autoMerge: "on-green" } })).toMatchObject(
      { autoMerge: "on-green", mergeMethod: "squash" },
    );
  });

  it("clamps auto-merge to off on the rungs that have no PR to land", () => {
    for (const profile of ["none", "commit"] as const) {
      const wf = resolveWorkflow({ workflow: { profile, autoMerge: "on-green" } });
      expect(wf.autoMerge, profile).toBe("off");
    }
  });

  it("carries the configured merge strategy through", () => {
    const wf = resolveWorkflow({
      workflow: { profile: "review", autoMerge: "on-green", mergeMethod: "rebase" },
    });
    expect(wf.mergeMethod).toBe("rebase");
  });

  it("prefers the workflow block's commands over the legacy top-level fields", () => {
    const wf = resolveWorkflow({
      workflow: { profile: "review", ship: "pnpm ship:new" },
      shipCmd: "pnpm ship:old",
    });
    expect(wf.shipCmd).toBe("pnpm ship:new");
  });
});

describe("classifyWorkflowViolation", () => {
  const onTrunk = { defaultBranch: "main", currentBranch: "main" };
  const onBranch = { defaultBranch: "main", currentBranch: "feat/x", inWorktree: true };

  it("passes ordinary work through", () => {
    expect(classifyWorkflowViolation("pnpm build", onTrunk)).toBeNull();
    expect(classifyWorkflowViolation("git status", onTrunk)).toBeNull();
    expect(classifyWorkflowViolation("git commit -m 'feat: x'", onBranch)).toBeNull();
    expect(classifyWorkflowViolation("git push -u origin feat/x", onBranch)).toBeNull();
  });

  it("catches a commit on the trunk", () => {
    expect(classifyWorkflowViolation("git commit -m 'oops'", onTrunk)?.kind).toBe("commit-on-trunk");
  });

  it("lets a commit through when the branch is unknown", () => {
    // A guard that blocks legitimate work on a false positive gets turned off.
    expect(classifyWorkflowViolation("git commit -m 'x'", { defaultBranch: "main" })).toBeNull();
  });

  it("catches an explicit push to the trunk in every spelling", () => {
    for (const cmd of [
      "git push origin main",
      "git push origin HEAD:main",
      "git push origin +main",
      "git push --force origin refs/heads/main",
      "git push origin feat/x main",
    ]) {
      expect(classifyWorkflowViolation(cmd, onBranch)?.kind, cmd).toBe("push-to-trunk");
    }
  });

  it("catches a bare push from a trunk checkout", () => {
    expect(classifyWorkflowViolation("git push", onTrunk)?.kind).toBe("push-to-trunk");
    expect(classifyWorkflowViolation("git push", onBranch)).toBeNull();
  });

  it("honors a non-`main` trunk", () => {
    expect(
      classifyWorkflowViolation("git push origin trunk", { defaultBranch: "trunk" })?.kind,
    ).toBe("push-to-trunk");
    expect(classifyWorkflowViolation("git push origin main", { defaultBranch: "trunk" })).toBeNull();
  });

  it("catches a hand-rolled merge", () => {
    expect(classifyWorkflowViolation("gh pr merge 42 --squash", onBranch)?.kind).toBe(
      "manual-merge",
    );
    expect(classifyWorkflowViolation("git merge feat/x", onTrunk)?.kind).toBe("manual-merge");
    // …but merging origin/main INTO a task branch is normal.
    expect(classifyWorkflowViolation("git merge origin/main", onBranch)).toBeNull();
  });

  it("still refuses `gh pr merge` under auto-merge, pointing at approve_pr", () => {
    // Auto-merge doesn't license the raw command — it only changes the sentence,
    // because approve_pr is what runs the readiness checks and syncs the trunk.
    const v = classifyWorkflowViolation("gh pr merge 42 --squash", {
      ...onBranch,
      autoMerge: true,
    });
    expect(v?.kind).toBe("manual-merge");
    expect(v?.reason).toMatch(/approve_pr/);
    // …and a local merge into the trunk is no more allowed than before.
    expect(
      classifyWorkflowViolation("git merge feat/x", { ...onTrunk, autoMerge: true })?.kind,
    ).toBe("manual-merge");
  });

  it("sees through global git flags and chained commands", () => {
    expect(classifyWorkflowViolation("git -C ../repo push origin main", onBranch)?.kind).toBe(
      "push-to-trunk",
    );
    expect(classifyWorkflowViolation("pnpm build && git push origin main", onBranch)?.kind).toBe(
      "push-to-trunk",
    );
    expect(classifyWorkflowViolation("git add -A; git commit -m 'x'", onTrunk)?.kind).toBe(
      "commit-on-trunk",
    );
  });

  it("ignores a `main` that is merely an argument to something else", () => {
    expect(classifyWorkflowViolation("git log origin/main", onTrunk)).toBeNull();
    expect(classifyWorkflowViolation("gh pr list --base main", onBranch)).toBeNull();
  });
});
