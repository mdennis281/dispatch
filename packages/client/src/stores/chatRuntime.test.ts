import { describe, it, expect } from "vitest";
import { branchRuntimeMs } from "./chatRuntime.js";

const MIN = 60_000;

describe("branchRuntimeMs", () => {
  it("adds every reviewer's time to the chat's own", () => {
    // A review is agent time the change cost. A row that showed only the
    // author's own number would under-report by however long Dispatch spent
    // reading the diff — which on a four-round PR is most of the total.
    const by = { author: 10 * MIN, r1: 3 * MIN, r2: 2 * MIN, unrelated: 99 * MIN };

    expect(branchRuntimeMs(by, "author", [{ id: "r1" }, { id: "r2" }])).toBe(15 * MIN);
  });

  it("does not invent time for chats the ledger has never seen", () => {
    // Absent is absent, not zero — spans only start at the migration that added
    // them, so most older chats have no reading at all.
    expect(branchRuntimeMs({}, "author", [{ id: "r1" }])).toBe(0);
    expect(branchRuntimeMs({ r1: MIN }, "author", [{ id: "r1" }])).toBe(MIN);
  });

  it("is the chat's own figure when nothing is filed under it", () => {
    expect(branchRuntimeMs({ author: 7 * MIN }, "author", [])).toBe(7 * MIN);
  });
});
