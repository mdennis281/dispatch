import { ArrowUpRight } from "lucide-react";
import { parseTitleMarks, type Chat } from "@dispatch/shared";
import { Button } from "../../ui/Button.js";
import { StatusDot, statusMeta } from "../../ui/StatusDot.js";
import { TitleText } from "../../ui/TitleText.js";
import { cn } from "../../../lib/cn.js";
import { relTime } from "../../../lib/format.js";
import { useChats } from "../../../stores/chats.js";
import { useProjects } from "../../../stores/projects.js";
import { selectChat } from "../../../stores/navigation.js";

/** A title with its `**bold**` runs flattened, for a tooltip or a mono preview line. */
export function plainTitle(title: string): string {
  return parseTitleMarks(title)
    .map((seg) => seg.text)
    .join("");
}

/** The chat a peer tool named, as the store knows it — or nothing, for an id it has never seen. */
export function usePeerChat(chatId: string | undefined): Chat | undefined {
  return useChats((s) => (chatId ? s.byId[chatId] : undefined));
}

export function usePeerChatProjectName(chat: Chat | undefined): string | undefined {
  return useProjects((s) => (chat ? s.projects.find((p) => p.id === chat.projectId)?.name : undefined));
}

/**
 * The other chat a peer tool is talking to, as a thing you can recognise and
 * open: its live status dot and its title, not the id the model passed.
 *
 * The id is what the TOOL needs and it is the one thing the reader cannot use —
 * `y-v9hYABfa68XeML6QYmT` says nothing about which of the six chats in the
 * sidebar is being waited on. Clicking opens the chat (through `selectChat`, so
 * a chat in another project brings its project along), which is the question
 * every one of these cards raises: "what is that chat doing right now?"
 *
 * An id the store has never seen — a chat since deleted, another instance's
 * data dir, a fixture — still shows the id in mono, unlinked, so the card says
 * exactly what the tool said rather than nothing.
 */
export function PeerChatRef({
  chatId,
  className,
  size = "sm",
  compact = false,
}: {
  chatId: string;
  className?: string;
  /** `sm` fits a card header; `md` is the modal's identity row. */
  size?: "sm" | "md";
  /**
   * Dot and arrow only, title in the tooltip — for a terminal-frame row whose
   * one line of text already names the chat and has no room to say it twice.
   */
  compact?: boolean;
}) {
  const chat = usePeerChat(chatId);
  if (!chat && compact) return null;
  if (!chat) {
    return (
      <span
        className={cn("inline-flex min-w-0 items-center gap-1.5 cm-mono !text-2xs text-faint", className)}
        title="This chat is not in the sidebar — it may have been deleted."
      >
        <StatusDot tone="muted" size={6} />
        <span className="truncate">{chatId}</span>
      </span>
    );
  }
  const meta = statusMeta(chat.status);
  return (
    <Button
      type="button"
      variant="subtle"
      size={size}
      onClick={(e) => {
        // The card's rows are themselves buttons that open the inspector; a
        // click here means "take me to that chat", not "show me the JSON".
        e.stopPropagation();
        selectChat(chat.id);
      }}
      title={compact ? `Open ${plainTitle(chat.title)} · ${meta.label}` : `Open chat · ${meta.label}`}
      className={cn(
        "min-w-0 max-w-full justify-start gap-1.5 !font-medium",
        size === "sm" ? "px-1.5 !text-2xs" : "px-2",
        compact && "!gap-1 !px-1",
        className,
      )}
      rightIcon={<ArrowUpRight className="text-faint" />}
    >
      <StatusDot tone={meta.tone} pulse={meta.pulse} size={size === "sm" ? 6 : 7} />
      {!compact && <TitleText title={chat.title} className="min-w-0 truncate" />}
    </Button>
  );
}

/**
 * The inspector's identity row for the chat a peer call is about: what it is
 * called, where it lives, what it is doing right now, and a button that takes
 * you there. The inspector used to lead with the raw id twice (header and
 * arguments) and give the reader nowhere to go with it.
 */
export function PeerChatPanel({ chatId }: { chatId: string }) {
  const chat = usePeerChat(chatId);
  const projectName = usePeerChatProjectName(chat);
  if (!chat) {
    return (
      <section className="flex items-center gap-3 rounded-md border border-line bg-inset px-3 py-2.5">
        <StatusDot tone="muted" size={8} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-secondary">Unknown chat</div>
          <div className="mt-px truncate cm-mono !text-2xs text-faint">{chatId}</div>
        </div>
        <span className="text-2xs text-faint">Not in the sidebar — it may have been deleted.</span>
      </section>
    );
  }
  const meta = statusMeta(chat.status);
  const facts = [projectName, meta.label, chat.updatedAt ? `active ${relTime(chat.updatedAt)}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className="flex items-center gap-3 rounded-md border border-line bg-inset px-3 py-2.5">
      <StatusDot tone={meta.tone} pulse={meta.pulse} size={8} />
      <div className="min-w-0 flex-1">
        <TitleText title={chat.title} className="block truncate text-sm font-semibold text-primary" />
        <div className="mt-px flex min-w-0 items-center gap-1.5 text-2xs text-muted">
          <span className="truncate">{facts}</span>
          <span className="shrink-0 cm-mono text-faint">{chat.id}</span>
        </div>
      </div>
      <Button
        type="button"
        variant="default"
        size="sm"
        onClick={() => selectChat(chat.id)}
        rightIcon={<ArrowUpRight />}
        className="shrink-0"
      >
        Open chat
      </Button>
    </section>
  );
}
