/**
 * THE HOMEPAGE'S CENTREPIECE — every chat in the install, nested, grouped by
 * what it is doing.
 *
 * ── WHY THIS IS THE PAGE AND THE NUMBERS ARE NOT ─────────────────────────────
 *
 * The first version of this homepage led with a runtime figure, four stat tiles
 * and a grid of sparklines, and the verdict on it was "looks like another
 * metrics page". It was right: what you actually arrive wanting to know is which
 * of the agents running across five repos is stuck waiting on you — a question a
 * tool-call count cannot answer. So the chats come first and the figures are a
 * strip further down.
 *
 * ── WHY IT REUSES THE SIDEBAR'S TREE ─────────────────────────────────────────
 *
 * `useAllChatTree` is `buildChatTree` — the sidebar's own fold — handed the
 * unscoped chat list. Reviewers file under the chat that opened the PR they are
 * reading (via `reviewOf` → `PrRecord.chatId`), spawned chats under the chat
 * that spawned them (`parentChatId`), three levels deep, each with its own
 * glyph. Writing a second builder for this surface would have meant two
 * definitions of "what files under what", and the pair would disagree the first
 * time either one moved.
 *
 * What is NOT reused is the sidebar's ROW. Those rows carry a rename input, a
 * long-press action tray, a process census and a reap button — a working surface
 * for the project you are in. This is a census you came to read, and every row
 * here is a link. Sharing their geometry would have coupled the two for the one
 * thing they genuinely have in common, which is the indent.
 *
 * ── WHY THE GROUP ORDER DIFFERS FROM THE SIDEBAR'S ───────────────────────────
 *
 * The sidebar draws New above Needs input, because a chat you just opened is
 * there to be used or deleted and should stay in your face. Here the order is
 * Needs input, Working, New, Idle: this page is read from the top for what wants
 * attention across the whole install, and an empty chat somebody opened in
 * another repo is not that. The tree's own sort is untouched — the branches are
 * grouped and the groups drawn in this page's order.
 *
 * Idle is capped, because it is unbounded and the rest of the page is below it.
 */
import { useMemo, useState } from "react";
import {
  ChevronRight,
  Globe,
  GitPullRequestArrow,
  MessagesSquare,
} from "lucide-react";
import type { Chat } from "@dispatch/shared";
import { isGlobalProject, GLOBAL_PROJECT_NAME } from "@dispatch/shared";
import {
  chatSection,
  isReviewerChat,
  reviewTargetKey,
  useAllChatTree,
  type ChatBranch,
  type ChatSection,
} from "../../stores/chats.js";
import { usePrs } from "../../stores/prs.js";
import { useProjects } from "../../stores/projects.js";
import { selectChat } from "../../stores/navigation.js";
import { StatusDot, statusMeta, toneText } from "../ui/StatusDot.js";
import { TitleLine } from "../ui/TitleText.js";
import { RowButton } from "../ui/RowButton.js";
import { Card } from "../metrics/chrome.js";
import { relTimeShort } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";

/**
 * The groups, in the order this page reads them — see the module docblock for
 * why it is not `CHAT_SECTIONS`' order.
 */
const GROUPS: { section: ChatSection; label: string }[] = [
  { section: "attention", label: "Needs input" },
  { section: "working", label: "Working" },
  { section: "new", label: "New" },
  { section: "idle", label: "Idle" },
];

/**
 * How many idle branches are drawn before the fold.
 *
 * Idle is the one group with no natural bound — it is every chat that has ever
 * run and finished — and everything else on the page sits underneath it. Eight
 * is about a screen's worth beside the three live groups; the rest are one click
 * away and the button says how many.
 */
const IDLE_SHOWN = 8;

export function HomeChats() {
  const branches = useAllChatTree();
  const [allIdle, setAllIdle] = useState(false);

  const grouped = useMemo(() => {
    const by = new Map<ChatSection, ChatBranch[]>();
    for (const b of branches) {
      const list = by.get(b.section);
      if (list) list.push(b);
      else by.set(b.section, [b]);
    }
    return by;
  }, [branches]);

  // Branches, not chats: a root with four reviewers under it is ONE thing
  // happening, and counting the folded rows would make a busy install look like
  // it had three times the work in flight.
  const live =
    (grouped.get("attention")?.length ?? 0) + (grouped.get("working")?.length ?? 0);

  return (
    <Card
      title="Chats"
      icon={<MessagesSquare />}
      note={
        branches.length === 0
          ? undefined
          : live > 0
            ? `${live} live · ${branches.length} total`
            : `${branches.length} total`
      }
    >
      {branches.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-faint">
          No chats yet. Pick a project below, or start a global chat.
        </p>
      ) : (
        <div>
          {GROUPS.map(({ section, label }) => {
            const all = grouped.get(section) ?? [];
            if (all.length === 0) return null;
            const capped = section === "idle" && !allIdle;
            const shown = capped ? all.slice(0, IDLE_SHOWN) : all;
            return (
              <div key={section}>
                <div className="flex items-center gap-2 bg-panel-2/40 px-3 py-1 cm-hairline-b">
                  <span className="text-2xs font-medium uppercase tracking-wide text-faint">
                    {label}
                  </span>
                  <span className="cm-mono !text-2xs text-faint/70">{all.length}</span>
                </div>
                {shown.map((b) => (
                  <BranchRows key={b.chat.id} branch={b} depth={0} />
                ))}
                {capped && all.length > IDLE_SHOWN && (
                  <RowButton
                    onClick={() => setAllIdle(true)}
                    className="w-full px-3 py-1.5 text-2xs text-muted hover:bg-hover hover:text-primary"
                  >
                    Show {all.length - IDLE_SHOWN} more idle
                  </RowButton>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/**
 * Indent per depth, as LITERALS — Tailwind scans source for literal class
 * candidates, so a `pl-${n}` template compiles to no CSS and the failure mode is
 * a tree with no nesting at all. Same reason `Sidebar.tsx` writes its own three
 * tables longhand, and these are deliberately separate from those: this page is
 * wider than the rail and its rows are not the rail's rows.
 *
 * Read the two together. A row at depth n starts at `ROW_INDENT[n]`; the rail
 * for its children runs down `RAIL_INSET[n]`, which is the centre of that row's
 * own glyph.
 */
const ROW_INDENT = ["pl-3", "pl-8", "pl-[52px]"] as const;
const RAIL_INSET = ["left-[19px]", "left-[43px]"] as const;

const atDepth = <T,>(table: readonly [T, ...T[]], depth: number): T =>
  table[Math.min(Math.max(depth, 0), table.length - 1)] ?? table[0];

/**
 * Is this chat doing something, or blocked on somebody?
 *
 * Read off `chatSection` rather than off `status` directly, so it cannot
 * disagree with the queue the branch was FILED in: `attention` is the one that
 * also covers `failed`/`error`, and a branch filed there for a failure whose
 * failed row stayed folded is the exact thing this predicate prevents.
 */
function isLive(chat: Chat): boolean {
  const section = chatSection(chat);
  return section === "attention" || section === "working";
}

/**
 * A branch and the rows under it.
 *
 * Collapsed by default — except that a branch with anything LIVE inside it opens
 * itself, because a parent filed under "Needs input" for a reviewer two levels
 * down, with that reviewer folded away, is a row pointing at nothing you can
 * see. Same rule the sidebar's `isLive` encodes, stated here in the one line
 * this page needs of it: every row here is a plain link, so there is no fold
 * state to coordinate with anything.
 */
function BranchRows({ branch, depth }: { branch: ChatBranch; depth: number }) {
  const { chat, children, descendants } = branch;
  const [open, setOpen] = useState(() => descendants.some(isLive));

  return (
    <div>
      <div className="relative">
        {children.length > 0 && (
          <RowButton
            aria-expanded={open}
            aria-label={open ? "Hide nested chats" : `Show ${descendants.length} nested chats`}
            title={open ? "Hide nested chats" : `Show ${descendants.length} nested chats`}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "absolute inset-y-0 z-10 flex w-4 items-center justify-center text-muted hover:text-primary [&_svg]:size-2.5",
              depth === 0 ? "left-0" : "left-[14px]",
            )}
          >
            <ChevronRight
              className={cn("transition-transform duration-150", open && "rotate-90")}
            />
          </RowButton>
        )}
        <ChatRow chat={chat} depth={depth} folded={open ? 0 : descendants.length} />
      </div>
      {open && children.length > 0 && (
        <div className="relative">
          {/* Drawn absolutely rather than as a border on a padded wrapper: the
              padding would inset the rows, and a nested row's hover has to reach
              both edges exactly like its parent's. */}
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-y-0 w-px bg-line-soft",
              atDepth(RAIL_INSET, depth),
            )}
          />
          {children.map((c) => (
            <BranchRows key={c.chat.id} branch={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One chat.
 *
 * The columns, left to right: what KIND of chat this is (as a status-toned
 * glyph — the sidebar's vocabulary, `GitPullRequestArrow` for a reviewer, speech
 * bubbles for a spawned chat, a dot for a chat a human opened), its title, what
 * it is doing, its project, and its age.
 *
 * THE PROJECT COLUMN IS WHY THIS PAGE EXISTS. Every row in the sidebar belongs
 * to the project the sidebar is scoped to, so it never has to say which; here
 * two adjacent rows are routinely in different repos, and a cross-project chat
 * list that cannot tell you where a chat lives is one you have to click through
 * to use. The global chat's rows name themselves `Global` with a globe — it is
 * not a repo, and a blank there would read as a missing value.
 */
function ChatRow({ chat, depth, folded }: { chat: Chat; depth: number; folded: number }) {
  const projects = useProjects((s) => s.projects);
  // The UNFILTERED list, on purpose: this resolves `chat.projectId` to a name
  // rather than offering a repo to work in, and the global pseudo-project is
  // exactly the record a `realProjects` lookup would fail to find.
  const project = projects.find((p) => p.id === chat.projectId);
  const global = isGlobalProject(chat.projectId);
  const prKey = reviewTargetKey(chat);
  const prNumber = usePrs((s) => (prKey ? s.byKey[prKey]?.number : undefined));
  const meta = statusMeta(chat.status);
  const reviewer = isReviewerChat(chat);
  const spawned = depth > 0 && !reviewer;

  return (
    <RowButton
      data-testid="home-chat-row"
      onClick={() => selectChat(chat.id)}
      title={chat.title}
      className={cn(
        "flex w-full items-center gap-2 py-1.5 pr-3 hover:bg-hover",
        atDepth(ROW_INDENT, depth),
      )}
    >
      <span
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3",
          toneText(meta.tone),
          meta.pulse && "animate-pulse",
        )}
      >
        {reviewer ? (
          <GitPullRequestArrow />
        ) : spawned ? (
          <MessagesSquare />
        ) : (
          <StatusDot tone={meta.tone} pulse={meta.pulse} size={7} />
        )}
      </span>
      {/* A reviewer's identity is the PR it read, not its own title — the same
          split the sidebar's two child rows make, folded into one row because
          this page has the width for both columns. */}
      {reviewer && prNumber != null && (
        <span className="cm-mono shrink-0 !text-2xs text-secondary">#{prNumber}</span>
      )}
      <TitleLine
        title={chat.title}
        className={cn(
          "min-w-0 flex-1 truncate",
          depth === 0 ? "text-xs text-primary" : "text-2xs text-secondary",
        )}
      />
      {folded > 0 && (
        <span
          className="hidden shrink-0 items-center gap-0.5 text-2xs text-faint sm:flex"
          title={`${folded} nested chat${folded === 1 ? "" : "s"}`}
        >
          <MessagesSquare className="size-3" />
          {folded}
        </span>
      )}
      {/* The status WORD drops at `sm` and the project name does not. The glyph's
          tone already carries the status, and the project is the one column this
          page has that the sidebar's rows don't — dropping it on a phone would
          leave a list of titles from nowhere in particular. It just gets less
          width to say it in. */}
      <span className={cn("hidden shrink-0 text-2xs opacity-80 sm:block", toneText(meta.tone))}>
        {meta.label}
      </span>
      <span className="flex min-w-0 shrink-0 items-center gap-1 text-2xs text-faint">
        {global && <Globe className="size-3" />}
        <span className="max-w-[4.5rem] truncate sm:max-w-[9rem]">
          {global ? GLOBAL_PROJECT_NAME : (project?.name ?? chat.projectId)}
        </span>
      </span>
      <span className="w-7 shrink-0 cm-mono text-right !text-2xs text-faint">
        {relTimeShort(chat.updatedAt ?? chat.createdAt)}
      </span>
    </RowButton>
  );
}
