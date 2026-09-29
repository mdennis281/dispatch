import {
  Inbox,
  ShieldQuestion,
  MessageCircleQuestion,
  CheckCircle2,
  GitPullRequestArrow,
  ArrowRight,
} from "lucide-react";
import type { AttentionItem } from "@dispatch/shared";
import { Popover } from "../ui/Popover.js";
import { Badge, Chip } from "../ui/Chip.js";
import { StatusDot } from "../ui/StatusDot.js";
import { relTime } from "../../lib/format.js";
import { useAttention } from "../../stores/attention.js";
import { useChats } from "../../stores/chats.js";
import { focusAttentionItem } from "./focus.js";
import { cn } from "../../lib/cn.js";

const KIND_META = {
  permission: {
    icon: ShieldQuestion,
    tone: "warn" as const,
    label: "Permission",
  },
  question: {
    icon: MessageCircleQuestion,
    tone: "accent" as const,
    label: "Question",
  },
  idle: { icon: Inbox, tone: "muted" as const, label: "Idle" },
  done: { icon: CheckCircle2, tone: "success" as const, label: "Done" },
  // A review round landed on a PR this chat owns — see AttentionItemSchema.
  review: {
    icon: GitPullRequestArrow,
    tone: "accent" as const,
    label: "Review",
  },
};

function AttentionRow({
  item,
  onGo,
}: {
  item: AttentionItem;
  onGo: () => void;
}) {
  const chatTitle = useChats((s) => s.byId[item.chatId]?.title ?? "Chat");
  const M = KIND_META[item.kind];
  const Icon = M.icon;
  const dotTone =
    item.kind === "permission"
      ? "warn"
      : item.kind === "question" || item.kind === "review"
        ? "accent"
        : item.kind === "done"
          ? "success"
          : "muted";
  return (
    <button
      onClick={onGo}
      className="group flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-active"
    >
      <span
        className={cn(
          "mt-px flex size-6 shrink-0 items-center justify-center rounded-md ring-1 [&_svg]:size-3.5",
          item.kind === "permission"
            ? "bg-warn-ghost text-warn ring-warn/25"
            : item.kind === "question" || item.kind === "review"
              ? "bg-accent-ghost text-accent-hi ring-accent-line"
              : item.kind === "done"
                ? "bg-success-ghost text-success ring-transparent"
                : "bg-panel-2 text-muted ring-line",
        )}
      >
        <Icon />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <StatusDot tone={dotTone} size={5} />
          <span className="truncate text-sm font-medium text-primary">
            {chatTitle}
          </span>
          <span className="cm-mono !text-2xs text-faint">
            {relTime(item.createdAt)}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-secondary">
          {item.summary}
        </span>
      </span>
      <ArrowRight className="mt-1.5 size-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

/**
 * Global cross-chat Attention Queue trigger + triage popover.
 *
 * `variant="icon"` is the same queue with the word dropped: a touch-sized
 * button carrying the inbox glyph and its count pinned to the corner. The
 * labelled pill is a 100px element built for a bar that has room to spell
 * things out; the phone header is a 44px row whose whole right side was empty
 * next to the search icon, and an icon there sits in the icon column it already
 * has rather than opening a sheet to find out whether anything is waiting.
 */
export function AttentionPopover({
  variant = "pill",
}: {
  variant?: "pill" | "icon";
}) {
  const icon = variant === "icon";
  const items = useAttention((s) => s.items);
  const blocking = items.filter(
    (i) => i.kind === "permission" || i.kind === "question",
  ).length;

  return (
    <Popover
      align="end"
      width={340}
      className="p-0"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          aria-expanded={open}
          // The glyph-only trigger has no label to read, so the count goes into
          // the accessible name — "Attention" alone would announce the same
          // whether nothing or nine things were waiting.
          aria-label={
            icon
              ? blocking > 0
                ? `Attention — ${blocking} need you`
                : "Attention"
              : undefined
          }
          className={cn(
            "inline-flex items-center border transition-colors",
            icon
              ? "relative size-8 justify-center rounded-sm [&_svg]:size-4"
              : "h-6 gap-1.5 rounded-md px-2 text-sm font-medium [&_svg]:size-3.5",
            blocking > 0
              ? "border-warn/30 bg-warn-ghost text-warn hover:bg-warn/15"
              : icon
                ? "border-transparent text-secondary hover:bg-active hover:text-primary"
                : "border-line bg-panel-2 text-secondary hover:text-primary",
            open &&
              (icon && blocking === 0
                ? "bg-active text-primary"
                : "border-line-strong"),
          )}
        >
          <Inbox />
          {icon ? (
            // Pinned to the corner rather than sitting beside the glyph: with no
            // label the badge IS the indicator, and at `sm` it annotates the
            // icon instead of covering it.
            <span className="absolute -right-0.5 -top-0.5">
              <Badge count={blocking} tone="warn" size="sm" />
            </span>
          ) : (
            <>
              <span>Attention</span>
              <Badge count={blocking} tone="warn" />
            </>
          )}
        </button>
      )}
    >
      {(close) => (
        <div className="w-full">
          <div className="flex items-center justify-between px-3 py-2.5 cm-hairline-b">
            <span className="text-sm font-semibold text-primary">
              Attention Queue
            </span>
            <Chip tone={blocking > 0 ? "warn" : "muted"}>
              {blocking} need you
            </Chip>
          </div>
          <div className="max-h-[380px] cm-scroll overflow-y-auto p-1.5">
            {items.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-muted">
                Nothing needs you right now.
              </div>
            ) : (
              items.map((item) => (
                <AttentionRow
                  key={item.id}
                  item={item}
                  onGo={() => {
                    focusAttentionItem(item);
                    close();
                  }}
                />
              ))
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}
