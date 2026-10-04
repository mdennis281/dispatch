import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMessage, PermissionRequest } from "@dispatch/shared";

const messages = vi.fn<(chatId: string) => Promise<ChatMessage[]>>();
const pendingPermissions = vi.fn<() => Promise<PermissionRequest[]>>();

/**
 * `ApiError` is part of the module's CONTRACT, not incidental: the retry policy
 * asks `err instanceof ApiError` to tell a considered 404 from a server falling
 * over. A factory mock replaces the module wholesale, so leaving it out makes
 * that check `instanceof undefined` — a TypeError inside the catch block, which
 * would turn every retryable failure into a different failure.
 */
class MockApiError extends Error {
  constructor(public status: number, message = "api error") {
    super(message);
    this.name = "ApiError";
  }
}

vi.mock("../lib/api.js", () => ({
  ApiError: MockApiError,
  api: {
    chats: {
      messages: (chatId: string) => messages(chatId),
      checkpoints: () => Promise.resolve([]),
    },
    attention: { pendingPermissions: () => pendingPermissions() },
  },
}));

const { ensureChatMessages, reloadChatMessages } = await import("./index.js");
const { useMessages } = await import("./messages.js");

const request = (id: string, chatId: string): PermissionRequest => ({
  id,
  chatId,
  toolName: "spawn_chat",
  input: {},
  title: "Start a new chat?",
  createdAt: 1,
});

const permissionRows = (chatId: string) =>
  (useMessages.getState().byChat[chatId] ?? []).filter((r) => r.kind === "permission");

// `ensureChatMessages` keeps its "already loaded" set and LRU in MODULE state,
// which no store reset clears — so every test uses chat ids of its own rather
// than pretending the seam is fresh.
beforeEach(() => {
  messages.mockReset().mockResolvedValue([]);
  pendingPermissions.mockReset().mockResolvedValue([]);
  useMessages.setState({ byChat: {}, pages: {}, streaming: {} });
});

/**
 * A pending permission card exists ONLY in the client's store — the server
 * persists the `permission` row when it RESOLVES, not when it's raised. So every
 * path that rebuilds a transcript from the REST snapshot has to put open cards
 * back. Reconnect always did; opening a chat did not, and the transcript cache is
 * a 3-chat LRU, so on a busy sidebar that is the common path. The symptom is a
 * chat reading "Awaiting input" with a spinning tool card, no card to answer, and
 * a tool blocked until the session is killed.
 */
describe("ensureChatMessages — open permission cards survive a transcript (re)load", () => {
  it("restores a still-open card for a chat opened for the first time", async () => {
    pendingPermissions.mockResolvedValue([request("req-a", "a1")]);

    await ensureChatMessages("a1");
    await vi.waitFor(() => expect(permissionRows("a1")).toHaveLength(1));

    expect(permissionRows("a1")[0]).toMatchObject({
      requestId: "req-a",
      decision: "pending",
      toolName: "spawn_chat",
    });
  });

  it("restores it again after the chat was evicted and re-opened", async () => {
    pendingPermissions.mockResolvedValue([request("req-b", "b1")]);
    await ensureChatMessages("b1");
    await vi.waitFor(() => expect(permissionRows("b1")).toHaveLength(1));

    // The LRU holds 3 transcripts, so a third further open evicts b1's window.
    for (const id of ["b2", "b3", "b4"]) await ensureChatMessages(id);
    expect(useMessages.getState().byChat["b1"]).toBeUndefined();

    await ensureChatMessages("b1");
    await vi.waitFor(() => expect(permissionRows("b1")).toHaveLength(1));
  });

  it("only restores the opened chat's cards, not every blocked chat's", async () => {
    pendingPermissions.mockResolvedValue([request("req-c", "c1"), request("req-c2", "c-other")]);

    await ensureChatMessages("c1");
    await vi.waitFor(() => expect(permissionRows("c1")).toHaveLength(1));

    expect(useMessages.getState().byChat["c-other"]).toBeUndefined();
  });

  it("does not stack a duplicate when the live event already synthesized the card", async () => {
    pendingPermissions.mockResolvedValue([request("req-d", "d1")]);
    useMessages.getState().upsertPermissionRequest("d1", request("req-d", "d1"));

    await ensureChatMessages("d1");
    await vi.waitFor(() => expect(pendingPermissions).toHaveBeenCalled());

    expect(permissionRows("d1")).toHaveLength(1);
  });

  it("still loads the transcript when the pending-permission snapshot fails", async () => {
    messages.mockResolvedValue([
      { kind: "assistant", id: "m1", chatId: "e1", ts: 1, text: "hi" },
    ]);
    pendingPermissions.mockRejectedValue(new Error("offline"));

    await expect(ensureChatMessages("e1")).resolves.toBeUndefined();
    expect(useMessages.getState().byChat["e1"]).toHaveLength(1);
  });
});

/**
 * The failure the user actually reported: on a loaded machine, opening a chat
 * showed "No messages yet" — or just the newest message or two once live rows
 * started arriving — for a chat with a long history sitting on disk.
 *
 * The transcript GET had failed. Nothing retried it, and `byChat[id] ===
 * undefined` reads identically whether the chat is empty, still loading, or
 * failed, so the UI picked the most alarming of the three and presented it as
 * fact. These pin both halves: the retry, and the state that stops a failure
 * from impersonating an empty chat.
 */
describe("ensureChatMessages — a failed transcript load is not an empty chat", () => {
  const page = (chatId: string) => useMessages.getState().pages[chatId];
  const row = (chatId: string) => ({
    kind: "assistant" as const,
    id: "m1",
    chatId,
    ts: 1,
    text: "a long history",
  });

  it("retries a 500 and succeeds without the caller ever seeing it", async () => {
    messages
      .mockRejectedValueOnce(new MockApiError(500, "boom"))
      .mockResolvedValueOnce([row("r1")]);

    await ensureChatMessages("r1");

    expect(messages).toHaveBeenCalledTimes(2);
    expect(useMessages.getState().byChat["r1"]).toHaveLength(1);
    expect(page("r1")?.load).toBe("ready");
  });

  it("retries a bare network rejection — the stalled-loop case", async () => {
    // Not an ApiError at all: the request never got an answer. This is what a
    // request lost behind a multi-second event-loop stall looks like from here.
    messages
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce([row("r2")]);

    await ensureChatMessages("r2");

    expect(messages).toHaveBeenCalledTimes(3);
    expect(page("r2")?.load).toBe("ready");
  });

  it("marks the chat FAILED once the retries are spent", async () => {
    messages.mockRejectedValue(new MockApiError(500, "still down"));

    await ensureChatMessages("r3");

    expect(messages).toHaveBeenCalledTimes(3);
    // The decisive assertion. `failed` is what makes the view render "Couldn't
    // load the transcript" with a retry, instead of "No messages yet".
    expect(page("r3")?.load).toBe("failed");
    expect(useMessages.getState().byChat["r3"]).toBeUndefined();
  });

  it("does NOT retry a 404 — a deleted chat says the same thing three times", async () => {
    messages.mockRejectedValue(new MockApiError(404, "no such chat"));

    await ensureChatMessages("r4");

    // One attempt. Retrying would put a second of backoff in front of an answer
    // the server already gave definitively.
    expect(messages).toHaveBeenCalledTimes(1);
    expect(page("r4")?.load).toBe("failed");
  });

  it("reports `loading` while the request is in flight", async () => {
    let release!: (rows: never[]) => void;
    messages.mockReturnValueOnce(new Promise((r) => (release = r as never)));

    const inFlight = ensureChatMessages("r5");
    await vi.waitFor(() => expect(page("r5")?.load).toBe("loading"));

    release([]);
    await inFlight;
    expect(page("r5")?.load).toBe("ready");
  });

  it("reloadChatMessages re-fetches a chat the loader already marked done", async () => {
    messages.mockRejectedValue(new MockApiError(500, "down"));
    await ensureChatMessages("r6");
    expect(page("r6")?.load).toBe("failed");

    messages.mockReset().mockResolvedValue([row("r6")]);
    await reloadChatMessages("r6");

    // Without clearing the "already loaded" mark this returns instantly and the
    // Retry button is decorative.
    expect(messages).toHaveBeenCalledTimes(1);
    expect(page("r6")?.load).toBe("ready");
    expect(useMessages.getState().byChat["r6"]).toHaveLength(1);
  });

  it("a genuinely empty chat is still `ready`, not `failed`", async () => {
    messages.mockResolvedValue([]);
    await ensureChatMessages("r7");
    // The state the empty view is actually allowed to render.
    expect(page("r7")?.load).toBe("ready");
  });
});
