import { describe, it, expect } from "vitest";
import type { Project, ReviewerCredential, WorkflowConfig } from "@dispatch/shared";
import { resolveReviewer, verifyReviewer, type ReviewerGitHub } from "./reviewer.js";

/** A store that holds one credential (or none) — the only read these two make. */
const storeWith = (cred: ReviewerCredential | null) => ({
  getReviewer: async () => cred,
});

const CRED: ReviewerCredential = {
  login: "dispatch-reviewer",
  token: "github_pat_secret",
  addedAt: 1,
};

const project = (workflow: WorkflowConfig): Project =>
  ({ id: "p1", name: "p", repoPath: "/repo", createdAt: 1, workflow }) as Project;

const REVIEW = (
  reviewAgent: NonNullable<NonNullable<WorkflowConfig["pr"]>["reviewAgent"]>,
): WorkflowConfig => ({ profile: "review", pr: { reviewAgent } });

/**
 * A GitHub that answers `whoami` per token, knows one collaborator, and knows
 * whether the reviewer's token can see the repo — which is a SEPARATE answer
 * from the collaborator one on purpose, because that is the whole trap.
 */
function fakeGitHub(over: {
  logins?: Record<string, string>;
  me?: string;
  collaborator?: boolean | null;
  canRead?: boolean | null;
} = {}): ReviewerGitHub {
  return {
    whoami: async (token?: string) => {
      if (!token) return over.me ? { login: over.me } : { error: "not logged in" };
      const login = over.logins?.[token];
      return login ? { login } : { error: "Bad credentials" };
    },
    isCollaborator: async () => over.collaborator ?? null,
    canReadRepoAs: async () => (over.canRead === undefined ? true : over.canRead),
  };
}

describe("resolveReviewer — joining the policy to the credential", () => {
  it("leaves self-review alone and hands over no token", async () => {
    const out = await resolveReviewer(
      storeWith(CRED),
      project(REVIEW({ enabled: true, identity: "self" })),
    );
    expect(out.policy.enabled).toBe(true);
    expect(out.policy.login).toBeUndefined();
    // Even with an account configured: self-review means post as the human, and
    // handing the token over anyway is how it gets used by accident.
    expect(out.token).toBeUndefined();
    expect(out.problem).toBeUndefined();
  });

  it("overlays the account's login and token for a dedicated reviewer", async () => {
    const out = await resolveReviewer(
      storeWith(CRED),
      project(REVIEW({ enabled: true, identity: "dedicated" })),
    );
    expect(out.policy.login).toBe("dispatch-reviewer");
    expect(out.token).toBe("github_pat_secret");
  });

  it("DISABLES rather than downgrades when the account is missing", async () => {
    // The failure this guards: falling back to self-review would post under the
    // human's own name because a token went missing, which nobody chose.
    const out = await resolveReviewer(
      storeWith(null),
      project(REVIEW({ enabled: true, identity: "dedicated" })),
    );
    expect(out.policy.enabled).toBe(false);
    expect(out.token).toBeUndefined();
    expect(out.problem).toMatch(/no reviewer account is set up/i);
  });

  it("does not read the credential at all when the reviewer is off", async () => {
    let reads = 0;
    const out = await resolveReviewer(
      {
        getReviewer: async () => {
          reads += 1;
          return CRED;
        },
      },
      project(REVIEW({ enabled: false, identity: "dedicated" })),
    );
    expect(out.policy.enabled).toBe(false);
    expect(reads).toBe(0);
  });
});

describe("verifyReviewer — catching the setup mistakes before the first PR", () => {
  it("passes a distinct, collaborating account", async () => {
    const out = await verifyReviewer(
      fakeGitHub({ logins: { t: "dispatch-reviewer" }, me: "octocat", collaborator: true }),
      storeWith(null),
      { token: "t", repo: "octo/repo" },
    );
    expect(out.ok).toBe(true);
    expect(out.login).toBe("dispatch-reviewer");
    // The whole list, in order, so a check that silently stops running is a
    // failure here rather than a reviewer that quietly breaks in six months.
    expect(out.checks.map((c) => [c.id, c.state])).toEqual([
      ["token", "pass"],
      ["distinct", "pass"],
      ["access", "pass"],
      ["collaborator", "pass"],
    ]);
  });

  it("fails a token GitHub will not authenticate, and stops there", async () => {
    const out = await verifyReviewer(fakeGitHub({ me: "octocat" }), storeWith(null), {
      token: "wrong",
      repo: "octo/repo",
    });
    expect(out.ok).toBe(false);
    expect(out.login).toBeUndefined();
    // No point reporting on collaborator status for an account we can't name.
    expect(out.checks).toHaveLength(1);
    expect(out.checks[0]!.detail).toMatch(/Bad credentials/);
  });

  it("fails an account that is not a collaborator — the mistake GitHub hides until request time", async () => {
    const out = await verifyReviewer(
      fakeGitHub({ logins: { t: "dispatch-reviewer" }, me: "octocat", collaborator: false }),
      storeWith(null),
      { token: "t", repo: "octo/repo" },
    );
    expect(out.ok).toBe(false);
    const collab = out.checks.find((c) => c.id === "collaborator")!;
    expect(collab.state).toBe("fail");
    expect(collab.detail).toMatch(/Read/);
  });

  it("warns, but does not fail, when the token is your own account", async () => {
    // It works — it just silently can never request changes, which is a
    // miserable thing to discover from a PR three days later.
    const out = await verifyReviewer(
      fakeGitHub({ logins: { t: "octocat" }, me: "OctoCat", collaborator: true }),
      storeWith(null),
      { token: "t", repo: "octo/repo" },
    );
    expect(out.ok).toBe(true);
    expect(out.checks.find((c) => c.id === "distinct")!.state).toBe("warn");
  });

  it("warns rather than fails when collaborator status can't be read", async () => {
    // A setup panel that shows an error when GitHub is briefly unreachable
    // teaches people to ignore its errors.
    const out = await verifyReviewer(
      fakeGitHub({ logins: { t: "dispatch-reviewer" }, me: "octocat", collaborator: null }),
      storeWith(null),
      { token: "t", repo: "octo/repo" },
    );
    expect(out.ok).toBe(true);
    expect(out.checks.find((c) => c.id === "collaborator")!.state).toBe("warn");
  });

  it("checks the STORED token when none is supplied", async () => {
    const out = await verifyReviewer(
      fakeGitHub({ logins: { github_pat_secret: "dispatch-reviewer" }, me: "octocat" }),
      storeWith(CRED),
    );
    expect(out.login).toBe("dispatch-reviewer");
    // No repo passed → no collaborator claim made, rather than a guessed one.
    expect(out.checks.some((c) => c.id === "collaborator")).toBe(false);
  });

  it("says so plainly when there is nothing to check", async () => {
    const out = await verifyReviewer(fakeGitHub(), storeWith(null));
    expect(out.ok).toBe(false);
    expect(out.checks[0]!.detail).toMatch(/paste the reviewer account's token/i);
  });
});

describe("verifyReviewer — the token's own repository scope", () => {
  it("fails a collaborator account whose TOKEN cannot see the repo", async () => {
    // The case that passed every check and still broke: the account IS a
    // collaborator, so GitHub queues it as a reviewer and the setup panel is
    // happy — but a fine-grained PAT grants access per repository, and adding
    // the account to a repo does not widen a token minted for a different one.
    // The review is then written and rejected with a 404 that reads like a
    // missing pull request (mdennis281/the-salesman #134).
    const out = await verifyReviewer(
      fakeGitHub({
        logins: { tok: "dispatch-review" },
        me: "mdennis281",
        collaborator: true,
        canRead: false,
      }),
      storeWith(null),
      { token: "tok", repo: "octo/repo" },
    );
    expect(out.ok).toBe(false);
    const access = out.checks.find((c) => c.id === "access");
    expect(access?.state).toBe("fail");
    expect(access?.detail).toMatch(/Repository access/i);
    // The collaborator half still passes — that is exactly why one check could
    // not stand in for the other.
    expect(out.checks.find((c) => c.id === "collaborator")?.state).toBe("pass");
  });

  it("passes when the token can read the repo", async () => {
    const out = await verifyReviewer(
      fakeGitHub({
        logins: { tok: "dispatch-review" },
        me: "mdennis281",
        collaborator: true,
        canRead: true,
      }),
      storeWith(null),
      { token: "tok", repo: "octo/repo" },
    );
    expect(out.ok).toBe(true);
    expect(out.checks.find((c) => c.id === "access")?.state).toBe("pass");
  });

  it("degrades an unreadable answer to a warning, never a failure", async () => {
    // Same rule as every other check here: a setup panel that shows an error
    // when GitHub is briefly unreachable trains people to ignore its errors.
    const out = await verifyReviewer(
      fakeGitHub({
        logins: { tok: "dispatch-review" },
        me: "mdennis281",
        collaborator: true,
        canRead: null,
      }),
      storeWith(null),
      { token: "tok", repo: "octo/repo" },
    );
    expect(out.ok).toBe(true);
    expect(out.checks.find((c) => c.id === "access")?.state).toBe("warn");
  });

  it("skips the scope check when no repo was named", async () => {
    // Same rule as the collaborator check: no repo means don't guess at one.
    const out = await verifyReviewer(
      fakeGitHub({ logins: { tok: "dispatch-review" }, me: "mdennis281" }),
      storeWith(null),
      { token: "tok" },
    );
    expect(out.checks.some((c) => c.id === "access")).toBe(false);
  });
});
