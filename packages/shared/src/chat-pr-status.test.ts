import { describe, expect, it } from "vitest";
import { chatPrStatus, chatPrStatuses, describeChatPr, isUnmerged } from "./chat-pr-status.js";
import { PrRecordSchema, type CheckRun, type PRRef, type PrRecord } from "./domain.js";

const ref: PRRef = { number: 465, url: "https://github.com/o/r/pull/465", branch: "feat/x", repo: "o/r" };

function record(over: Partial<PrRecord> = {}): PrRecord {
  return PrRecordSchema.parse({
    key: "o/r#465",
    repo: "o/r",
    number: 465,
    url: ref.url,
    title: "Find filters",
    branch: "feat/x",
    firstSeenAt: 1,
    lastChangedAt: 1,
    ...over,
  });
}
const check = (status: CheckRun["status"], conclusion?: CheckRun["conclusion"]): CheckRun => ({ name: "ci", status, conclusion });

describe("chatPrStatus", () => {
  it("is honest about what it does not know: no registry row → state from the ref, CI none", () => {
    expect(chatPrStatus(ref)).toEqual({ number: 465, repo: "o/r", url: ref.url, branch: "feat/x", state: "unknown", ci: "none", review: "none" });
    expect(chatPrStatus({ ...ref, state: "merged" }).state).toBe("merged");
  });

  it("prefers the registry row — the ref's state lags until the chat's watcher sees it", () => {
    const pr = chatPrStatus({ ...ref, state: "open" }, record({
      state: "merged",
    }));
    expect(pr.state).toBe("merged");
    expect(pr.title).toBe("Find filters");
  });

  it("rolls up CI, review, open threads and conflicts", () => {
    const pr = chatPrStatus(ref, record({
      checks: [check("completed", "success"), check("completed", "failure"), check("in_progress")],
      reviewDecision: "changes_requested",
      threads: [
        { id: "t1", isResolved: false },
        { id: "t2", isResolved: true },
        { id: "t3", isResolved: false, isOutdated: true },
      ],
      mergeable: false,
      isDraft: true,
    }));
    expect(pr).toMatchObject({
      state: "open",
      ci: "failing",
      checks: { passed: 1, failed: 1, pending: 1 },
      review: "changes_requested",
      unresolvedThreads: 1,
      mergeable: false,
      isDraft: true,
    });
    expect(describeChatPr(pr)).toBe(
      "o/r#465 open (draft) · CI failing (1 of 3 failed) · changes requested · 1 open thread · merge conflicts — Find filters",
    );
    expect(chatPrStatus(ref, record({ checks: [check("completed", "success"), check("completed", "skipped")] })).ci).toBe("passing");
    expect(chatPrStatus(ref, record({ checks: [check("queued")] })).ci).toBe("running");
  });

  it("joins every ref by registry key, and treats only merged/closed as landed", () => {
    const rows = new Map([["o/r#465", record({ state: "closed" })]]);
    const out = chatPrStatuses([ref, { ...ref, number: 466, url: "u" }], (k) => rows.get(k));
    expect(out.map((p) => [p.number, p.state])).toEqual([[465, "closed"], [466, "unknown"]]);
    expect(out.map(isUnmerged)).toEqual([false, true]);
    // A merged PR's line is just its state — CI on a landed PR is noise.
    expect(describeChatPr(chatPrStatus(ref, record({ state: "merged", checks: [check("completed", "failure")] })))).toBe(
      "o/r#465 merged — Find filters",
    );
  });
});
