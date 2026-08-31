/**
 * The card a `user` row uses for words the human did NOT type.
 *
 * A user turn is the only input channel a session has, so everything that
 * reaches an agent — the app's own briefing, a message another chat sent —
 * arrives in the same lane as something the human sat and typed. The speech
 * bubble is the single strongest "you said this" signal in the transcript, and
 * handing it to text nobody typed is the one lie this file exists to prevent.
 *
 * ONE card for both authorships, not two. "Dispatch wrote this" and "another
 * chat wrote this" are the same claim to a reader — *somebody who is not you put
 * these words in your chat* — and two card designs for one claim would be read
 * as two different voices. What has to be unmistakable is card-vs-bubble; the
 * colour is all that separates the two authors.
 *
 * The shape is load-bearing:
 *   - FULL WIDTH, left-aligned inside a right-aligned row. The asymmetry is the
 *     signal that this half of the turn is not speech from the person the row
 *     is attributed to.
 *   - A header that names the author and the recipient (`from → to`), because
 *     the transcript is the only place that attribution can ever be seen.
 *   - Markdown-rendered, because these bodies ARE markdown — the headings, rule
 *     lists and paths are exactly what you're scanning for, and a wall of
 *     asterisks would defeat reading it at all.
 *   - Nothing borrowed from the assistant's styling either. Neither the app nor
 *     a peer chat may read as the model talking.
 */
import { useState, type ReactNode } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Copy, Send } from "lucide-react";
import type { HarnessKind, MessagePart, PeerSender } from "@dispatch/shared";
import { Markdown } from "../Markdown.js";
import { cn } from "../../../lib/cn.js";
import { useChats } from "../../../stores/chats.js";
import { rowHarnessLabel } from "../../../lib/harness.js";

/** Compact size note for a block, so "how much was injected" is visible. */
export function sizeNote(text: string): string {
  const chars = text.length;
  return chars >= 1_000 ? `${(chars / 1_000).toFixed(1)}k chars` : `${chars} chars`;
}

/** Clipboard copy with a two-second "copied" acknowledgement. */
function CopyButton({ text, title }: { text: string; title: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 2_000);
        });
      }}
      className="rounded-[4px] p-1 text-faint transition-colors hover:bg-active hover:text-secondary [&_svg]:size-3"
    >
      {done ? <Check className="text-accent" /> : <Copy />}
    </button>
  );
}

/**
 * Who is speaking. `app` is Dispatch itself, `peer` is another chat.
 *
 * Written out as whole class strings rather than composed from a colour name:
 * Tailwind scans source text, so `border-accent-${v}-line` compiles to nothing.
 */
const VOICE = {
  app: {
    frame: "border-accent-line/60 bg-accent-ghost/40",
    // A hairline of accent along the top edge, so the card reads as "not the
    // human" at a glance from across the transcript.
    edge: "shadow-[inset_0_1px_0_0_var(--p-accent-line)]",
    tag: "text-accent",
    rule: "border-accent-line/40",
  },
  peer: {
    frame: "border-accent-2-line/60 bg-accent-2-ghost/40",
    edge: "shadow-[inset_0_1px_0_0_var(--p-accent-2-line)]",
    tag: "text-accent-2-hi",
    rule: "border-accent-2-line/40",
  },
} as const;

export type AuthoredVoice = keyof typeof VOICE;

export function AuthoredCard({
  voice,
  icon,
  from,
  to,
  label,
  text,
  copyTitle,
  defaultOpen = true,
}: {
  voice: AuthoredVoice;
  icon: ReactNode;
  /** Who wrote it — the uppercase system tag, so keep it short and fixed. */
  from: string;
  /** Who it was sent TO: the provider running this chat. */
  to: string;
  /** Prose subtitle: what this particular card is. */
  label: string;
  text: string;
  copyTitle: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const v = VOICE[voice];
  return (
    <div className="mt-2 w-full text-left first:mt-0">
      <div className={cn("overflow-hidden rounded-lg border", v.frame, v.edge)}>
        {/* The toggle and the copy button are siblings, not nested: a button
            inside a button is invalid and swallows the inner click. */}
        <div className="flex items-center gap-1 pr-1.5">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-hover [&_svg]:size-3"
          >
            <span className="text-faint">{open ? <ChevronDown /> : <ChevronRight />}</span>
            <span className={cn("shrink-0", v.tag)}>{icon}</span>
            <span
              className={cn(
                "shrink-0 text-2xs font-semibold uppercase tracking-[0.07em]",
                v.tag,
              )}
            >
              {from} → {to}
            </span>
            <span className="min-w-0 truncate text-xs text-muted" title={label}>
              {label}
            </span>
            <span className="ml-auto shrink-0 cm-mono !text-2xs text-faint">
              {sizeNote(text)}
            </span>
          </button>
          <CopyButton text={text} title={copyTitle} />
        </div>
        {open && (
          <div className={cn("border-t bg-panel-2/50 px-3 py-2", v.rule)}>
            <Markdown className="!text-sm !text-secondary">{text}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The app's briefing, as a card that says so.
 *
 * Open by default: the first thing you want on a launched chat is to check what
 * it was actually told, and a collapsed brief makes the transcript start with
 * your own sentence floating free of the rules it was sent under. Collapsing is
 * one click for when you've read it and want the chat back.
 */
export function BriefCard({ part, provider }: { part: MessagePart; provider: string }) {
  return (
    <AuthoredCard
      voice="app"
      icon={<Send />}
      from="Dispatch"
      to={provider}
      label={part.label ?? "Instructions sent for you"}
      text={part.text}
      copyTitle="Copy the text Dispatch sent"
    />
  );
}

/**
 * A message another chat sent (`chat_send` / `chat_ask`).
 *
 * The tag is the fixed words ANOTHER CHAT rather than the sender's name: the
 * name is already the row's `who`, and it's prose, so shouting it in an
 * uppercase system tag reads as a title rather than as the marker it needs to
 * be. What the tag has to establish is the category — not human — and that is
 * the same sentence for every sender.
 *
 * `askId` decides the subtitle only. It says what this message IS, not what is
 * happening now: transcripts are append-only and nothing rewrites `askId` when
 * the ask resolves, so "awaiting reply" here would go on insisting somebody is
 * blocked long after they answered.
 */
export function PeerCard({
  text,
  peer,
  harness,
  chatId,
}: {
  text: string;
  peer: PeerSender | undefined;
  /** The provider this turn was sent TO, from its own row (see MessageBase). */
  harness: HarnessKind | undefined;
  chatId: string;
}) {
  const provider = rowHarnessLabel(harness, useChats((s) => s.byId[chatId]?.harness));
  return (
    <AuthoredCard
      voice="peer"
      icon={<Bot />}
      from="Another chat"
      to={provider}
      label={peer?.askId ? "Asked you a question" : "Sent you a message"}
      text={text}
      copyTitle="Copy the message the other chat sent"
    />
  );
}
