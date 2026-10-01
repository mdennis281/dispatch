/**
 * The reviewer row as the MCP tools READ it.
 *
 * One rule under test, and it is worth its own file because three tools decide
 * "can another review still happen" off this single read — `request_review`'s
 * spent-cap refusal, `watch_pr`'s `reviewsSpent`, and `approve_pr`. Under a
 * `dynamic` round policy the stored cap is a function of a diff that moves, so
 * a read that trusted the row would answer with whatever the last sweep
 * happened to write up to 90 seconds ago.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_REVIEW_ROUNDS, type ResolvedReviewAgent } from "@dispatch/shared";
import type { PrReviewAgentState, PrSnapshot } from "@dispatch/shared";
import {
  makePrRegistryBinding,
  type SessionDirs,
  type SessionPrRegistry,
} from "./session-broker.js";
import type { GitHubService } from "./github.js";

const POLICY = (over: Partial<ResolvedReviewAgent> = {}): ResolvedReviewAgent => ({
  enabled: true,
  identity: "self",
  effort: "high",
  maxRounds: 4,
  rounds: DEFAULT_REVIEW_ROUNDS,
  post: true,
  ...over,
});

const DYNAMIC = POLICY({
  rounds: { mode: "dynamic", base: 1, linesPerRound: 500, max: 8 },
});

/** A registry holding one reviewer row and one PR, with nothing else wired. */
function fakeRegistry(
  state: PrReviewAgentState | null,
  pr: Partial<PrSnapshot>,
): SessionPrRegistry {
  return {
    reviewAgent: async () => state,
    snapshot: async () => ({ repo: "o/r", number: 7, ...pr }) as PrSnapshot,
  } as unknown as SessionPrRegistry;
}

/** The repo resolves straight off the override, so no cwd or `gh` is involved. */
const bind = (registry: SessionPrRegistry, policy: ResolvedReviewAgent | undefined) =>
  makePrRegistryBinding(
    registry,
    {} as GitHubService,
    {} as SessionDirs,
    "c1",
    undefined,
    policy,
  );

describe("the reviewer row, as the MCP tools read it", () => {
  it("reports the cap recomputed from the diff as it is NOW", async () => {
    // The sequence the watcher's own wake() prompt tells an agent to follow:
    // push the fix, then request a review. A push that grows the PR past the
    // next bracket lands inside the sweep's stale window — and read off the row
    // the request is refused `rounds-spent` without ever setting `requestedAt`,
    // so the sweep that raises the denominator has no request left to claim.
    const row = fakeRegistry({ rounds: 1, maxRounds: 1 }, { additions: 600, deletions: 0 });

    const state = await bind(row, DYNAMIC).reviewAgent(7, "o/r");

    expect(state).toMatchObject({ rounds: 1, maxRounds: 2 });
  });

  it("lets the cap fall again when the diff shrank", async () => {
    // Not an asymmetry worth adding: a force-push that drops 1,000 lines really
    // has made this a smaller reading job, and the sweep would write the same
    // number on its next pass.
    const row = fakeRegistry({ rounds: 1, maxRounds: 4 }, { additions: 20, deletions: 5 });

    expect(await bind(row, DYNAMIC).reviewAgent(7, "o/r")).toMatchObject({ maxRounds: 1 });
  });

  it("leaves a row that never recorded a cap alone", async () => {
    // "We don't know" must not become a confident refusal — `roundsSpent` is
    // false without a cap, and inventing one here would flip that.
    const row = fakeRegistry({ rounds: 3 }, { additions: 10, deletions: 0 });

    expect(await bind(row, DYNAMIC).reviewAgent(7, "o/r")).toEqual({ rounds: 3 });
  });

  it("does not touch the cap under a static policy", async () => {
    const row = fakeRegistry({ rounds: 1, maxRounds: 4 }, { additions: 9000, deletions: 0 });

    expect(await bind(row, POLICY()).reviewAgent(7, "o/r")).toMatchObject({ maxRounds: 4 });
    // Nor when the session has no reviewer policy at all.
    expect(await bind(row, undefined).reviewAgent(7, "o/r")).toMatchObject({ maxRounds: 4 });
  });
});
