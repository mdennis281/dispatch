/**
 * Every pull request Dispatch is tracking, across every repo.
 *
 * The registry (`stores/prs`) is already cross-project and already live — it
 * hydrates on connect and follows `pr-record-update`, because a PR changes while
 * nobody is looking and the answer has to be here when you arrive. So this card
 * is a sort and a slice over memory: no `gh` call, no endpoint, nothing on the
 * homepage's critical path. That matters more here than anywhere else on the
 * page, since live PR state is the single most expensive thing the app can ask
 * for and is exactly what the first version of this page refused to show for
 * that reason. The registry is the way to have it anyway.
 *
 * Two targets per row, because a PR row has two things you might want: the chat
 * that opened it (the row itself) and the pull request on GitHub (the number,
 * which is a real link). A row that only did one of those would send half the
 * clicks to the wrong place.
 */
import { useMemo, useState } from "react";
import { ExternalLink, GitPullRequest } from "lucide-react";
import type { PrRecord } from "@dispatch/shared";
import { useAllPrs } from "../../stores/prs.js";
import { useChats } from "../../stores/chats.js";
import { useProjects } from "../../stores/projects.js";
import { selectChat } from "../../stores/navigation.js";
import { Card } from "../metrics/chrome.js";
import { Chip, type Tone } from "../ui/Chip.js";
import { TitleLine } from "../ui/TitleText.js";
import { RowButton } from "../ui/RowButton.js";
import { checksVerdict, summarizeChecks } from "../pr/checks.js";
import { relTimeShort } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { prRows } from "./derive.js";

/** Rows before the fold — see `prRows` for why open ones are always among them. */
const SHOWN = 8;

/** How a PR's state reads and colours. `merged` is the good outcome, not `closed`. */
const STATE_TONE: Record<PrRecord["state"], Tone> = {
  open: "accent",
  merged: "success",
  closed: "muted",
};

export function HomePrs() {
  const prs = useAllPrs();
  const [all, setAll] = useState(false);
  const rows = useMemo(() => prRows(prs, all ? prs.length : SHOWN), [prs, all]);
  const open = prs.filter((p) => p.state === "open").length;

  return (
    <Card
      title="Pull requests"
      icon={<GitPullRequest />}
      note={prs.length > 0 ? `${open} open · ${prs.length} tracked` : undefined}
    >
      {prs.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-faint">
          No pull requests tracked yet.
        </p>
      ) : (
        <>
          {rows.map((pr) => (
            <PrRow key={pr.key} pr={pr} />
          ))}
          {!all && prs.length > SHOWN && (
            <RowButton
              onClick={() => setAll(true)}
              className="w-full px-3 py-1.5 text-2xs text-muted hover:bg-hover hover:text-primary"
            >
              Show {prs.length - SHOWN} more
            </RowButton>
          )}
        </>
      )}
    </Card>
  );
}

function PrRow({ pr }: { pr: PrRecord }) {
  const chat = useChats((s) => (pr.chatId ? s.byId[pr.chatId] : undefined));
  const project = useProjects((s) =>
    s.projects.find((p) => p.id === (pr.projectId ?? chat?.projectId)),
  );
  const checks = checksVerdict(summarizeChecks(pr.checks));

  // A DIV with a button inside, not a button wrapping a link: a link nested in a
  // button is invalid and swallows its own clicks — the same reason the sidebar's
  // action tray is a sibling of its row rather than a child.
  return (
    <div
      className={cn(
        "group/pr flex items-center gap-2 px-3 py-1.5 transition-colors",
        chat && "hover:bg-hover",
      )}
    >
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        title={`${pr.repo}#${pr.number} on GitHub`}
        className="flex shrink-0 items-center gap-1 cm-mono !text-2xs text-secondary transition-colors hover:text-accent"
      >
        #{pr.number}
        <ExternalLink className="size-2.5" />
      </a>
      {/* The row's own target is the CHAT that opened it. Unattributed PRs — a
          human's, or one whose chat has been deleted — have nowhere to go, so
          they are a plain row rather than a button that looks clickable and
          isn't. */}
      {chat ? (
        <RowButton
          onClick={() => selectChat(chat.id)}
          title={`Open ${chat.title}`}
          className="min-w-0 flex-1 truncate text-xs text-primary"
        >
          {pr.title || <TitleLine title={chat.title} />}
        </RowButton>
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs text-secondary" title={pr.title}>
          {pr.title || `${pr.repo}#${pr.number}`}
        </span>
      )}
      {pr.isDraft && <Chip tone="muted">draft</Chip>}
      {pr.hold && <Chip tone="warn">hold</Chip>}
      {/* CI only while it still matters. A merged PR's last check run is a fact
          about history, and a column of green on settled rows crowds out the
          open ones it exists to flag. */}
      {pr.state === "open" && checks.tone !== "muted" && (
        <span className={cn("hidden shrink-0 text-2xs sm:block", TONE_TEXT[checks.tone])}>
          {checks.label}
        </span>
      )}
      <Chip tone={STATE_TONE[pr.state]}>{pr.state}</Chip>
      <span className="hidden max-w-[9rem] shrink-0 truncate text-2xs text-faint sm:block">
        {project?.name ?? pr.repo}
      </span>
      <span className="w-7 shrink-0 cm-mono text-right !text-2xs text-faint">
        {relTimeShort(pr.lastChangedAt)}
      </span>
    </div>
  );
}

/**
 * The verdict tones as text colours. Spelled out rather than templated, for the
 * reason `StatusDot`'s table is: Tailwind scans for literal class names, and a
 * `text-${tone}` compiles to no CSS at all.
 */
const TONE_TEXT: Record<"muted" | "danger" | "warn" | "success", string> = {
  muted: "text-faint",
  danger: "text-danger",
  warn: "text-warn",
  success: "text-success",
};
