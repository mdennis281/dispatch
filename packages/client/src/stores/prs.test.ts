import { describe, it, expect, beforeEach } from "vitest";
import type { PrRecord } from "@dispatch/shared";
import { usePrs, selectPrs } from "./prs.js";

function rec(over: Partial<PrRecord> & Pick<PrRecord, "key">): PrRecord {
  return {
    repo: "octo/repo",
    number: 42,
    url: "https://github.com/octo/repo/pull/42",
    title: "feat: x",
    branch: "feat/x",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    labels: [],
    hold: false,
    mergeable: null,
    reviewDecision: null,
    reviewers: [],
    threads: [],
    checks: [],
    firstSeenAt: 1,
    lastPolledAt: 1,
    lastChangedAt: 1,
    nextPollAt: 0,
    quietPolls: 0,
    ...over,
  };
}

beforeEach(() => {
  usePrs.setState({ byKey: {} });
});

describe("PR catalog store", () => {
  it("keys by repo#number, so two repos' PR #42 coexist", () => {
    // The hazard that stopped the old project overlay from folding live events
    // in at all: PR numbers restart at 1 per repository.
    usePrs.getState().hydrate([
      rec({ key: "octo/repo#42", repo: "octo/repo" }),
      rec({ key: "other/repo#42", repo: "other/repo", title: "different PR" }),
    ]);
    expect(Object.keys(usePrs.getState().byKey)).toHaveLength(2);
    expect(usePrs.getState().byKey["other/repo#42"]!.title).toBe("different PR");
  });

  it("applies a pr-record-update in place", () => {
    usePrs.getState().hydrate([rec({ key: "octo/repo#42" })]);
    usePrs
      .getState()
      .upsert(rec({ key: "octo/repo#42", reviewDecision: "approved", lastChangedAt: 9 }));
    expect(usePrs.getState().byKey["octo/repo#42"]!.reviewDecision).toBe("approved");
    expect(Object.keys(usePrs.getState().byKey)).toHaveLength(1);
  });

  it("adds a PR it has never seen — a brand-new one needs no refetch", () => {
    usePrs.getState().hydrate([]);
    usePrs.getState().upsert(rec({ key: "octo/repo#7", number: 7 }));
    expect(selectPrs(usePrs.getState())).toHaveLength(1);
  });

  it("orders by last CHANGE, not by number or poll time", () => {
    // What you want at the top is the PR something just happened to.
    usePrs.getState().hydrate([
      rec({ key: "octo/repo#1", number: 1, lastChangedAt: 100, lastPolledAt: 999 }),
      rec({ key: "octo/repo#2", number: 2, lastChangedAt: 300 }),
      rec({ key: "octo/repo#3", number: 3, lastChangedAt: 200 }),
    ]);
    expect(selectPrs(usePrs.getState()).map((p) => p.number)).toEqual([2, 3, 1]);
  });

  it("replaces the whole roster on hydrate, so a reconnect drops stale rows", () => {
    usePrs.getState().hydrate([rec({ key: "octo/repo#42" })]);
    usePrs.getState().hydrate([rec({ key: "octo/repo#43", number: 43 })]);
    expect(Object.keys(usePrs.getState().byKey)).toEqual(["octo/repo#43"]);
  });
});
