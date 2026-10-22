/**
 * Rendering a COMPOSED user turn — one where the app wrote most of the words.
 *
 * A launched task sends a long prompt: a briefing the app composed, the human's
 * own sentence, and context nobody typed (surfaced memories, a working-tree
 * snapshot). The transcript used to render all of it as one user bubble, in the
 * human's voice, indistinguishable from something they'd sat and typed. You
 * couldn't find your two lines in it, and it made the app look like it was
 * putting words in your mouth.
 *
 * Three authorships, and deliberately three different visual vocabularies —
 * because the failure mode here is ambiguity about WHO said something, and two
 * things that look alike will be read as the same voice:
 *
 *   - `text` / `instructions` — the human's words. The speech bubble, right
 *     aligned, because they ARE the message. `instructions` adds a quiet label
 *     so you can see which part of a briefing was yours. The one exception is a
 *     row whose whole turn came from another chat: see `peer` below.
 *   - `brief` — the app's words, sent to Claude on your behalf. A full-width
 *     CARD with its own header ("Dispatch → Claude"), markdown-rendered, open by
 *     default — see AuthoredCard, which owns that chrome and the reasoning for
 *     it.
 *   - `context` — words nobody chose to send, attached automatically. One
 *     ellipsised line per part, the faintest thing on the row; the text itself
 *     is a modal away (see SentContext.tsx). It's a disclosure, not a
 *     message, and it's the one part that's hidden by default (see
 *     `useInjectedContext`): present when you go looking, invisible when you're
 *     not.
 */
import { FileText } from "lucide-react";
import type { ChannelSender, HarnessKind, MessagePart, PeerSender } from "@dispatch/shared";
import { cn } from "../../../lib/cn.js";
import { useInjectedContext } from "../../../lib/injectedContext.js";
import { useChats } from "../../../stores/chats.js";
import { rowHarnessLabel } from "../../../lib/harness.js";
import { BriefCard, ChannelCard, PeerCard } from "./AuthoredCard.js";
import { TurnContextLines } from "./SentContext.js";

/* -------------------------------------------------------------------- host */

/**
 * The speech bubble: THE marker that a human typed this, and the reason
 * everything else on a user row is a card instead.
 *
 * One exported string rather than the same classes written out at each of its
 * two call sites (here and UserRow's uncomposed path), because
 * `peerAttribution.test.tsx` asserts on its ABSENCE from a peer row — and a
 * second copy that drifted would leave the test passing while the bubble it was
 * meant to catch rendered from the other one.
 */
export const SPEECH_BUBBLE =
  "inline-block max-w-full rounded-2xl rounded-tr-sm border border-bubble-line bg-bubble px-3 py-1.5 text-left align-top text-base leading-[1.6] text-primary whitespace-pre-wrap";

/** The human's own words — the only part that gets the speech bubble. */
function SpokenPart({ part }: { part: MessagePart }) {
  return (
    <div className="mt-1.5 first:mt-0">
      {part.kind === "instructions" && part.label && (
        <div className="mb-0.5 flex items-center justify-end gap-1 text-2xs font-medium uppercase tracking-[0.07em] text-faint [&_svg]:size-3">
          <FileText />
          {part.label}
        </div>
      )}
      <div className={SPEECH_BUBBLE}>{part.text}</div>
    </div>
  );
}

export function ComposedParts({
  chatId,
  parts,
  harness,
  peer,
  fromPeer,
  channel,
  fromChannel,
}: {
  chatId: string;
  parts: MessagePart[];
  /** The provider this turn was sent TO, from its own row (see MessageBase). */
  harness?: HarnessKind;
  /** The sending chat, when this whole turn arrived from one. */
  peer?: PeerSender;
  /**
   * True when the ROW is `origin: "peer"`. Separate from `peer` because the
   * sender object is optional on the schema, and a row that says "peer" with no
   * sender must still not have its words dressed up as the human's.
   *
   * A peer row reaches this component at all because memory surfacing appends a
   * `context` part to ANY message, peer ones included — which used to hand the
   * other chat's words straight to `SpokenPart`, i.e. the human's speech
   * bubble, the exact attribution failure the peer treatment exists to prevent.
   */
  fromPeer?: boolean;
  /** The sending integration, when this whole turn arrived from one. */
  channel?: ChannelSender;
  /**
   * True when the ROW is `origin: "channel"` — the same trap as `fromPeer`:
   * memory surfacing hands a channel row `parts` too, and without this the
   * integration's words would go to `SpokenPart` and wear the human's bubble.
   */
  fromChannel?: boolean;
}) {
  const injected = useInjectedContext(chatId);
  const provider = rowHarnessLabel(harness, useChats((s) => s.byId[chatId]?.harness));
  // Consecutive `context` parts render as ONE block of one-line entries, so a
  // turn carrying memories and an attachment note reads as a single
  // disclosure — and opens as one modal you can page through.
  const runs: (MessagePart | MessagePart[])[] = [];
  for (const p of parts) {
    if (p.kind !== "context") runs.push(p);
    else if (!injected.show) continue;
    else if (Array.isArray(runs[runs.length - 1])) (runs[runs.length - 1] as MessagePart[]).push(p);
    else runs.push([p]);
  }
  return (
    <div className="flex flex-col items-end">
      {runs.map((part, i) => {
        if (Array.isArray(part)) return <TurnContextLines key={`context:${i}`} parts={part} />;
        const key = `${part.kind}:${i}`;
        if (part.kind === "brief") return <BriefCard key={key} part={part} provider={provider} />;
        if (fromPeer)
          return (
            <PeerCard key={key} chatId={chatId} text={part.text} peer={peer} harness={harness} />
          );
        if (fromChannel)
          return (
            <ChannelCard key={key} chatId={chatId} text={part.text} channel={channel} harness={harness} />
          );
        return <SpokenPart key={key} part={part} />;
      })}
    </div>
  );
}
