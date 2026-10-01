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

/**
 * A registry holding one reviewer row, the CATALOG's idea of the PR, and
 * optionally a different live one — which is the whole point: the row is what
 * the last sweep saw, and `refresh()` is a GitHub poll.
 */
function fakeRegistry(
  state: PrReviewAgentState | null,
  pr: Partial<PrSnapshot>,
  live?: Partial<PrSnapshot> | null,
) {
  let refreshes = 0;
  const row = (over: Partial<PrSnapshot>) =>
    ({ repo: "o/r", number: 7, ...over }) as PrSnapshot;
  const registry = {
    reviewAgent: async () => state,
    snapshot: async () => row(pr),
    refresh: async () => {
      refreshes += 1;
      return live === undefined ? row(pr) : live === null ? null : row(live);
    },
  } as unknown as SessionPrRegistry;
  return { registry, refreshes: () => refreshes };
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
    const { registry } = fakeRegistry(
      { rounds: 1, maxRounds: 1 },
      { additions: 600, deletions: 0 },
    );

    const state = await bind(registry, DYNAMIC).reviewAgent(7, "o/r");

    expect(state).toMatchObject({ rounds: 1, maxRounds: 2 });
  });

  it("lets the cap fall again when the diff shrank", async () => {
    // Not an asymmetry worth adding: a force-push that drops 1,000 lines really
    // has made this a smaller reading job, and the sweep would write the same
    // number on its next pass.
    const { registry } = fakeRegistry(
      { rounds: 1, maxRounds: 4 },
      { additions: 20, deletions: 5 },
    );

    expect(await bind(registry, DYNAMIC).reviewAgent(7, "o/r")).toMatchObject({ maxRounds: 1 });
  });

  it("leaves a row that never recorded a cap alone", async () => {
    // "We don't know" must not become a confident refusal — `roundsSpent` is
    // false without a cap, and inventing one here would flip that.
    const { registry } = fakeRegistry({ rounds: 3 }, { additions: 10, deletions: 0 });

    expect(await bind(registry, DYNAMIC).reviewAgent(7, "o/r")).toEqual({ rounds: 3 });
  });

  it("does not touch the cap under a static policy", async () => {
    const { registry } = fakeRegistry(
      { rounds: 1, maxRounds: 4 },
      { additions: 9000, deletions: 0 },
    );

    expect(await bind(registry, POLICY()).reviewAgent(7, "o/r")).toMatchObject({ maxRounds: 4 });
    // Nor when the session has no reviewer policy at all.
    expect(await bind(registry, undefined).reviewAgent(7, "o/r")).toMatchObject({ maxRounds: 4 });
  });

  it("confirms a SPENT cap against GitHub, because the row's diff size is stale too", async () => {
    // The hole the first pass left: the catalog row is what the last sweep saw,
    // so in the push-then-request window its `additions` are the pre-push ones.
    // Recomputing off them reproduces the old cap exactly and refuses a PR that
    // has just earned another round.
    const { registry, refreshes } = fakeRegistry(
      { rounds: 1, maxRounds: 1 },
      { additions: 400, deletions: 0 }, // catalog: before the push
      { additions: 600, deletions: 0 }, // GitHub: after it
    );

    expect(await bind(registry, DYNAMIC).reviewAgent(7, "o/r")).toMatchObject({ maxRounds: 2 });
    expect(refreshes()).toBe(1);
  });

  it("does not spend a GitHub call when the free answer is not a stop", async () => {
    // `watch_pr` makes this read every 20 seconds. A poll per read would be a
    // poll per 20s per watched PR, for an answer that was already correct.
    const { registry, refreshes } = fakeRegistry(
      { rounds: 1, maxRounds: 4 },
      { additions: 1200, deletions: 0 },
    );

    expect(await bind(registry, DYNAMIC).reviewAgent(7, "o/r")).toMatchObject({ maxRounds: 3 });
    expect(refreshes()).toBe(0);
  });

  it("keeps the stored answer when the refresh fails", async () => {
    // "GitHub was unreadable" is not evidence that the diff grew.
    const { registry } = fakeRegistry(
      { rounds: 1, maxRounds: 1 },
      { additions: 400, deletions: 0 },
      null,
    );

    expect(await bind(registry, DYNAMIC).reviewAgent(7, "o/r")).toMatchObject({ maxRounds: 1 });
  });

  it("counts a per-PR extraRounds grant into the headroom", async () => {
    // The question the poll is gated on is "would this be a STOP" — and a grant
    // raises the effective cap, so a PR sitting on one still has a round left
    // and needs no confirming.
    const { registry, refreshes } = fakeRegistry(
      { rounds: 1, maxRounds: 1, extraRounds: 1 },
      { additions: 400, deletions: 0 },
    );

    await bind(registry, DYNAMIC).reviewAgent(7, "o/r");
    expect(refreshes()).toBe(0);

    // Spend that round too and it IS a stop, grant included — so it is worth a
    // call to find out whether the diff has grown since the last sweep.
    const spent = fakeRegistry(
      { rounds: 2, maxRounds: 1, extraRounds: 1 },
      { additions: 400, deletions: 0 },
    );
    await bind(spent.registry, DYNAMIC).reviewAgent(7, "o/r");
    expect(spent.refreshes()).toBe(1);
  });
});
