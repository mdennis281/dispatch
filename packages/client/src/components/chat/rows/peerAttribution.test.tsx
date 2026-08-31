/**
 * A `user` row must never wear the speech bubble unless a human typed it.
 *
 * The bubble is not decoration — it is the transcript's only claim about
 * authorship, and a `user` turn is the only input channel a session has. So
 * everything an agent pushes into a chat (`chat_send`, `chat_ask`, the opening
 * prompt of a spawned chat) arrives in the same lane as something the human sat
 * and typed, and renders identically unless this file's rule holds.
 *
 * The version this replaced tried to carry that with badges — a bot avatar and a
 * "from another chat" chip around a body still wearing the bubble. It lost:
 * people read authorship off the bubble, not off the chrome around it.
 *
 * Two shapes, because the second is how the rule broke once already. Memory
 * surfacing appends a `context` part to ANY message, peer ones included, and a
 * peer row that had `parts` went down the composed path — which rendered its
 * `text` part with `SpokenPart`, i.e. the human's bubble, chips and all.
 *
 * Static markup rather than a DOM test: the client's vitest runs in a `node`
 * environment (see `vitest.config.ts`), same as `ui/DispatchMark.test.tsx`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UserMessageRow } from "@dispatch/shared";
import { UserRow } from "./UserRow.js";
import { SPEECH_BUBBLE } from "./ComposedParts.js";

const CHAT = "c1";

const row = (over: Partial<UserMessageRow>): UserMessageRow => ({
  kind: "user",
  id: "u1",
  chatId: CHAT,
  ts: 1_700_000_000_000,
  text: "rebase before you touch the serializer",
  ...over,
});

const render = (r: UserMessageRow): string =>
  renderToStaticMarkup(<UserRow chatId={CHAT} row={r} />);

/** The bubble's own class string, as one token the markup either has or hasn't. */
const bubbled = (html: string): boolean => html.includes(SPEECH_BUBBLE);

describe("user row authorship", () => {
  it("gives the human's own turn the speech bubble", () => {
    const html = render(row({}));
    expect(bubbled(html)).toBe(true);
    expect(html).not.toContain("Another chat");
  });

  it("gives a peer message the card, never the bubble", () => {
    const html = render(
      row({ origin: "peer", peer: { chatId: "c2", title: "Save format v3" } }),
    );
    expect(bubbled(html)).toBe(false);
    expect(html).toContain("Another chat");
    expect(html).toContain("Sent you a message");
    // The row is still attributed to the sender by name, and still says the
    // words came from somewhere else.
    expect(html).toContain("Save format v3");
    expect(html).toContain("from another chat");
  });

  it("says a peer ask was a question, without claiming anyone is still waiting", () => {
    const html = render(
      row({
        origin: "peer",
        peer: { chatId: "c2", title: "Save format v3", askId: "ask_7f3a" },
      }),
    );
    expect(bubbled(html)).toBe(false);
    expect(html).toContain("Asked you a question");
    expect(html).not.toContain("awaiting");
  });

  it("keeps the card when memory surfacing gives a peer row `parts`", () => {
    const html = render(
      row({
        origin: "peer",
        peer: { chatId: "c2", title: "Save format v3" },
        parts: [
          { kind: "text", text: "rebase before you touch the serializer" },
          { kind: "context", label: "2 memories surfaced", text: "…" },
        ],
      }),
    );
    expect(bubbled(html)).toBe(false);
    expect(html).toContain("Sent you a message");
  });

  it("still refuses the bubble when the sender is unknown", () => {
    // `peer` is optional on the schema. A row that says "peer" with no sender
    // must degrade to an unattributed card, not back to the human's voice.
    const html = render(row({ origin: "peer" }));
    expect(bubbled(html)).toBe(false);
    expect(html).toContain("Another chat");
  });
});
