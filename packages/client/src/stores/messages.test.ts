import { describe, it, expect, beforeEach } from "vitest";
import type { ChatMessage } from "@cm/shared";
import { useMessages } from "./messages.js";

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
