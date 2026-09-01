import { describe, it, expect } from "vitest";
import {
  resolveWorkflow,
  classifyWorkflowViolation,
  authorReviewerRoster,
  normalizeReviewerRoster,
  COPILOT_LOGIN,
} from "./workflow.js";
import type { PrReviewerEntry } from "./workflow.js";

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

  it("defaults `review` to requiring a reported review AND a reported check", () => {
    // The motivating failure: a `review` + `autoMerge: on-green` project where
    // nothing requested a reviewer and zero checks reported, which made "green"
    // trivially true. Both requirements therefore default ON.
    const wf = resolveWorkflow({ workflow: { profile: "review" } });
    expect(wf.pr).toEqual({
      // Copilot by default, so `requireReview` asks for a review someone can
      // actually give instead of blocking on a reviewer nobody configured.
      reviewers: [COPILOT_LOGIN],
      reviewerRoster: [{ login: COPILOT_LOGIN, enabled: true }],
      requireReview: true,
      requireChecks: true,
      draft: false,
      // Off by default: spawning a reviewer spends the human's model quota, so
      // it is a toggle they flip, not something the profile hands over.
      reviewAgent: {
        enabled: false,
        identity: "self",
        login: undefined,
        effort: "high",
        maxRounds: 4,
        post: true,
      },
    });
  });

  it("carries an authored `pr:` block through on `review`", () => {
    const wf = resolveWorkflow({
      workflow: {
        profile: "review",
        pr: {
          reviewers: ["copilot-pull-request-reviewer", "acme/platform"],
          requireChecks: false,
          draft: true,
        },
      },
    });
    expect(wf.pr).toEqual({
      reviewers: ["copilot-pull-request-reviewer", "acme/platform"],
      reviewerRoster: [
        { login: "copilot-pull-request-reviewer", enabled: true },
        { login: "acme/platform", enabled: true },
      ],
      // Unauthored fields still fall through to the profile default.
      requireReview: true,
      requireChecks: false,
      draft: true,
      reviewAgent: {
        enabled: false,
        identity: "self",
        login: undefined,
        effort: "high",
        maxRounds: 4,
        post: true,
      },
    });
  });

  it("merges an authored reviewAgent block field-by-field over the default", () => {
    // A spread would resolve the omitted `maxRounds` to undefined and hand every
    // consumer an uncapped review loop to re-derive.
    const wf = resolveWorkflow({
      workflow: {
        profile: "review",
        pr: { reviewAgent: { enabled: true, effort: "max", identity: "dedicated" } },
      },
    });
    expect(wf.pr.reviewAgent).toEqual({
      enabled: true,
      identity: "dedicated",
      login: undefined,
      effort: "max",
      maxRounds: 4,
      post: true,
    });
  });

  it("never resolves a reviewer login here, even asking for a dedicated account", () => {
    // The login lives with the TOKEN, in the config dir, because this file is
    // committed. This package cannot read that, so the server overlays it — and
    // a consumer seeing `dedicated` with no login must read that as NOT
    // CONFIGURED rather than falling back to the human's own account.
    const wf = resolveWorkflow({
      workflow: { profile: "review", pr: { reviewAgent: { enabled: true, identity: "dedicated" } } },
    });
    expect(wf.pr.reviewAgent.identity).toBe("dedicated");
    expect(wf.pr.reviewAgent.login).toBeUndefined();
  });

  it("lets an authored empty list opt out of the default reviewer", () => {
    // `?? base` and not `|| base`: an explicit `reviewers: []` is a decision to
    // request nobody, not an absent value to be filled in with Copilot.
    const wf = resolveWorkflow({ workflow: { profile: "review", pr: { reviewers: [] } } });
    expect(wf.pr.reviewers).toEqual([]);
  });

  it("keeps a muted reviewer in the roster and out of the request list", () => {
    // The switch has to resolve away HERE, once. `create_pr`, `request_review`,
    // the dedicated-account check and `approve_pr`'s `no-review` refusal all read
    // `pr.reviewers`, and a mute only some of them honoured would be worse than
    // no mute at all — a PR requested from somebody the config says is off.
    const wf = resolveWorkflow({
      workflow: {
        profile: "review",
        pr: { reviewers: [{ login: COPILOT_LOGIN, enabled: false }, "dispatch-review"] },
      },
    });
    expect(wf.pr.reviewers).toEqual(["dispatch-review"]);
    expect(wf.pr.reviewerRoster).toEqual([
      { login: COPILOT_LOGIN, enabled: false },
      { login: "dispatch-review", enabled: true },
    ]);
  });

  it("reads a bare login as an ENABLED reviewer", () => {
    // Every manifest written before the switch existed is a list of bare strings,
    // and each one has to keep meaning "ask this reviewer" — the alternative is a
    // silent upgrade that stops requesting anyone.
    const wf = resolveWorkflow({
      workflow: { profile: "review", pr: { reviewers: ["octocat", { login: "hubot" }] } },
    });
    expect(wf.pr.reviewers).toEqual(["octocat", "hubot"]);
  });

  it("resolves an all-muted roster to the same empty request list as `reviewers: []`", () => {
    const wf = resolveWorkflow({
      workflow: { profile: "review", pr: { reviewers: [{ login: "octocat", enabled: false }] } },
    });
    expect(wf.pr.reviewers).toEqual([]);
    // But the row survives, which is the whole difference from deleting it.
    expect(wf.pr.reviewerRoster).toEqual([{ login: "octocat", enabled: false }]);
  });

  it("clamps the PR policy to inert on the rungs that have no PR", () => {
    // Same reason autoMerge is clamped: no consumer should have to re-check the
    // profile before trusting a resolved field.
    for (const profile of ["none", "commit"] as const) {
      const wf = resolveWorkflow({
        workflow: {
          profile,
          pr: {
            reviewers: ["someone"],
            requireReview: true,
            requireChecks: true,
            draft: true,
            reviewAgent: { enabled: true, maxRounds: 9, identity: "dedicated" },
          },
        },
      });
      expect(wf.pr, profile).toEqual({
        reviewers: [],
        reviewerRoster: [],
        requireReview: false,
        requireChecks: false,
        draft: false,
        reviewAgent: {
          enabled: false,
          identity: "self",
          login: undefined,
          effort: "high",
          maxRounds: 4,
          post: true,
        },
      });
    }
  });

  it("gives a legacy ship-command project the `review` PR policy", () => {
    // Back-compat inference has to carry the whole rung, not just its name.
    expect(resolveWorkflow({ shipCmd: "pnpm ship" }).pr.requireReview).toBe(true);
    expect(resolveWorkflow({}).pr.requireReview).toBe(false);
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

  it("refuses a hand-rolled `gh pr create` on a PR project, pointing at create_pr", () => {
    // The gap that let a PR ship with no reviewer requested, no chat link and no
    // watcher: `gh pr merge` was guarded, `gh pr create` was not.
    const v = classifyWorkflowViolation("gh pr create --fill --base main", {
      ...onBranch,
      requirePr: true,
    });
    expect(v?.kind).toBe("pr-create-by-hand");
    expect(v?.reason).toMatch(/mcp__dispatch-github__create_pr/);
    // …and it says what the sanctioned path does that the raw command doesn't.
    expect(v?.reason).toMatch(/reviewers/);
    expect(v?.reason).toMatch(/watcher/);
  });

  it("leaves `gh pr create` alone where there is no PR workflow to redirect to", () => {
    // On `none`/`commit` there is no create_pr to point at, and a refusal with no
    // alternative is just a wall.
    expect(classifyWorkflowViolation("gh pr create --fill", onBranch)).toBeNull();
    expect(
      classifyWorkflowViolation("gh pr create --fill", { ...onBranch, requirePr: false }),
    ).toBeNull();
  });

  it("does not mistake other `gh pr` subcommands for a create", () => {
    const ctx = { ...onBranch, requirePr: true };
    expect(classifyWorkflowViolation("gh pr view 42", ctx)).toBeNull();
    expect(classifyWorkflowViolation("gh pr checks 42", ctx)).toBeNull();
    expect(classifyWorkflowViolation("gh pr list --state open", ctx)).toBeNull();
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

describe("the reviewer roster", () => {
  it("drops a blank entry rather than passing it on as a login", () => {
    // A stray `- ""` in the YAML reaches `POST /pulls/{n}/requested_reviewers`
    // as a reviewer name, where it fails the whole batch — including the real
    // reviewers sitting next to it in the same request.
    expect(normalizeReviewerRoster(["octocat", "  ", { login: "" }])).toEqual([
      { login: "octocat", enabled: true },
    ]);
  });

  it("collapses a duplicated login, first row winning", () => {
    // A hand-edited manifest can hold one login twice in disagreeing states, and
    // there is no meaning to resolve there — GitHub logins are case-insensitive,
    // so it is one reviewer asked twice. Collapsing is also what lets the editor
    // key its rows by login: a switch on one row must not move another.
    expect(normalizeReviewerRoster(["Octocat", { login: "octocat", enabled: false }])).toEqual([
      { login: "Octocat", enabled: true },
    ]);
  });

  it("skips a malformed row instead of throwing mid-resolve", () => {
    // Every path here is schema-validated first, but this function is exported
    // and pure — and a TypeError thrown inside `resolveWorkflow` takes out
    // whatever was resolving the workflow, rather than the one row written wrong.
    const junk = [{ enabled: false }, null, 7, "octocat"] as unknown as PrReviewerEntry[];
    expect(normalizeReviewerRoster(junk)).toEqual([{ login: "octocat", enabled: true }]);
  });

  it("round-trips through the authored form, keeping bare logins bare", () => {
    // Long-form every row and a project that never touched a switch gets a diff
    // on a committed file in which nothing actually changed.
    const authored = authorReviewerRoster([
      { login: "octocat", enabled: true },
      { login: COPILOT_LOGIN, enabled: false },
    ]);
    expect(authored).toEqual(["octocat", { login: COPILOT_LOGIN, enabled: false }]);
    expect(normalizeReviewerRoster(authored)).toEqual([
      { login: "octocat", enabled: true },
      { login: COPILOT_LOGIN, enabled: false },
    ]);
  });
});
