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
 *   - `context` — words nobody chose to send, attached automatically. A single
 *     collapsed line, the faintest thing on the row. It's a disclosure, not a
 *     message, and it's the one part that's hidden by default (see
 *     `useInjectedContext`): present when you go looking, invisible when you're
 *     not.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, Sparkles } from "lucide-react";
import type { HarnessKind, MessagePart, PeerSender } from "@dispatch/shared";
import { cn } from "../../../lib/cn.js";
import { useInjectedContext } from "../../../lib/injectedContext.js";
import { useChats } from "../../../stores/chats.js";
import { rowHarnessLabel } from "../../../lib/harness.js";
import { BriefCard, PeerCard, sizeNote } from "./AuthoredCard.js";

/* ----------------------------------------------------------------- context */

/**
 * Injected context: one collapsed line, honest about its size.
 *
 * Styled unlike a tool call on purpose. A tool call is the MODEL reaching out;
 * this is the app quietly adding to what the model was given, and the two must
 * not be confusable — hence a dashed rule, no tool-call chevron/icon pairing,
 * and an explicit "attached by Dispatch" tag rather than a tool name.
 */
function InjectedRow({ part }: { part: MessagePart }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5 w-full text-left first:mt-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-[5px] border border-dashed border-line-soft",
          "px-2 py-1 text-left text-2xs text-faint transition-colors",
          "hover:border-line hover:bg-hover hover:text-muted [&_svg]:size-3",
        )}
      >
        {open ? <ChevronDown /> : <ChevronRight />}
        <Sparkles className="shrink-0 opacity-70" />
        <span className="shrink-0 uppercase tracking-[0.06em]">attached by Dispatch</span>
        <span className="min-w-0 truncate">{part.label ?? "context"}</span>
        <span className="ml-auto shrink-0 cm-mono !text-2xs opacity-70">
          {sizeNote(part.text)}
        </span>
      </button>
      {open && (
        <pre className="cm-scroll cm-mono mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-dashed border-line-soft bg-inset px-2.5 py-2 !text-2xs leading-[1.5] text-muted">
          {part.text}
        </pre>
      )}
    </div>
  );
}

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
}) {
  const injected = useInjectedContext(chatId);
  const provider = rowHarnessLabel(harness, useChats((s) => s.byId[chatId]?.harness));
  const visible = parts.filter((p) => p.kind !== "context" || injected.show);
  return (
    <div className="flex flex-col items-end">
      {visible.map((part, i) => {
        const key = `${part.kind}:${i}`;
        if (part.kind === "brief") return <BriefCard key={key} part={part} provider={provider} />;
        if (part.kind === "context") return <InjectedRow key={key} part={part} />;
        if (fromPeer)
          return (
            <PeerCard key={key} chatId={chatId} text={part.text} peer={peer} harness={harness} />
          );
        return <SpokenPart key={key} part={part} />;
      })}
    </div>
  );
}
