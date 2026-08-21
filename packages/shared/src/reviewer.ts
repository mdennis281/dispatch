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
  id: z.enum(["token", "distinct", "collaborator"]),
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
