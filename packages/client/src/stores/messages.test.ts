import { describe, it, expect, beforeEach } from "vitest";
import type { ChatMessage } from "@dispatch/shared";
import { useMessages, MAX_WINDOW_ROWS, TRIM_SLACK } from "./messages.js";

const CHAT = "c1";

/** Count the chat's live streaming buffers (what MessageList turns into StreamingRows). */
function streamKeys(chatId = CHAT): string[] {
  const prefix = `${chatId}:`;
  return Object.keys(useMessages.getState().streaming).filter((k) => k.startsWith(prefix));
}

function assistantRow(id: string, text: string): ChatMessage {
  return { kind: "assistant", id, chatId: CHAT, ts: Date.now(), text };
}

function resultRow(id: string): ChatMessage {
  return { kind: "result", id, chatId: CHAT, ts: Date.now(), subtype: "success", isError: false };
}

describe("messages store — streaming buffer pruning (BUG A regression)", () => {
  beforeEach(() => {
    useMessages.setState({ byChat: {}, streaming: {} });
  });

  it("prunes a streamRow when its finalized assistant chat-message arrives (same id)", () => {
    const st = useMessages.getState();
    st.chunk(CHAT, "m1", "Hello, wor", "text");
    expect(streamKeys()).toEqual([`${CHAT}:m1`]);

    // The finalized row lands with the SAME id → its buffer must be dropped.
    st.append(CHAT, assistantRow("m1", "Hello, world"));
    expect(streamKeys()).toEqual([]);
  });

  it("clears ALL of a chat's streamRows on turn end (a `result` row)", () => {
    const st = useMessages.getState();
    // Simulate several assistant messages that streamed but whose finalized rows
    // never landed (interrupt/abort) — the classic 'several stuck bubbles' state.
    st.chunk(CHAT, "m1", "frag one", "text");
    st.chunk(CHAT, "m2", "frag two", "text");
    st.chunk(CHAT, "m3", "frag three", "text");
    expect(streamKeys().sort()).toEqual([`${CHAT}:m1`, `${CHAT}:m2`, `${CHAT}:m3`]);

    st.append(CHAT, resultRow("r1"));
    expect(streamKeys()).toEqual([]);
  });

  it("clearStreaming() drops every buffer for the chat (interrupt/stop/error path)", () => {
    const st = useMessages.getState();
    st.chunk(CHAT, "m1", "partial…", "text");
    st.chunk(CHAT, "m2", "", "thinking");
    st.chunk(CHAT, "m2", "reasoning…", "thinking");
    // A buffer belonging to a DIFFERENT chat must survive.
    st.chunk("other", "x", "keep me", "text");
    expect(streamKeys().length).toBe(2);

    st.clearStreaming(CHAT);
    expect(streamKeys()).toEqual([]);
    expect(streamKeys("other")).toEqual(["other:x"]);
  });

  it("clearStreaming() is identity-stable when there's nothing to drop", () => {
    const before = useMessages.getState().streaming;
    useMessages.getState().clearStreaming(CHAT);
    expect(useMessages.getState().streaming).toBe(before);
  });

  it("does not resurrect a stale buffer: finalize drops one, result clears the rest", () => {
    const st = useMessages.getState();
    st.chunk(CHAT, "m1", "done text", "text");
    st.chunk(CHAT, "m2", "orphan mid-sentence", "text");
    st.append(CHAT, assistantRow("m1", "done text")); // m1 finalizes
    expect(streamKeys()).toEqual([`${CHAT}:m2`]); // m2 still orphaned
    st.append(CHAT, resultRow("r1")); // turn ends
    expect(streamKeys()).toEqual([]); // orphan gone
  });
});

/**
 * The transcript is a WINDOW, not the whole history: the newest page loads on
 * open and older pages prepend as the reader scrolls up. These cover the growth
 * path — the store has to stay correct as a chat gets long, with live rows
 * arriving at the bottom while pages arrive at the top.
 */
describe("messages store — windowed transcript paging", () => {
  const ids = () => (useMessages.getState().byChat[CHAT] ?? []).map((m) => m.id);

  beforeEach(() => {
    useMessages.setState({ byChat: {}, pages: {}, streaming: {} });
  });

  it("setForChat seeds the window + its paging state", () => {
    useMessages.getState().setForChat(CHAT, [assistantRow("m3", "c")], { hasMore: true });
    expect(ids()).toEqual(["m3"]);
    expect(useMessages.getState().pages[CHAT]).toEqual({ hasMore: true, loadingOlder: false });
  });

  it("prepends an older page ABOVE the current window, preserving order", () => {
    const st = useMessages.getState();
    st.setForChat(CHAT, [assistantRow("m3", "c"), assistantRow("m4", "d")], { hasMore: true });
    st.prependForChat(CHAT, [assistantRow("m1", "a"), assistantRow("m2", "b")], {
      hasMore: false,
      loadingOlder: false,
    });
    expect(ids()).toEqual(["m1", "m2", "m3", "m4"]);
    expect(useMessages.getState().pages[CHAT]).toEqual({ hasMore: false, loadingOlder: false });
  });

  it("a double-fired page cannot duplicate rows", () => {
    const st = useMessages.getState();
    st.setForChat(CHAT, [assistantRow("m3", "c")], { hasMore: true });
    const older = [assistantRow("m1", "a"), assistantRow("m2", "b")];
    st.prependForChat(CHAT, older);
    st.prependForChat(CHAT, older); // the sentinel fired twice
    expect(ids()).toEqual(["m1", "m2", "m3"]);
  });

  it("a live message still appends at the bottom while older pages load above", () => {
    const st = useMessages.getState();
    st.setForChat(CHAT, [assistantRow("m5", "e")], { hasMore: true });
    st.append(CHAT, assistantRow("m6", "f")); // agent streams a new row
    st.prependForChat(CHAT, [assistantRow("m4", "d")]); // page lands after
    expect(ids()).toEqual(["m4", "m5", "m6"]);
  });

  it("replaceRows swaps a lean row for its verbatim self, in place", () => {
    const st = useMessages.getState();
    const lean: ChatMessage = {
      kind: "tool_result",
      id: "t1",
      chatId: CHAT,
      ts: 1,
      toolUseId: "u1",
      ok: true,
      content: "clipped…",
      contentOmitted: true,
      contentBytes: 90_000,
    };
    st.setForChat(CHAT, [assistantRow("m1", "a"), lean, assistantRow("m2", "b")]);
    st.replaceRows(CHAT, [{ ...lean, content: "the whole thing", contentOmitted: undefined }]);
    const rows = useMessages.getState().byChat[CHAT]!;
    expect(rows.map((m) => m.id)).toEqual(["m1", "t1", "m2"]); // position kept
    expect(rows[1]).toMatchObject({ content: "the whole thing", contentOmitted: undefined });
  });

  it("replaceRows is identity-stable when nothing matched (no needless re-render)", () => {
    const st = useMessages.getState();
    st.setForChat(CHAT, [assistantRow("m1", "a")]);
    const before = useMessages.getState().byChat;
    st.replaceRows(CHAT, [assistantRow("nope", "x")]);
    expect(useMessages.getState().byChat).toBe(before);
  });

  it("evictExcept drops other chats' windows, pages and streaming buffers", () => {
    const st = useMessages.getState();
    st.setForChat(CHAT, [assistantRow("m1", "a")], { hasMore: true });
    st.setForChat("old", [{ ...assistantRow("m2", "b"), chatId: "old" }], { hasMore: true });
    st.chunk("old", "m9", "half a sentence", "text");
    expect(streamKeys("old")).toHaveLength(1);

    st.evictExcept([CHAT]);
    const after = useMessages.getState();
    expect(Object.keys(after.byChat)).toEqual([CHAT]);
    expect(Object.keys(after.pages)).toEqual([CHAT]);
    expect(streamKeys("old")).toEqual([]);
  });

  it("evictExcept is identity-stable when everything is kept", () => {
    const st = useMessages.getState();
    st.setForChat(CHAT, [assistantRow("m1", "a")]);
    const before = useMessages.getState().byChat;
    st.evictExcept([CHAT]);
    expect(useMessages.getState().byChat).toBe(before);
  });
});

/**
 * The window is bounded on OPEN (a page) and on paging up (a capped chain), but
 * live rows just append — so a chat left open while an agent works used to grow
 * all session until the "windowed" transcript held the whole history again.
 */
describe("messages store — live window trimming", () => {
  const rowsFor = (chatId = CHAT) => useMessages.getState().byChat[chatId] ?? [];

  /** Seed a window of `n` rows via `append`, exactly as a live turn would. */
  function streamRows(n: number, chatId = CHAT): void {
    const st = useMessages.getState();
    for (let i = 0; i < n; i++) {
      st.append(chatId, { ...assistantRow(`m${i}`, `row ${i}`), chatId });
    }
  }

  beforeEach(() => {
    useMessages.setState({ byChat: {}, pages: {}, streaming: {} });
  });

  it("caps a window that grew past the ceiling, keeping the NEWEST rows", () => {
    useMessages.getState().setForChat(CHAT, [], { hasMore: false });
    streamRows(MAX_WINDOW_ROWS + TRIM_SLACK + 1);
    useMessages.getState().trimWindow(CHAT);

    const kept = rowsFor();
    expect(kept).toHaveLength(MAX_WINDOW_ROWS);
    // The tail is what the reader is looking at, so it's what must survive.
    expect(kept.at(-1)!.id).toBe(`m${MAX_WINDOW_ROWS + TRIM_SLACK}`);
    expect(kept[0]!.id).toBe(`m${TRIM_SLACK + 1}`);
  });

  it("flags hasMore after a trim, so the dropped rows stay reachable", () => {
    useMessages.getState().setForChat(CHAT, [], { hasMore: false });
    streamRows(MAX_WINDOW_ROWS + TRIM_SLACK + 1);
    useMessages.getState().trimWindow(CHAT);
    // The chat held its whole history, so `hasMore` was false — trimming is what
    // puts older rows back on the server side of the boundary.
    expect(useMessages.getState().pages[CHAT]).toEqual({ hasMore: true, loadingOlder: false });
  });

  it("is a no-op (identity-stable) inside the slack — no re-slice per append", () => {
    useMessages.getState().setForChat(CHAT, [], { hasMore: false });
    streamRows(MAX_WINDOW_ROWS + TRIM_SLACK);
    const before = useMessages.getState().byChat;
    useMessages.getState().trimWindow(CHAT);
    expect(useMessages.getState().byChat).toBe(before);
  });

  it("leaves other chats' windows alone", () => {
    streamRows(MAX_WINDOW_ROWS + TRIM_SLACK + 1);
    streamRows(5, "other");
    useMessages.getState().trimWindow(CHAT);
    expect(rowsFor("other")).toHaveLength(5);
  });

  it("keeps trimming as the turn goes on (the window stays bounded)", () => {
    useMessages.getState().setForChat(CHAT, [], { hasMore: false });
    // A long agent run: rows keep landing, with a trim after each one.
    for (let i = 0; i < (MAX_WINDOW_ROWS + TRIM_SLACK) * 3; i++) {
      useMessages.getState().append(CHAT, assistantRow(`s${i}`, `row ${i}`));
      useMessages.getState().trimWindow(CHAT);
      expect(rowsFor().length).toBeLessThanOrEqual(MAX_WINDOW_ROWS + TRIM_SLACK);
    }
    expect(rowsFor().at(-1)!.id).toBe(`s${(MAX_WINDOW_ROWS + TRIM_SLACK) * 3 - 1}`);
  });

  it("does nothing for a chat with no window loaded", () => {
    useMessages.getState().trimWindow("never-opened");
    expect(useMessages.getState().byChat["never-opened"]).toBeUndefined();
  });
});
