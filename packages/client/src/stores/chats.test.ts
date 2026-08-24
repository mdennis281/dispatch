import { describe, it, expect, beforeEach } from "vitest";
import { spawnedPurposeLabel, type Chat, type PrRecord } from "@dispatch/shared";
import {
  useChats,
  chatsForProject,
  countProjectAgents,
  buildChatTree,
  reviewTargetKey,
  spawnParentId,
  statusIsActivity,
} from "./chats.js";

function chat(id: string, projectId: string, updatedAt = 1): Chat {
  return {
    id,
    projectId,
    title: `Chat ${id}`,
    modeId: "auto",
    effort: "medium",
    worktrees: [],
    prs: [],
    createdAt: 1,
    updatedAt,
  };
}

const ids = (cs: Chat[]) => cs.map((c) => c.id);

beforeEach(() => {
  useChats.setState({
    byId: {},
    order: [],
    activeChatId: null,
    lastActivity: {},
    activity: {},
    queued: {},
    prSettled: {},
  });
});

describe("chatsForProject", () => {
  it("keeps only the given project's chats, most-recent first", () => {
    const chats = [chat("a", "p1", 10), chat("b", "p2", 99), chat("c", "p1", 50)];
    useChats.getState().hydrate(chats);

    expect(ids(chatsForProject(useChats.getState(), "p1"))).toEqual(["c", "a"]);
  });

  it("returns every chat when no project is given (the picker-less case)", () => {
    useChats.getState().hydrate([chat("a", "p1", 10), chat("b", "p2", 99)]);

    expect(ids(chatsForProject(useChats.getState(), null))).toEqual(["b", "a"]);
  });

  it("sorts by LIVE activity, which outranks the hydrated updatedAt", () => {
    useChats.getState().hydrate([chat("a", "p1", 10), chat("b", "p1", 50)]);
    // "a" starts streaming: it must float above "b" even though it was staler.
    useChats.getState().bumpActivity("a", 900);

    expect(ids(chatsForProject(useChats.getState(), "p1"))).toEqual(["a", "b"]);
  });

  it("falls back to createdAt for a chat that has never been updated", () => {
    const fresh: Chat = { ...chat("new", "p1"), updatedAt: undefined, createdAt: 77 };
    useChats.setState({
      byId: { old: chat("old", "p1", 10), new: fresh },
      order: ["old", "new"],
      lastActivity: {},
    });

    expect(ids(chatsForProject(useChats.getState(), "p1"))).toEqual(["new", "old"]);
  });

  it("is empty for a project with no chats, and for an unknown project id", () => {
    useChats.getState().hydrate([chat("a", "p1")]);

    expect(chatsForProject(useChats.getState(), "p2")).toEqual([]);
    expect(chatsForProject(useChats.getState(), "nope")).toEqual([]);
  });

  it("skips ids in `order` that have no record (a removal mid-flight)", () => {
    useChats.setState({
      byId: { a: chat("a", "p1", 10) },
      order: ["ghost", "a"],
      lastActivity: { a: 10 },
    });

    expect(ids(chatsForProject(useChats.getState(), "p1"))).toEqual(["a"]);
  });
});

describe("removeChat — reselection stays inside the project", () => {
  it("prefers a sibling in the same project", () => {
    useChats.getState().hydrate([chat("a", "p1", 10), chat("b", "p1", 50), chat("c", "p2", 99)]);
    useChats.getState().setActiveChat("b");

    useChats.getState().removeChat("b");

    expect(useChats.getState().activeChatId).toBe("a");
  });

  it("clears the selection rather than opening another project's chat", () => {
    // The old fallback was `order[0]`, which jumped you into p2 with the sidebar
    // still on p1.
    useChats.getState().hydrate([chat("a", "p1", 10), chat("c", "p2", 99)]);
    useChats.getState().setActiveChat("a");

    useChats.getState().removeChat("a");

    expect(useChats.getState().activeChatId).toBeNull();
  });

  it("leaves the selection alone when some OTHER chat is deleted", () => {
    useChats.getState().hydrate([chat("a", "p1", 10), chat("b", "p1", 50)]);
    useChats.getState().setActiveChat("a");

    useChats.getState().removeChat("b");

    expect(useChats.getState().activeChatId).toBe("a");
  });

  it("ignores a chat it has no record of", () => {
    useChats.getState().hydrate([chat("a", "p1")]);
    useChats.getState().setActiveChat("a");

    useChats.getState().removeChat("ghost");

    expect(useChats.getState().activeChatId).toBe("a");
    expect(useChats.getState().order).toEqual(["a"]);
  });
});

describe("setActiveChat", () => {
  it("accepts null for the empty state", () => {
    useChats.getState().hydrate([chat("a", "p1")]);
    useChats.getState().setActiveChat("a");

    useChats.getState().setActiveChat(null);

    expect(useChats.getState().activeChatId).toBeNull();
  });
});

/**
 * `hydrate` runs on every WebSocket reconnect, not just at boot. Taking
 * `order[0]` unconditionally moved the reader to whichever chat held the newest
 * `updatedAt` — and when that lived in another project the transcript unmounted
 * outright, which is what a dropped socket looked like from the user's chair.
 */
describe("hydrate — the reconnect path", () => {
  it("keeps the chat the reader has open instead of jumping to the newest", () => {
    const chats = [chat("a", "p1", 10), chat("b", "p2", 99)];
    useChats.getState().hydrate(chats);
    useChats.getState().setActiveChat("a");

    useChats.getState().hydrate(chats); // reconnect: "b" is still globally newest

    expect(useChats.getState().activeChatId).toBe("a");
  });

  it("still opens the newest chat when nothing was open (first load)", () => {
    useChats.getState().hydrate([chat("a", "p1", 10), chat("b", "p2", 99)]);

    expect(useChats.getState().activeChatId).toBe("b");
  });

  it("falls back to the newest when the open chat is gone from the snapshot", () => {
    useChats.getState().hydrate([chat("a", "p1", 10), chat("b", "p2", 99)]);
    useChats.getState().setActiveChat("a");

    useChats.getState().hydrate([chat("b", "p2", 99)]); // "a" was deleted elsewhere

    expect(useChats.getState().activeChatId).toBe("b");
  });

  it("holds the open chat even as an unrelated one is bumped to the top", () => {
    useChats.getState().hydrate([chat("a", "p1", 10), chat("b", "p2", 20)]);
    useChats.getState().setActiveChat("a");

    // A worktree reconcile stamps `updatedAt` on "b": it re-sorts, "a" stays open.
    useChats.getState().hydrate([chat("a", "p1", 10), chat("b", "p2", 999)]);

    expect(useChats.getState().order).toEqual(["b", "a"]);
    expect(useChats.getState().activeChatId).toBe("a");
  });
});

describe("countProjectAgents", () => {
  const byId = (cs: Chat[]) => Object.fromEntries(cs.map((c) => [c.id, c]));
  const withStatus = (c: Chat, status: Chat["status"], archived?: boolean): Chat => ({
    ...c,
    status,
    archived,
  });

  it("splits working from awaiting-input, per project", () => {
    const counts = countProjectAgents(
      byId([
        withStatus(chat("a", "p1"), "running"),
        withStatus(chat("b", "p1"), "queued"),
        withStatus(chat("c", "p1"), "awaiting-input"),
        withStatus(chat("d", "p2"), "waiting"),
      ]),
    );

    expect(counts).toEqual({
      p1: { working: 2, attention: 1 },
      p2: { working: 1, attention: 0 },
    });
  });

  it("omits projects whose chats are all quiet, archived, or statusless", () => {
    const counts = countProjectAgents(
      byId([
        withStatus(chat("a", "p1"), "idle"),
        withStatus(chat("b", "p1"), "done"),
        withStatus(chat("c", "p1"), "running", true),
        chat("d", "p1"),
      ]),
    );

    expect(counts).toEqual({});
  });
});

describe("buildChatTree — reviewers file under the chat that opened the PR", () => {
  const pr = (key: string, number: number, chatId?: string, reviewChatId?: string): PrRecord =>
    ({
      key,
      number,
      chatId,
      ...(reviewChatId ? { reviewAgent: { chatId: reviewChatId, rounds: 1 } } : {}),
    }) as PrRecord;

  const reviewer = (id: string, key: string, updatedAt = 1): Chat => ({
    ...chat(id, "p1", updatedAt),
    reviewOf: key,
    purpose: { kind: "pr:review" },
  });

  const shape = (bs: ReturnType<typeof buildChatTree>) =>
    bs.map((b) => [b.chat.id, ids(b.children)] as const);

  it("nests every round, not just the one the registry remembers", () => {
    // The bug this exists for: `reviewAgent.chatId` holds ONE round, so three of
    // four reviewers on a four-round PR were unattributable.
    const chats = [
      chat("author", "p1", 100),
      reviewer("r4", "o/r#7", 40),
      reviewer("r3", "o/r#7", 30),
      reviewer("r2", "o/r#7", 20),
      reviewer("r1", "o/r#7", 10),
    ];
    const tree = buildChatTree(chats, {}, { "o/r#7": pr("o/r#7", 7, "author", "r4") });

    expect(shape(tree)).toEqual([["author", ["r4", "r3", "r2", "r1"]]]);
  });

  it("reads a pre-`reviewOf` reviewer's target back out of its purpose label", () => {
    const legacy: Chat = {
      ...chat("legacy", "p1", 5),
      purpose: { kind: "pr:review", label: "Reviewing PR #139 in mdennis281/dispatch" },
    };
    const tree = buildChatTree(
      [chat("author", "p1", 100), legacy],
      {},
      { "mdennis281/dispatch#139": pr("mdennis281/dispatch#139", 139, "author") },
    );

    expect(shape(tree)).toEqual([["author", ["legacy"]]]);
  });

  it("leaves a reviewer at the top level when its parent isn't here", () => {
    // Nesting hides a row inside another row. Hiding one inside a row that
    // doesn't exist would delete it from the sidebar outright.
    const orphan = reviewer("orphan", "o/r#7", 50);
    const unattributed = buildChatTree([chat("a", "p1", 100), orphan], {}, {
      "o/r#7": pr("o/r#7", 7), // nobody in Dispatch opened it
    });
    const deletedParent = buildChatTree([chat("a", "p1", 100), orphan], {}, {
      "o/r#7": pr("o/r#7", 7, "gone"),
    });

    expect(shape(unattributed)).toEqual([["a", []], ["orphan", []]]);
    expect(shape(deletedParent)).toEqual([["a", []], ["orphan", []]]);
  });

  it("ranks a branch by its newest clock, so a live review lifts its parent", () => {
    const chats = [chat("busy", "p1", 500), chat("stale", "p1", 10), reviewer("r", "o/r#7", 900)];
    const tree = buildChatTree(chats, {}, { "o/r#7": pr("o/r#7", 7, "stale") });

    expect(shape(tree)).toEqual([["stale", ["r"]], ["busy", []]]);
  });

  it("prefers the live activity clock over the hydrated one for that rank", () => {
    const chats = [chat("busy", "p1", 500), chat("stale", "p1", 10), reviewer("r", "o/r#7", 20)];
    const tree = buildChatTree(chats, { r: 900 }, { "o/r#7": pr("o/r#7", 7, "stale") });

    expect(shape(tree)).toEqual([["stale", ["r"]], ["busy", []]]);
  });

  it("never files a chat under itself", () => {
    const self = reviewer("self", "o/r#7", 10);
    const tree = buildChatTree([self], {}, { "o/r#7": pr("o/r#7", 7, "self") });

    expect(shape(tree)).toEqual([["self", []]]);
  });
});

describe("buildChatTree — spawned chats file under the chat that spawned them", () => {
  const spawned = (id: string, parentChatId: string, updatedAt = 1): Chat => ({
    ...chat(id, "p1", updatedAt),
    parentChatId,
    purpose: { kind: "spawned", label: spawnedPurposeLabel(parentChatId) },
  });

  const shape = (bs: ReturnType<typeof buildChatTree>) =>
    bs.map((b) => [b.chat.id, ids(b.children)] as const);

  it("nests every chat one parent spawned", () => {
    // The bug this exists for: five chats spawned from one parent sat in the
    // sidebar as five unrelated top-level rows.
    const chats = [
      chat("parent", "p1", 100),
      spawned("s5", "parent", 50),
      spawned("s4", "parent", 40),
      spawned("s3", "parent", 30),
      spawned("s2", "parent", 20),
      spawned("s1", "parent", 10),
    ];

    expect(shape(buildChatTree(chats, {}, {}))).toEqual([
      ["parent", ["s5", "s4", "s3", "s2", "s1"]],
    ]);
  });

  it("reads a pre-`parentChatId` chat's parent back out of its purpose label", () => {
    // The chats already on disk when this shipped carry the parent only in the
    // sentence `container.ts` wrote for the sidebar.
    const legacy: Chat = {
      ...chat("legacy", "p1", 5),
      purpose: { kind: "spawned", label: "Spawned by chat parent" },
    };

    expect(shape(buildChatTree([chat("parent", "p1", 100), legacy], {}, {}))).toEqual([
      ["parent", ["legacy"]],
    ]);
  });

  it("leaves a detached spawn at the top level", () => {
    // `spawn_chat({ detached: true })` declines to write `parentChatId`, and the
    // legacy label parse must not put back what the flag took away.
    //
    // The label here is the one `container.ts` ACTUALLY writes for a detached
    // spawn. An earlier version of this test used `{ kind: "spawned" }` with no
    // label — a shape nothing in the repo produces, since the only writer of
    // that kind always sets one — and so it passed while the real thing nested
    // anyway through the legacy parse.
    const detached: Chat = {
      ...chat("free", "p1", 50),
      purpose: { kind: "spawned", label: spawnedPurposeLabel("parent", true) },
    };

    expect(shape(buildChatTree([chat("parent", "p1", 100), detached], {}, {}))).toEqual([
      ["parent", []],
      ["free", []],
    ]);
  });

  it("does not read a parent out of a label that only starts like the legacy one", () => {
    // Guards the anchor directly: the detached label is the legacy sentence plus
    // a suffix, so an unanchored pattern would match it and silently re-nest
    // every chat that asked not to be nested.
    expect(spawnParentId({ ...chat("x", "p1"), purpose: { kind: "spawned" } } as Chat)).toBeNull();
    expect(
      spawnParentId({
        ...chat("x", "p1"),
        purpose: { kind: "spawned", label: spawnedPurposeLabel("parent", true) },
      } as Chat),
    ).toBeNull();
    expect(
      spawnParentId({
        ...chat("x", "p1"),
        purpose: { kind: "spawned", label: spawnedPurposeLabel("parent") },
      } as Chat),
    ).toBe("parent");
  });

  it("leaves a spawn at the top level when its parent isn't here", () => {
    // Cross-project, or the parent was deleted. Hiding it inside a row that
    // doesn't exist would delete it from the sidebar outright.
    const orphan = spawned("orphan", "elsewhere", 50);

    expect(shape(buildChatTree([chat("a", "p1", 100), orphan], {}, {}))).toEqual([
      ["a", []],
      ["orphan", []],
    ]);
  });

  it("files a grandchild under the grandparent, beside its own parent", () => {
    // A folded chat can spawn too. Nesting is ONE level, so filing the grandchild
    // under a row that is itself hidden would render it nowhere at all.
    const chats = [
      chat("root", "p1", 100),
      spawned("child", "root", 50),
      spawned("grandchild", "child", 60),
    ];

    expect(shape(buildChatTree(chats, {}, {}))).toEqual([
      ["root", ["child", "grandchild"]],
    ]);
  });

  it("keeps both rows visible when two chats claim each other", () => {
    // Corrupt data only, but the failure has no visible symptom: each is the
    // other's child, so both are hidden and the pair vanishes from the sidebar.
    const a = spawned("a", "b", 100);
    const b = spawned("b", "a", 90);

    expect(shape(buildChatTree([a, b], {}, {}))).toEqual([
      ["a", []],
      ["b", []],
    ]);
  });

  it("ranks a branch by a spawned child's clock, so a live child lifts its parent", () => {
    const chats = [chat("busy", "p1", 500), chat("stale", "p1", 10), spawned("s", "stale", 900)];

    expect(shape(buildChatTree(chats, {}, {}))).toEqual([["stale", ["s"]], ["busy", []]]);
  });

  it("folds a reviewer and a spawned chat into the same branch", () => {
    // The two routes are independent — one joins through the PR, one by id —
    // and a chat that opened a PR and then spawned a helper has both.
    const reviewer: Chat = {
      ...chat("r", "p1", 60),
      reviewOf: "o/r#7",
      purpose: { kind: "pr:review" },
    };
    const chats = [chat("parent", "p1", 100), reviewer, spawned("s", "parent", 50)];
    const tree = buildChatTree(chats, {}, {
      "o/r#7": { key: "o/r#7", number: 7, chatId: "parent" } as PrRecord,
    });

    expect(shape(tree)).toEqual([["parent", ["r", "s"]]]);
  });
});

describe("reviewTargetKey", () => {
  it("ignores a purpose label that isn't a review's", () => {
    const spawned: Chat = {
      ...chat("s", "p1"),
      purpose: { kind: "spawned", label: "Reviewing PR #1 in o/r" },
    };
    expect(reviewTargetKey(spawned)).toBeNull();
  });

  it("ignores a review whose label was reworded out from under the parser", () => {
    const odd: Chat = {
      ...chat("s", "p1"),
      purpose: { kind: "pr:review", label: "Reviewing a pull request" },
    };
    expect(reviewTargetKey(odd)).toBeNull();
  });
});

describe("statusIsActivity — which status events may move the row's clock", () => {
  it("refuses the two statuses a teardown produces", () => {
    // The Power button reaps a whole branch through `broker.stop()`, which
    // settles each session to `done`/`idle`. Bumping on those reset the age of
    // every row in the branch to "now" for something the human did TO the chats
    // rather than in them — and the idle sweep did it again on its own timer.
    expect(statusIsActivity("done")).toBe(false);
    expect(statusIsActivity("idle")).toBe(false);
  });

  it("keeps every status that IS news, message behind it or not", () => {
    // `awaiting-input` must not sink while it waits for you, and a failure has
    // to surface even when nothing was written to the transcript.
    for (const status of ["queued", "running", "waiting", "awaiting-input", "failed", "error"] as const) {
      expect(statusIsActivity(status)).toBe(true);
    }
  });
});
