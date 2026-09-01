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
 * The second matters more than it looks. The dedicated-account setup has THREE
 * failure modes and none is visible until a review is attempted for real:
 *
 *   - a token that doesn't authenticate;
 *   - an account that authenticates perfectly but was never added to the
 *     repository — which GitHub rejects only at request time, with *"Reviews may
 *     only be requested from collaborators"*;
 *   - an account that is a collaborator whose TOKEN was never scoped to this
 *     repository, which passes both checks above and then fails at
 *     `post_review` with a 404 that reads like a missing pull request.
 *
 * The third is the cruellest, because the two grants are independent and only
 * one of them is visible from the repo's own settings page. A setup panel that
 * cannot tell you which of these you have is a setup panel that sends you to the
 * GitHub docs.
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
export type ReviewerGitHub = Pick<
  GitHubService,
  "whoami" | "isCollaborator" | "canReadRepoAs"
>;

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
  const pr = resolveWorkflow(project).pr;
  const policy = pr.reviewAgent;
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
  // A dedicated reviewer is spawned off GitHub's OWN review queue and nothing
  // else: `maybeSpawnReview` arms the row only when `policy.login` is sitting in
  // it, and `claimReviewAgent` opens with `if (!state.requestedAt) return null`.
  // The local-request path that self-review uses is deliberately withheld here
  // (see `armPrWatch` in container.ts), on the assumption that `create_pr` put
  // the account in the queue — but `create_pr` requests `pr.reviewers` verbatim
  // and never appends the login. So an account missing from that list is a
  // reviewer that can never run, on every PR of the project, and until this
  // check existed it said so nowhere: `hivebreak` carried this config across 19
  // pull requests without one armed row, and the misconfiguration only surfaced
  // when the unrelated bot it listed instead stopped reviewing too.
  //
  // NOT `enabled: false`, unlike the missing-credential case above: the identity
  // resolves fine and `post_review` works, so a review triggered by any other
  // means must still post. What is broken is only the trigger.
  if (!pr.reviewers.some((r) => sameLogin(r, cred.login))) {
    // Switched off is its own diagnosis, not a missing entry. Telling someone to
    // "add" a login they can SEE in the list — greyed out, one click from
    // working — is the kind of advice that makes a reader distrust the rest of
    // the message.
    const muted = pr.reviewerRoster.some((r) => !r.enabled && sameLogin(r.login, cred.login));
    return {
      policy: { ...policy, login: cred.login },
      token: cred.token,
      problem: muted
        ? `This project reviews as \`${cred.login}\`, but that account is switched OFF in ` +
          `\`workflow.pr.reviewers\`` +
          (pr.reviewers.length ? ` — it asks ${pr.reviewers.join(", ")} instead` : "") +
          `. The reviewer only ever starts when its own login appears in GitHub's review ` +
          `queue, and \`create_pr\` requests only the reviewers that are on, so no review ` +
          `will spawn on this project until it is switched back on in Config → Reviewer.`
        : `This project reviews as \`${cred.login}\`, but \`workflow.pr.reviewers\` does not ` +
          `list that account` +
          (pr.reviewers.length ? ` — it asks ${pr.reviewers.join(", ")}` : " (the list is empty)") +
          `. The reviewer only ever starts when its own login appears in GitHub's review queue, ` +
          `and \`create_pr\` requests exactly \`pr.reviewers\`, so no review will ever spawn on ` +
          `this project. Add \`${cred.login}\` to \`workflow.pr.reviewers\` in ` +
          `\`.dispatch/project.yaml\`; it must also be a collaborator on the repo.`,
    };
  }
  return { policy: { ...policy, login: cred.login }, token: cred.token };
}

/**
 * Compare two reviewer logins.
 *
 * `[bot]` is stripped because the two halves of this comparison are written in
 * different dialects: `pr.reviewers` is hand-authored and GitHub's own UI shows
 * bots suffixed, while the API reports the bare login. A literal compare made
 * every bot reviewer look absent from its own project's list.
 */
function sameLogin(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\[bot\]$/, "");
  return norm(a) === norm(b);
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
    // Being a collaborator and being IN THE TOKEN'S SCOPE are two independent
    // grants, and the panel used to check only the first — which is the half
    // that runs as the human. A fine-grained PAT lists the repositories it may
    // touch, and adding its account to a repo does not widen a token minted for
    // another one; the account passes as a collaborator, GitHub queues it, and
    // the review dies at `post_review` with a 404 that reads like a missing PR.
    const access = await github.canReadRepoAs(input.repo, token);
    checks.push(
      access === true
        ? {
            id: "access",
            state: "pass",
            detail: `This token can read ${input.repo}.`,
          }
        : access === false
          ? {
              id: "access",
              state: "fail",
              detail:
                `This token cannot see ${input.repo}, even though it authenticates. A ` +
                "fine-grained token grants access per repository — adding the account as a " +
                "collaborator does not widen a token minted for a different repo. Edit the " +
                "token's Repository access setting to include this one. Left as is, reviews are " +
                "written and then rejected with a 404 that looks like a missing pull request.",
            }
          : {
              id: "access",
              state: "warn",
              detail: `Could not check whether this token can read ${input.repo}.`,
            },
    );

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
                "Read access — that is enough, and it cannot push.",
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
