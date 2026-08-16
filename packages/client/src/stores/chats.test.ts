import { describe, it, expect, beforeEach } from "vitest";
import type { Chat } from "@dispatch/shared";
import { useChats, chatsForProject } from "./chats.js";

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
