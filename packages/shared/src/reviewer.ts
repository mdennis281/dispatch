/**
 * The reviewer's IDENTITY — who a Dispatch review is posted as.
 *
 * Split out from `workflow.ts` because the two halves belong in different places
 * and one of them is a secret:
 *
 *   - **Which identity a project uses** is behaviour, it is per-project, and it
 *     belongs in the committed `.dispatch/project.yaml` (`workflow.pr.reviewAgent`).
 *   - **The account and its token** are a credential. They live in the config
 *     dir beside `auth.json`, are app-wide, and never touch the repo.
 *
 * That split is not tidiness. `project.yaml` is committed, so a token authored
 * there is a published token; and one machine account naturally reviews every
 * repo you own, so making it per-project would mean pasting the same secret into
 * every manifest — multiplying the number of places a leak can come from.
 */
import * as z from "zod";

/**
 * Who the review is posted as.
 *
 * `self` needs no setup and is what a project gets by default. It has one real
 * limitation, and it is GitHub's, not ours: **you cannot approve or request
 * changes on your own pull request**, so a self-review always lands as a
 * COMMENT. That is less toothless than it sounds — the inline comments are still
 * review threads, and `approve_pr` refuses to merge while any is unresolved.
 *
 * `dedicated` is a machine account. It is the only option where the reviewer can
 * be put in GitHub's own reviewer queue (see the `reviewAgent` docblock in
 * `workflow.ts` for why an App cannot), which is also what lets the request
 * itself be the trigger rather than a fact Dispatch has to remember.
 */
export const ReviewerIdentitySchema = z.enum(["self", "dedicated"]);
export type ReviewerIdentity = z.infer<typeof ReviewerIdentitySchema>;

/**
 * The stored credential — **this shape holds the token and must never leave the
 * server.** Every read surface returns {@link ReviewerStatusSchema} instead.
 */
export const ReviewerCredentialSchema = z.object({
  /** The machine account's GitHub login. */
  login: z.string().min(1),
  /**
   * A fine-grained PAT for that account. It needs exactly one permission —
   * `Pull requests: write` — on the repositories it reviews. It deliberately
   * does NOT need `Contents`, and the account itself only needs **Read** access
   * to the repo, so a leak of this token cannot push code.
   */
  token: z.string().min(1),
  addedAt: z.number().int(),
  /** When the token was last checked against GitHub, and who it came back as. */
  verifiedAt: z.number().int().optional(),
  verifiedLogin: z.string().optional(),
});
export type ReviewerCredential = z.infer<typeof ReviewerCredentialSchema>;

/** The credential as the API reports it — everything except the secret. */
export const ReviewerStatusSchema = z.object({
  configured: z.boolean(),
  login: z.string().optional(),
  addedAt: z.number().int().optional(),
  verifiedAt: z.number().int().optional(),
  verifiedLogin: z.string().optional(),
});
export type ReviewerStatus = z.infer<typeof ReviewerStatusSchema>;

/** One thing the setup check looked at, and how it went. */
export const ReviewerCheckSchema = z.object({
  id: z.enum(["token", "distinct", "collaborator", "access"]),
  /** `pass` = verified good. `warn` = works, but will bite. `fail` = won't work. */
  state: z.enum(["pass", "warn", "fail"]),
  /** One line, written for the human reading the setup panel. */
  detail: z.string(),
});
export type ReviewerCheck = z.infer<typeof ReviewerCheckSchema>;

/**
 * The result of checking a reviewer credential.
 *
 * Deliberately a LIST of checks rather than a boolean. The two ways this setup
 * fails are invisible until the first PR and look nothing alike — a token that
 * doesn't authenticate, and an account that authenticates fine but was never
 * added as a collaborator, which GitHub rejects only at request time with
 * *"Reviews may only be requested from collaborators"*. Reporting them
 * separately is what makes the panel able to say which one you have.
 */
export const ReviewerVerifySchema = z.object({
  ok: z.boolean(),
  /** Who GitHub says the token belongs to. Absent when it didn't authenticate. */
  login: z.string().optional(),
  checks: z.array(ReviewerCheckSchema),
});
export type ReviewerVerify = z.infer<typeof ReviewerVerifySchema>;

/** Redact a stored credential for the wire. The one place the token is dropped. */
export function reviewerStatus(cred: ReviewerCredential | null | undefined): ReviewerStatus {
  if (!cred) return { configured: false };
  return {
    configured: true,
    login: cred.login,
    addedAt: cred.addedAt,
    verifiedAt: cred.verifiedAt,
    verifiedLogin: cred.verifiedLogin,
  };
}

/* ------------------------------------------------ what the reviewer is doing */

/**
 * The reviewer's state on ONE pull request, reduced to the single thing worth
 * saying about it.
 *
 * A rendering concern, but it lives here rather than in a component because the
 * fields it reads are subtle enough that two surfaces deriving it independently
 * would drift: `reviewedAt` is claim time and not completion, `rounds` is
 * meaningless without `maxRounds`, and a `problem` outranks everything because
 * it means none of the rest is going to happen. The PRs panel and the workspace
 * roster both show this, and they must agree.
 *
 *   - `blocked`  — the reviewer will not run: either the identity does not
 *                  resolve (`problem`), or GitHub refused to queue it on this
 *                  PR (`requestError`). Disabled, not degraded.
 *   - `queued`   — asked for, waiting on the ~90s sweep to pick it up.
 *   - `running`  — a round is claimed and nothing has been posted for it yet.
 *   - `reviewed` — a review landed. `spent` says whether another can follow.
 *   - `spent`    — every round used and nothing outstanding. A silent stop
 *                  otherwise: the sweep simply stops spawning, forever.
 *
 * The phase is not the whole answer to "will another review ever run" — a final
 * round that was claimed and never posted reads as `running` forever. That
 * question is {@link PrReviewAgentView.roundsSpent}.
 */
export type PrReviewAgentPhase = "blocked" | "queued" | "running" | "reviewed" | "spent";

export interface PrReviewAgentView {
  phase: PrReviewAgentPhase;
  /** Which round this is — `rounds`, which counts claims, so ≥1 once claimed. */
  round: number;
  /** The cap, when the row knows it. Absent on rows written before it was recorded. */
  maxRounds?: number;
  /**
   * Every allowed round has been claimed, so `PrRegistry.claimReviewAgent` will
   * refuse the next one — no further reviewer can spawn for this PR, ever,
   * whatever GitHub's reviewer queue says.
   *
   * NOT the same question as `phase === "spent"`, and they diverge on exactly
   * the case that matters. `phase` is what to SHOW, and a claimed-but-unposted
   * round outranks the cap there because the row cannot tell a reviewer three
   * minutes into the diff from one whose chat died. This is the mechanical fact
   * underneath, true on that `running` row too: the cap is spent either way.
   *
   * False when `maxRounds` is absent. A row that never recorded its cap cannot
   * say the cap is reached, and guessing would turn "we don't know" into a
   * confident permanent stop.
   */
  roundsSpent: boolean;
  /** The reviewer chat, so a row can link to the transcript behind the verdict. */
  chatId?: string;
  /**
   * A review actually landed on the PR. False on `spent` when every round was
   * claimed and none of them filed anything — which is a real outcome (a
   * reviewer chat that died mid-run still spends its round) and reads very
   * differently from a cap reached by four reviews that all posted.
   */
  posted: boolean;
  /** Inline findings on the last posted review. */
  findings?: number;
  /** The verdict GitHub accepted for the last posted review. */
  postedEvent?: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
  /** When the phase last moved, for a relative timestamp. */
  at?: number;
  /** Set on `blocked` — the operator-facing sentence from `resolveReviewer`. */
  problem?: string;
}

/**
 * Derive {@link PrReviewAgentView} from a PR row's persisted reviewer state.
 *
 * `null` = say nothing. That is the resting state of every PR in a project that
 * never configured a reviewer, and a chip reading "no review" on all of them
 * would be noise on the rows where it is expected and invisible on the one row
 * where it is not.
 */
export function prReviewAgentView(
  state:
    | {
        requestedAt?: number;
        requestedSha?: string;
        reviewedAt?: number;
        reviewedSha?: string;
        postedAt?: number;
        chatId?: string;
        rounds?: number;
        findings?: number;
        postedEvent?: "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
        maxRounds?: number;
        extraRounds?: number;
        problem?: string;
        requestError?: string;
      }
    | undefined,
): PrReviewAgentView | null {
  if (!state) return null;
  const round = state.rounds ?? 0;
  // The EFFECTIVE cap: the project's policy plus whatever `request_review`'s
  // `extraRounds` granted on this PR alone. Reported as `maxRounds` because it
  // is the number every surface means by "of how many" — a chip reading "3 of 2"
  // would be nonsense, and the policy value on its own is not the limit any more.
  const cap =
    state.maxRounds != null ? state.maxRounds + (state.extraRounds ?? 0) : undefined;
  // The cap rule, spelled ONCE. `claimReviewAgent` refuses on exactly this
  // comparison, and every surface that wants to say "the reviewer is done" —
  // the chip, and `watch_pr`, which otherwise blocks for half an hour on a round
  // that can never be claimed — has to mean the same thing by it.
  const roundsSpent = cap != null && round >= cap;
  const base = {
    round,
    maxRounds: cap,
    roundsSpent,
    chatId: state.chatId,
    posted: false,
  };

  // First, because these are the answer to "why has nothing happened" and every
  // other phase below would answer that question wrongly.
  //
  // `problem` outranks `requestError`: an identity that does not resolve is why
  // the request was never even attempted, so reporting GitHub's refusal of an
  // older attempt would name a symptom over its cause.
  const blocked = state.problem ?? state.requestError;
  if (blocked) {
    return { ...base, phase: "blocked", problem: blocked, at: state.requestedAt };
  }

  // A claim clears the request, so an outstanding one normally outranks the last
  // finished round: the row is waiting on the next sweep, not resting.
  //
  // EXCEPT when it is armed at the head of a round that is still IN FLIGHT.
  // Letting that read as `queued` masked the round genuinely running, and that
  // is not cosmetic: `spentReviewRounds` derives `inFlight` from
  // `phase === "running"`, so on PR #147 a `request_review` fired two minutes
  // into round 2 flipped the row to `queued`, `watch_pr` concluded "every round
  // is spent and nothing is coming", and the review it had just declared
  // impossible posted three minutes later with an unresolved finding.
  //
  // Scoped to `!postedAt` for the same reason the registry's guard is: once a
  // round has finished, a request at that head is a real pending request — the
  // row's head is up to 90s stale, so a genuine post-push re-request routinely
  // lands there and IS served once the poll catches up.
  const staleRequest =
    state.requestedSha !== undefined &&
    state.requestedSha === state.reviewedSha &&
    !state.postedAt;
  if (state.requestedAt && !staleRequest) {
    return { ...base, phase: "queued", at: state.requestedAt };
  }

  // Claimed and nothing posted for it. NOT derived from `reviewedAt` alone —
  // that is written at claim time and never cleared, so every reviewed PR would
  // read as permanently in flight.
  //
  // This outranks a spent cap deliberately. A round that has been claimed and
  // not posted is still running as far as anything persisted knows: a reviewer
  // chat that died leaves exactly the same row as one three minutes into the
  // diff, and there is no honest way to tell them apart from here. `running`
  // links to the chat, which is where the difference is actually visible.
  if (round > 0 && state.reviewedAt && !state.postedAt) {
    return { ...base, phase: "running", at: state.reviewedAt };
  }

  if (state.postedAt) {
    return {
      ...base,
      phase: roundsSpent ? "spent" : "reviewed",
      posted: true,
      findings: state.findings,
      postedEvent: state.postedEvent,
      at: state.postedAt,
    };
  }

  return null;
}
