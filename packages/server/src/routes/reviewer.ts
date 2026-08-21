/**
 * REST for the PR reviewer's machine account.
 *
 *   GET    /api/reviewer          → ReviewerStatus (never the token)
 *   PUT    /api/reviewer          → { login?, token } → store + verify → status
 *   DELETE /api/reviewer          → 204
 *   POST   /api/reviewer/verify   → ReviewerVerify (stored token, or a candidate)
 *
 * Its own endpoints rather than a field on `PUT /api/settings`, for the same
 * reason `auth` and `updateChannel` had to be hand-preserved there: that route
 * is a FULL REPLACE, so a routine preference save from an older client — or from
 * a different settings page — would silently drop anything it didn't know about.
 * Dropping a theme is a nuisance; dropping the credential would disable every
 * project's reviewer with no error and no obvious cause.
 *
 * The token is write-only across this boundary. It goes in on a PUT and is never
 * returned by anything, so a compromised browser session cannot read back a
 * credential it did not already have.
 */
import type { FastifyInstance } from "fastify";
import * as z from "zod";
import { reviewerStatus } from "@dispatch/shared";
import { verifyReviewer } from "../services/reviewer.js";

const PutSchema = z.object({
  // No `login`: the account's name is read back from GitHub with the token, not
  // taken from the form. A form field for it would only be a second place for
  // the two to disagree, and the wrong one would win.
  token: z.string().min(1),
  /**
   * Which repo to run the collaborator check against. A project id rather than
   * an `owner/name` because the config view knows which project it is showing
   * and does NOT know the slug — resolving it here beats teaching the client to
   * parse a git remote.
   */
  projectId: z.string().optional(),
});

const VerifySchema = z.object({
  token: z.string().optional(),
  projectId: z.string().optional(),
});

/** The repo a check should run against, or undefined to skip the repo checks. */
async function repoFor(
  app: FastifyInstance,
  projectId: string | undefined,
): Promise<string | undefined> {
  if (!projectId) return undefined;
  return app.services.github.repoForProjectId(projectId).catch(() => undefined);
}

export function registerReviewerRoutes(app: FastifyInstance): void {
  const { store } = app.cm;

  app.get("/api/reviewer", async () => reviewerStatus(await store.getReviewer()));

  app.put("/api/reviewer", async (req, reply) => {
    const parsed = PutSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { token } = parsed.data;
    const repo = await repoFor(app, parsed.data.projectId);

    // Verify BEFORE storing. A credential that is saved and then reported broken
    // leaves the config view showing a configured reviewer that cannot review —
    // which is exactly the silent half-configured state this panel exists to
    // prevent. The account's real login comes from GitHub, never from the form.
    const verified = await verifyReviewer(app.services.github, store, { token, repo });
    if (!verified.login) {
      return reply.code(400).send({ error: verified.checks[0]?.detail ?? "token rejected", verify: verified });
    }

    const existing = await store.getReviewer().catch(() => null);
    const saved = await store.saveReviewer({
      login: verified.login,
      token,
      addedAt: existing?.addedAt ?? Date.now(),
      verifiedAt: Date.now(),
      verifiedLogin: verified.login,
    });
    return { ...reviewerStatus(saved), verify: verified };
  });

  app.delete("/api/reviewer", async (_req, reply) => {
    await store.clearReviewer();
    return reply.code(204).send();
  });

  app.post("/api/reviewer/verify", async (req, reply) => {
    const parsed = VerifySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return verifyReviewer(app.services.github, store, {
      token: parsed.data.token,
      repo: await repoFor(app, parsed.data.projectId),
    });
  });
}
