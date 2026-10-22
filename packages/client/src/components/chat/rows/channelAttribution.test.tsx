/**
 * A `user` row an INTEGRATION sent must never wear the speech bubble.
 *
 * Modelled on `peerAttribution.test.tsx`, for the third author the transcript
 * can have: a bot behind an integration token, a plugin's `ctx.chats.send`.
 * The row arrives in the same lane as something the human typed — a `user`
 * turn is the only input channel a session has — and the bubble is the
 * transcript's only claim about authorship, so the rule is the same and so is
 * the trap: memory surfacing appends a `context` part to ANY message, and a
 * channel row with `parts` must still take the card path.
 *
 * Static markup, node environment — see the peer test.
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
  text: "deploy is green, ship the release notes",
  ...over,
});

const render = (r: UserMessageRow): string =>
  renderToStaticMarkup(<UserRow chatId={CHAT} row={r} />);

const bubbled = (html: string): boolean => html.includes(SPEECH_BUBBLE);

describe("user row channel authorship", () => {
  it("gives a channel message the card with the integration's name, never the bubble", () => {
    const html = render(row({ origin: "channel", channel: { name: "grok" } }));
    expect(bubbled(html)).toBe(false);
    // The voice is `<NAME> → <provider>`: the tag carries the name…
    expect(html).toContain("grok →");
    expect(html).toContain("Sent from outside Dispatch");
    // …and the row says what kind of thing sent it.
    expect(html).toContain("from an integration");
    // It is not dressed as a peer either: a third author gets its own words.
    expect(html).not.toContain("Another chat");
    expect(html).not.toContain("from another chat");
  });

  it("says a channel ask was a question, without claiming anyone is still waiting", () => {
    const html = render(
      row({ origin: "channel", channel: { name: "grok", askId: "ask_42" } }),
    );
    expect(bubbled(html)).toBe(false);
    expect(html).toContain("Asked a question from outside Dispatch");
    expect(html).not.toContain("awaiting");
  });

  it("keeps the card when memory surfacing gives a channel row `parts`", () => {
    const html = render(
      row({
        origin: "channel",
        channel: { name: "grok" },
        parts: [
          { kind: "text", text: "deploy is green, ship the release notes" },
          { kind: "context", label: "2 memories surfaced", text: "…" },
        ],
      }),
    );
    expect(bubbled(html)).toBe(false);
    expect(html).toContain("grok →");
    expect(html).toContain("Sent from outside Dispatch");
  });

  it("still refuses the bubble when the sender is unknown", () => {
    // `channel` is optional on the schema. A row that says "channel" with no
    // sender must degrade to an unattributed card, not back to the human's voice.
    const html = render(row({ origin: "channel" }));
    expect(bubbled(html)).toBe(false);
    expect(html).toContain("Integration →");
  });

  it("leaves the human's own turn and a peer turn exactly as they were", () => {
    expect(bubbled(render(row({})))).toBe(true);
    const peer = render(row({ origin: "peer", peer: { chatId: "c2", title: "Save format v3" } }));
    expect(bubbled(peer)).toBe(false);
    expect(peer).toContain("Another chat");
    expect(peer).not.toContain("from an integration");
  });
});
