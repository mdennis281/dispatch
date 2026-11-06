import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "@dispatch/shared";

vi.mock("../lib/actions.js", () => ({
  actions: { createChat: vi.fn() },
  ensureChatLoaded: vi.fn(),
}));
vi.mock("./navigation.js", () => ({ selectChat: vi.fn() }));

const { actions } = await import("../lib/actions.js");
const { selectChat } = await import("./navigation.js");
const { useChats } = await import("./chats.js");
const { createChatAndFocus, isOurNewChat, usePendingChat, PENDING_CHAT_TIMEOUT_MS } = await import(
  "./pendingChat.js"
);

/** Land a chat in the store the way a `chat-created` event would. */
function arrive(id: string, projectId: string, extra: Partial<Chat> = {}): void {
  const chat = { id, projectId, title: "", createdAt: Date.now(), ...extra } as Chat;
  useChats.setState((s) => ({
    byId: { ...s.byId, [id]: chat },
    order: [id, ...s.order],
  }));
}

const pending = () => usePendingChat.getState().byProject;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(actions.createChat).mockClear();
  vi.mocked(selectChat).mockClear();
  usePendingChat.setState({ byProject: {} });
  useChats.setState({ byId: {}, order: [] });
});
afterEach(() => vi.useRealTimers());

describe("createChatAndFocus", () => {
  it("is pending from the click until the chat lands, then selects it", () => {
    createChatAndFocus({ projectId: "p1" });
    expect(actions.createChat).toHaveBeenCalledTimes(1);
    expect(pending().p1).toBeDefined();

    arrive("c1", "p1");
    expect(pending().p1).toBeUndefined();
    expect(selectChat).toHaveBeenCalledWith("c1");
  });

  it("ignores a chat that lands in another project meanwhile", () => {
    // A spawn_chat elsewhere used to be taken for the one you asked for.
    createChatAndFocus({ projectId: "p1" });
    arrive("other", "p2");
    expect(selectChat).not.toHaveBeenCalled();
    expect(pending().p1).toBeDefined();

    arrive("mine", "p1");
    expect(selectChat).toHaveBeenCalledWith("mine");
  });

  it("refuses a second create for the same project while one is in flight", () => {
    // The double-click that used to make two chats.
    createChatAndFocus({ projectId: "p1" });
    createChatAndFocus({ projectId: "p1" });
    expect(actions.createChat).toHaveBeenCalledTimes(1);

    createChatAndFocus({ projectId: "p2" });
    expect(actions.createChat).toHaveBeenCalledTimes(2);
  });

  it("gives up silently after the timeout and re-enables", () => {
    // No toast: on a dropped socket the create is queued in the ws outbox and
    // lands on reconnect, so "try again" would make a second chat.
    createChatAndFocus({ projectId: "p1" });
    vi.advanceTimersByTime(PENDING_CHAT_TIMEOUT_MS);
    expect(pending().p1).toBeUndefined();

    createChatAndFocus({ projectId: "p1" });
    expect(actions.createChat).toHaveBeenCalledTimes(2);
  });

  it("skips a spawned chat landing in the same project and keeps waiting", () => {
    // Same-project spawn_chat during the wait used to steal the selection.
    createChatAndFocus({ projectId: "p1" });
    arrive("child", "p1", { parentChatId: "someone" });
    arrive("review", "p1", { reviewOf: "pr-1" });
    expect(selectChat).not.toHaveBeenCalled();

    arrive("mine", "p1");
    expect(selectChat).toHaveBeenCalledWith("mine");
  });

  it("skips an old chat that enters the list on reconnect", () => {
    // `hydrate` rebuilds `order`, so an old chat absent from the snapshot is
    // "new" to the list without being new to the world.
    createChatAndFocus({ projectId: "p1" });
    arrive("old", "p1", { createdAt: Date.now() - 3_600_000 });
    expect(selectChat).not.toHaveBeenCalled();
  });
});

describe("isOurNewChat", () => {
  const base = { id: "c", projectId: "p1", title: "", createdAt: 1_000_000 } as Chat;
  it("accepts a plain unstarted chat in the project", () => {
    expect(isOurNewChat(base, "p1", 1_000_000)).toBe(true);
  });
  it("tolerates server clock running behind ours", () => {
    expect(isOurNewChat(base, "p1", 1_000_000 + 30_000)).toBe(true);
  });
  it("rejects a chat that has already been used", () => {
    expect(isOurNewChat({ ...base, sessionId: "s" }, "p1", 1_000_000)).toBe(false);
  });
  it("rejects app-made chats", () => {
    for (const extra of [
      { scheduleId: "x" },
      { purpose: { kind: "x" } },
      { startedBy: { tokenId: "t", name: "bot" } },
    ]) {
      expect(isOurNewChat({ ...base, ...extra } as Chat, "p1", 1_000_000)).toBe(false);
    }
  });
});
