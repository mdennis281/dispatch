import { describe, it, expect } from "vitest";
import { branchProcessCount, branchChatIds } from "./chatProcesses.js";

const under = [{ id: "review-1" }, { id: "review-2" }];

const t = (session: number, shells = 0) => ({ session, shells });

describe("branchProcessCount", () => {
  it("adds the reviewer chats' processes to the row that folds them", () => {
    // The number on a collapsed row has to speak for the whole branch — five
    // trees behind one row is exactly the case that made the counter worth
    // having, and a row that showed only its own would under-report it.
    expect(
      branchProcessCount(
        { "chat-a": t(9), "review-1": t(3), "review-2": t(2) },
        "chat-a",
        under,
      ),
    ).toEqual(t(14));
  });

  it("keeps shells and session processes APART while summing a branch", () => {
    // They are summed separately because they have different lifetimes: the
    // session half is swept once the chat goes idle, the shells half never is.
    expect(
      branchProcessCount({ "chat-a": t(9, 2), "review-1": t(3, 1) }, "chat-a", under),
    ).toEqual({ session: 12, shells: 3 });
  });

  it("counts a chat with no reviewers as itself", () => {
    expect(branchProcessCount({ "chat-a": t(9, 1) }, "chat-a", [])).toEqual(t(9, 1));
  });

  it("treats an absent chat as zero rather than NaN", () => {
    // The server omits a chat holding nothing, so absence is the COMMON case
    // here, not an error one.
    expect(branchProcessCount({}, "chat-a", under)).toEqual(t(0));
    expect(branchProcessCount({ "review-1": t(3) }, "chat-a", under)).toEqual(t(3));
  });
});

describe("branchChatIds", () => {
  it("names every chat the count covered, so the kill reaps all of it", () => {
    expect(branchChatIds("chat-a", under)).toEqual(["chat-a", "review-1", "review-2"]);
  });

  it("is just the chat when nothing is folded under it", () => {
    expect(branchChatIds("chat-a", [])).toEqual(["chat-a"]);
  });
});
