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
 *     so you can see which part of a briefing was yours.
 *   - `brief` — the app's words, sent to Claude on your behalf. A full-width
 *     CARD with its own header ("Dispatch → Claude"), markdown-rendered, open by
 *     default. Full width and left-aligned inside a right-aligned row: the
 *     asymmetry is the signal that this half of the turn is not speech from the
 *     person the row is attributed to. Nothing about it borrows the assistant's
 *     styling either — an app-authored system message must not read as the model
 *     talking.
 *   - `context` — words nobody chose to send, attached automatically. A single
 *     collapsed line, the faintest thing on the row. It's a disclosure, not a
 *     message, and it's the one part that's hidden by default (see
 *     `useInjectedContext`): present when you go looking, invisible when you're
 *     not.
 */
import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Send,
  Sparkles,
} from "lucide-react";
import type { MessagePart } from "@dispatch/shared";
import { Markdown } from "../Markdown.js";
import { cn } from "../../../lib/cn.js";
import { useInjectedContext } from "../../../lib/injectedContext.js";

/** Compact size note for a block, so "how much was injected" is visible. */
function sizeNote(text: string): string {
  const chars = text.length;
  return chars >= 1_000 ? `${(chars / 1_000).toFixed(1)}k chars` : `${chars} chars`;
}

/** Clipboard copy with a two-second "copied" acknowledgement. */
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title="Copy the text Dispatch sent"
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

/* ------------------------------------------------------------------- brief */

/**
 * The app's briefing, as a card that says so.
 *
 * Open by default: the first thing you want on a launched chat is to check what
 * it was actually told, and a collapsed brief makes the transcript start with
 * your own sentence floating free of the rules it was sent under. Collapsing is
 * one click for when you've read it and want the chat back.
 */
function BriefCard({ part }: { part: MessagePart }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-2 w-full text-left first:mt-0">
      <div
        className={cn(
          "overflow-hidden rounded-lg border border-accent-line/60 bg-accent-ghost/40",
          // A hairline of accent along the top edge, so the card reads as
          // "system" at a glance from across the transcript.
          "shadow-[inset_0_1px_0_0_var(--p-accent-line)]",
        )}
      >
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
            <Send className="shrink-0 text-accent" />
            <span className="shrink-0 text-2xs font-semibold uppercase tracking-[0.07em] text-accent">
              Dispatch → Claude
            </span>
            <span className="min-w-0 truncate text-xs text-muted" title={part.label}>
              {part.label ?? "Instructions sent for you"}
            </span>
            <span className="ml-auto shrink-0 cm-mono !text-2xs text-faint">
              {sizeNote(part.text)}
            </span>
          </button>
          <CopyButton text={part.text} />
        </div>
        {open && (
          <div className="border-t border-accent-line/40 bg-panel-2/50 px-3 py-2">
            {/* Rendered as markdown because it IS markdown — the headings, the
                rule lists and the paths are exactly what you're scanning for,
                and a wall of asterisks would defeat reading it at all. */}
            <Markdown className="!text-sm !text-secondary">{part.text}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

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
      <div className="inline-block max-w-full rounded-2xl rounded-tr-sm border border-bubble-line bg-bubble px-3 py-1.5 text-left align-top text-base leading-[1.6] text-primary whitespace-pre-wrap">
        {part.text}
      </div>
    </div>
  );
}

export function ComposedParts({ chatId, parts }: { chatId: string; parts: MessagePart[] }) {
  const injected = useInjectedContext(chatId);
  const visible = parts.filter((p) => p.kind !== "context" || injected.show);
  return (
    <div className="flex flex-col items-end">
      {visible.map((part, i) => {
        const key = `${part.kind}:${i}`;
        if (part.kind === "brief") return <BriefCard key={key} part={part} />;
        if (part.kind === "context") return <InjectedRow key={key} part={part} />;
        return <SpokenPart key={key} part={part} />;
      })}
    </div>
  );
}
