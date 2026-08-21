/**
 * The reviewer's identity, resolved — and checked before it is trusted.
 *
 * Two jobs, both of which exist because the identity is assembled from two
 * places that can disagree:
 *
 *   - {@link resolveReviewer} joins the per-project policy (committed, in
 *     `project.yaml`) to the app-wide credential (a secret, in the config dir),
 *     and produces the single object every consumer reads.
 *   - {@link verifyReviewer} answers "will this actually work", at setup time,
 *     rather than at the first PR.
 *
 * The second matters more than it looks. The dedicated-account setup has two
 * failure modes and neither is visible until a review is requested for real: a
 * token that doesn't authenticate, and an account that authenticates perfectly
 * but was never added to the repository — which GitHub rejects only at request
 * time, with *"Reviews may only be requested from collaborators"*. A setup panel
 * that cannot tell you which of those you have is a setup panel that sends you
 * to the GitHub docs.
 */
import {
  resolveWorkflow,
  type Project,
  type ResolvedReviewAgent,
  type ReviewerCheck,
  type ReviewerVerify,
} from "@dispatch/shared";
import type { GitHubService } from "./github.js";
import type { Store } from "../store/index.js";

/**
 * The GitHub surface a verification needs — two reads, kept structural so this
 * is testable without a GitHubService (and so it stays obvious that setup never
 * WRITES anything to GitHub).
 */
export type ReviewerGitHub = Pick<GitHubService, "whoami" | "isCollaborator">;

/** The credential reads a verification needs, kept structural for the same reason. */
export type ReviewerStore = Pick<Store, "getReviewer">;

/** The reviewer as the rest of the server should see it: one policy, one token. */
export interface ReviewerResolution {
  /**
   * The effective policy. When the project asked for a dedicated reviewer and
   * there is no credential, this comes back **disabled** — see `problem`.
   */
  policy: ResolvedReviewAgent;
  /** The dedicated account's token. Absent for self-review, by definition. */
  token?: string;
  /**
   * Set when the project asked for something it cannot have. Surfaced rather
   * than papered over: falling back to self-review because a token went missing
   * would post under the human's own name without anyone choosing that.
   */
  problem?: string;
}

/**
 * Join a project's reviewer policy to the stored credential.
 *
 * Called per PR the sweep considers and per session that binds `post_review`, so
 * it stays two cheap reads and no network.
 */
export async function resolveReviewer(
  store: ReviewerStore,
  project: Project,
): Promise<ReviewerResolution> {
  const policy = resolveWorkflow(project).pr.reviewAgent;
  if (!policy.enabled || policy.identity !== "dedicated") return { policy };

  const cred = await store.getReviewer().catch(() => null);
  if (!cred) {
    // Disabled, not downgraded. The project said "review as somebody else"; the
    // honest answer to "there is no somebody else" is to do nothing and say so.
    return {
      policy: { ...policy, enabled: false },
      problem:
        "This project reviews as a dedicated account, but no reviewer account is set up. " +
        "Add one in Config → Reviewer, or switch the project to self-review.",
    };
  }
  return { policy: { ...policy, login: cred.login }, token: cred.token };
}

/**
 * Check a reviewer credential against GitHub.
 *
 * `token` omitted = check the STORED one, which is what the panel's "re-check"
 * does after a repo is added or a token rotated. `repo` omitted = skip the
 * collaborator check rather than guess at a repository.
 *
 * Never throws. Every check degrades to a `warn` that says what could not be
 * established, because a setup panel that shows an error banner when GitHub is
 * briefly unreachable trains people to ignore its error banners.
 */
export async function verifyReviewer(
  github: ReviewerGitHub,
  store: ReviewerStore,
  input: { token?: string; repo?: string } = {},
): Promise<ReviewerVerify> {
  const token = input.token ?? (await store.getReviewer().catch(() => null))?.token;
  const checks: ReviewerCheck[] = [];
  if (!token) {
    return {
      ok: false,
      checks: [
        {
          id: "token",
          state: "fail",
          detail: "No token to check — paste the reviewer account's token first.",
        },
      ],
    };
  }

  const who = await github.whoami(token);
  if (!who.login) {
    return {
      ok: false,
      checks: [
        {
          id: "token",
          state: "fail",
          detail:
            `GitHub rejected this token: ${who.error ?? "it did not authenticate"}. ` +
            "A classic token needs the `repo` scope; a fine-grained one must not be expired " +
            "and must list this repository under its resource access — which it can only do " +
            "for repositories the reviewer account itself owns.",
        },
      ],
    };
  }
  checks.push({
    id: "token",
    state: "pass",
    detail: `Authenticates as ${who.login}.`,
  });

  // Same login as the human = self-review wearing a costume. Not fatal (GitHub
  // will simply refuse the verdict and the review lands as a comment), so it is
  // a warning — but it is silent otherwise, and "why does the bot never request
  // changes" is a miserable thing to debug.
  const me = await github.whoami();
  if (me.login && me.login.toLowerCase() === who.login.toLowerCase()) {
    checks.push({
      id: "distinct",
      state: "warn",
      detail:
        `This is your own account (${me.login}), not a separate one. GitHub refuses a ` +
        "verdict on your own pull request, so reviews will land as plain comments.",
    });
  } else if (me.login) {
    checks.push({
      id: "distinct",
      state: "pass",
      detail: `A different account from yours (${me.login}).`,
    });
  }

  if (input.repo) {
    const collab = await github.isCollaborator(input.repo, who.login);
    checks.push(
      collab === true
        ? {
            id: "collaborator",
            state: "pass",
            detail: `${who.login} is a collaborator on ${input.repo} and can be requested.`,
          }
        : collab === false
          ? {
              id: "collaborator",
              state: "fail",
              detail:
                `${who.login} is not a collaborator on ${input.repo}. GitHub refuses to ` +
                "request a review from a non-collaborator. Invite the account with " +
                "**Read** access — that is enough, and it cannot push.",
            }
          : {
              id: "collaborator",
              state: "warn",
              detail: `Could not check whether ${who.login} is a collaborator on ${input.repo}.`,
            },
    );
  }

  return { ok: !checks.some((c) => c.state === "fail"), login: who.login, checks };
}
