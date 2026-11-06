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
const { createChatAndFocus, usePendingChat, PENDING_CHAT_TIMEOUT_MS } = await import(
  "./pendingChat.js"
);

/** Land a chat in the store the way a `chat-created` event would. */
function arrive(id: string, projectId: string): void {
  useChats.setState((s) => ({
    byId: { ...s.byId, [id]: { id, projectId } as Chat },
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

  it("an untagged error clears the pending flag at once", () => {
    createChatAndFocus({ projectId: "p1" });
    usePendingChat.getState().clearAll(); // what the `error` reducer does
    expect(pending().p1).toBeUndefined();
  });

  it("still selects the chat if it lands after an unrelated error cleared the flag", () => {
    createChatAndFocus({ projectId: "p1" });
    usePendingChat.getState().clearAll();
    arrive("c1", "p1");
    expect(selectChat).toHaveBeenCalledWith("c1");
  });
});
