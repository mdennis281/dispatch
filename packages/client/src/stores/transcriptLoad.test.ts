import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMessage, PermissionRequest } from "@dispatch/shared";

const messages = vi.fn<(chatId: string) => Promise<ChatMessage[]>>();
const pendingPermissions = vi.fn<() => Promise<PermissionRequest[]>>();

vi.mock("../lib/api.js", () => ({
  api: {
    chats: {
      messages: (chatId: string) => messages(chatId),
      checkpoints: () => Promise.resolve([]),
    },
    attention: { pendingPermissions: () => pendingPermissions() },
  },
}));

const { ensureChatMessages } = await import("./index.js");
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
