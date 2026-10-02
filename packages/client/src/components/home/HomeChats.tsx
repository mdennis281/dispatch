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
 * Needs you, Working, New, Idle: this page is read from the top for what wants
 * attention across the whole install, and an empty chat somebody opened in
 * another repo is not that. The tree's own sort is untouched — the branches are
 * grouped and the groups drawn in this page's order.
 *
 * New and Idle fold, for the same reason and to different depths — both are
 * unbounded history and the rest of the page sits below them. See GROUPS.
 *
 * ── WHY THE WORKTREES AND THE PRs ARE ON THESE ROWS ──────────────────────────
 *
 * They were two more cards under this one. Three stacked lists meant the same
 * piece of work appeared three times — the chat, the branch it cut, the PR it
 * opened — each in its own block with its own header, and the reader had to
 * join them by eye across half a screen. A worktree and a pull request BELONG
 * to a chat; they are not peers of it. So they ride on its row (see
 * `rowBits.tsx`) and this page is one list.
 *
 * The one case that does not fit is a PR with no chat — dependabot's, a
 * human's, one whose chat was deleted. It gets the same treatment as the
 * never-started chats: a muted line at the foot that opens. See `orphanPrs`.
 */
import { useMemo, useState } from "react";
import {
  ChevronRight,
  Globe,
  GitPullRequestArrow,
  MessagesSquare,
} from "lucide-react";
import type { Chat, PrRecord } from "@dispatch/shared";
import { isGlobalProject, GLOBAL_PROJECT_NAME } from "@dispatch/shared";
import {
  chatSection,
  useChats,
  isReviewerChat,
  reviewTargetKey,
  useAllChatTree,
  type ChatBranch,
  type ChatSection,
} from "../../stores/chats.js";
import { usePrs, useAllPrs } from "../../stores/prs.js";
import { useProjects } from "../../stores/projects.js";
import { openChat } from "../../stores/navigation.js";
import { StatusDot, statusMeta, toneText } from "../ui/StatusDot.js";
import { TitleLine } from "../ui/TitleText.js";
import { RowButton } from "../ui/RowButton.js";
import { Card } from "../metrics/chrome.js";
import { relTimeShort } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { useProjectChats } from "../../stores/chats.js";
import { BranchMark, OrphanPrRow, PrMark } from "./rowBits.js";
import {
  orphanPrs,
  prsByChat,
  worktreeRows,
  worktreesByChat,
  type HomeWorktreeRow,
} from "./derive.js";

/**
 * The groups, in the order this page reads them, and HOW MANY ROWS each is
 * worth before it folds.
 *
 * ── THE ORDER ────────────────────────────────────────────────────────────────
 *
 * Not `CHAT_SECTIONS`' order — see the module docblock.
 *
 * ── THE HEADINGS ─────────────────────────────────────────────────────────────
 *
 * "Needs you", not the sidebar's "Needs input". The queue is `chatSection`'s
 * `attention`, which is `awaiting-input` OR `failed` OR `error` — a chat that
 * died is as stopped as one that asked a question, and nothing moves on either
 * until a human looks. "Needs input" promised questions and then listed
 * failures underneath. "Needs you" covers all three, and it is already this
 * page's own word: the Activity strip's blocked figure is labelled the same.
 *
 * ── THE PREVIEW ──────────────────────────────────────────────────────────────
 *
 * `preview` is how many rows the group draws before the fold; absent means
 * uncapped. Needs you and Working are uncapped because they are bounded by how
 * much is actually happening, and they are the reason to come here.
 *
 * Idle gets six. It is every chat that has ever run and finished — 736 of them
 * on the install this was built against — and uncapped it put the worktrees,
 * the PRs and the rollup below the bottom of a page whose whole point is the
 * first screenful.
 *
 * NEW GETS ZERO, which is the only entry here that needs defending. A chat with
 * no session has never run a turn, so it is not something that HAPPENED; on the
 * real install all sixteen were titled "New chat", a month old, in one project
 * nobody had touched since. Six rows of that sat directly above Idle as the
 * second-most prominent block on the page — the same mistake in miniature that
 * this whole rework exists to undo: prominence spent on something that is not
 * what is going on.
 *
 * They are NOT dropped. The card's own count includes them, and a list that
 * silently omits rows is worse than one that summarises them — an abandoned
 * chat is still a thing you might want to go and delete. The group collapses to
 * one muted line saying how many, and opens on a click.
 */
interface Group {
  section: ChatSection;
  label: string;
  /** Rows before the fold. Absent = draw them all. */
  preview?: number;
  /** The fold's own line, given how many rows are still hidden. */
  more: (n: number) => string;
}

const GROUPS: Group[] = [
  { section: "attention", label: "Needs you", more: (n) => `Show ${n} more` },
  { section: "working", label: "Working", more: (n) => `Show ${n} more` },
  {
    section: "new",
    label: "New",
    preview: 0,
    more: (n) => `${n} chat${n === 1 ? "" : "s"} opened and never started`,
  },
  { section: "idle", label: "Idle", preview: 6, more: (n) => `Show ${n} more idle` },
];

export function HomeChats() {
  const branches = useAllChatTree();
  const chats = useProjectChats(null);
  const prs = useAllPrs();
  // Which folded groups the reader has opened. A set rather than a flag per
  // group, so giving another group a `preview` needs no new state.
  const [opened, setOpened] = useState<ReadonlySet<ChatSection>>(new Set());
  const [showOrphans, setShowOrphans] = useState(false);

  // Built ONCE here and handed down, not looked up per row. A row doing its own
  // `prs.find(p => p.chatId === id)` is O(rows × PRs) — 757 × 1301 on the
  // install this was built against, on every render of a live page. The
  // worktree scan is memoized ONCE and read twice (the map and the count), for
  // the same reason: it walks every chat's history and dedupes by path.
  const trees = useMemo(() => worktreeRows(chats), [chats]);
  const worktrees = useMemo(() => worktreesByChat(trees), [trees]);
  const prsOf = useMemo(() => prsByChat(prs), [prs]);
  // THE SAME POPULATION THE TREE DREW FROM, archived excluded. `useAllChatTree`
  // drops archived chats, so a `known` set built from the unfiltered list made
  // a PR on an archived chat invisible twice over: no row carries it, and it is
  // not an orphan either — while the header above still counts it.
  const onPage = useMemo(
    () => new Set(chats.filter((c) => !c.archived).map((c) => c.id)),
    [chats],
  );
  const orphans = useMemo(() => orphanPrs(prs, onPage), [prs, onPage]);
  const ctx: RowContext = { worktrees, prsOf };

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
  // The header is where the two dead cards' counts went. They were each a card
  // note ("77 live", "6 open · 1301 tracked"); folded into the one list they are
  // the one line that says how much of each thing there is.
  const openPrs = prs.filter((p) => p.state === "open").length;

  return (
    <Card
      title="Chats"
      icon={<MessagesSquare />}
      note={
        branches.length === 0
          ? undefined
          : [
              live > 0 ? `${live} live` : null,
              `${branches.length} threads`,
              trees.length > 0 ? `${trees.length} worktrees` : null,
              openPrs > 0 ? `${openPrs} open PRs` : null,
            ]
              .filter(Boolean)
              .join(" · ")
      }
    >
      {/* The empty state needs BOTH to be empty. Gating it on the chats alone
          put the orphan fold inside the branch that never renders, so a install
          with tracked PRs and no chats of its own — a fresh one that has just
          imported a repo — said "no chats yet" and silently dropped every PR it
          was counting a line above. */}
      {branches.length === 0 && orphans.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-faint">
          No chats yet. Pick a project below, or start a global chat.
        </p>
      ) : (
        <div>
          {GROUPS.map(({ section, label, preview, more }) => {
            const all = grouped.get(section) ?? [];
            if (all.length === 0) return null;
            const limit = opened.has(section) ? all.length : (preview ?? all.length);
            const shown = all.slice(0, limit);
            const hidden = all.length - shown.length;
            return (
              <div key={section}>
                {/* No heading over an empty preview: a `NEW 16` strip above a
                    line that already reads "16 chats opened and never started"
                    is the same fact twice, and spends a row saying it. */}
                {shown.length > 0 && (
                  <div className="flex items-center gap-2 bg-panel-2/40 px-3 py-1 cm-hairline-b">
                    <span className="text-2xs font-medium uppercase tracking-wide text-faint">
                      {label}
                    </span>
                    <span className="cm-mono !text-2xs text-faint/70">{all.length}</span>
                  </div>
                )}
                {shown.map((b) => (
                  <BranchRows key={b.chat.id} branch={b} depth={0} ctx={ctx} />
                ))}
                {hidden > 0 && (
                  <RowButton
                    onClick={() => setOpened((s) => new Set(s).add(section))}
                    className="w-full px-3 py-1.5 text-2xs text-faint hover:bg-hover hover:text-primary"
                  >
                    {more(hidden)}
                  </RowButton>
                )}
              </div>
            );
          })}

          {/* The one thing on this list that is not a chat. See `orphanPrs` for
              why it is here at all rather than dropped, and `OrphanPrRow` for
              why it is the only row that opens GitHub. */}
          {orphans.length > 0 &&
            (showOrphans ? (
              orphans.map((pr) => <OrphanPrRow key={pr.key} pr={pr} />)
            ) : (
              <RowButton
                onClick={() => setShowOrphans(true)}
                className="w-full px-3 py-1.5 text-2xs text-faint hover:bg-hover hover:text-primary"
              >
                {orphans.length} pull request{orphans.length === 1 ? "" : "s"} with no chat
              </RowButton>
            ))}
        </div>
      )}
    </Card>
  );
}

/**
 * What every row needs that is not on the chat record — built once at the top
 * of the list and passed down, like the sidebar's own `RowContext`.
 */
interface RowContext {
  worktrees: Map<string, HomeWorktreeRow[]>;
  prsOf: Map<string, PrRecord[]>;
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
 * Collapsed by default, with ONE exception: a child branch that has something
 * live inside it is drawn through the fold anyway. A parent filed under "Needs
 * input" for a reviewer two levels down, with that reviewer folded away, is a
 * row pointing at nothing you can see.
 *
 * Only the live sub-branches, though — not the whole fold. The chat that
 * spawned eleven children and has errors in two of them shows the two; the nine
 * that finished stay behind the chevron, where the reader who wants them finds
 * them. That is exactly what the sidebar's `visibleChildren` does and for the
 * same reason, restated here in the three lines this page needs of it — the
 * sidebar's version also coordinates an action tray and an active-row highlight
 * that no row on this page has.
 */
function BranchRows({
  branch,
  depth,
  ctx,
}: {
  branch: ChatBranch;
  depth: number;
  ctx: RowContext;
}) {
  const { chat, children, descendants } = branch;
  const [open, setOpen] = useState(false);
  const live = children.filter((b) => [b.chat, ...b.descendants].some(isLive));
  const shown = open ? children : live;
  // What the chevron is still hiding — every chat under here, minus the ones
  // currently drawn and their own descendants.
  const drawn = new Set(shown.flatMap((b) => [b.chat.id, ...b.descendants.map((c) => c.id)]));
  const hidden = descendants.filter((c) => !drawn.has(c.id)).length;
  const label = open
    ? live.length > 0
      ? "Show live chats only"
      : "Hide nested chats"
    : `Show ${hidden} more nested chat${hidden === 1 ? "" : "s"}`;

  return (
    <div>
      <div className="relative">
        {children.length > 0 && (
          <RowButton
            aria-expanded={open}
            aria-label={label}
            title={label}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "absolute inset-y-0 z-10 flex w-4 items-center justify-center text-muted hover:text-primary [&_svg]:size-2.5",
              depth === 0 ? "left-0" : "left-[14px]",
            )}
          >
            {/* Half-turned when live rows show under a closed fold: rows below a
                closed chevron read as someone else's, and a fully open one
                promises there is nothing more to see. The sidebar's chevron
                says the same thing the same way. */}
            <ChevronRight
              className={cn(
                "transition-transform duration-150",
                open ? "rotate-90" : live.length > 0 && "rotate-45",
              )}
            />
          </RowButton>
        )}
        <ChatRow chat={chat} depth={depth} folded={hidden} ctx={ctx} />
      </div>
      {shown.length > 0 && (
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
          {shown.map((c) => (
            <BranchRows key={c.chat.id} branch={c} depth={depth + 1} ctx={ctx} />
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
function ChatRow({
  chat,
  depth,
  folded,
  ctx,
}: {
  chat: Chat;
  depth: number;
  folded: number;
  ctx: RowContext;
}) {
  const projects = useProjects((s) => s.projects);
  // The UNFILTERED list, on purpose: this resolves `chat.projectId` to a name
  // rather than offering a repo to work in, and the global pseudo-project is
  // exactly the record a `realProjects` lookup would fail to find.
  const project = projects.find((p) => p.id === chat.projectId);
  const global = isGlobalProject(chat.projectId);
  const prKey = reviewTargetKey(chat);
  const prNumber = usePrs((s) => (prKey ? s.byKey[prKey]?.number : undefined));
  const reviewer = isReviewerChat(chat);
  const spawned = depth > 0 && !reviewer;
  // `prSettled` on the TOP-LEVEL row only, exactly as the sidebar does it: it
  // turns an idle chat whose `watch_pr` reached a merged/closed PR from a
  // neutral gray dot into a green "PR done" one. Without it the row that just
  // landed its change reads here as a chat that never did anything — which is
  // the one question this page exists to answer. The child rows omit it for the
  // same reason `ReviewRow`/`SpawnRow` do: a reviewer's PR is somebody else's.
  const prSettled = useChats((s) => (depth === 0 ? (s.prSettled[chat.id] ?? false) : false));
  const meta = statusMeta(chat.status, prSettled);
  const worktrees = ctx.worktrees.get(chat.id) ?? EMPTY_TREES;
  // A reviewer's `#139` is the PR it is READING, which the column below already
  // draws from `reviewTargetKey`. Its own `prs` would be empty anyway, but
  // asking for them would put two different PR columns on one row.
  const ownPrs = reviewer ? EMPTY_PRS : (ctx.prsOf.get(chat.id) ?? EMPTY_PRS);

  return (
    <RowButton
      data-testid="home-chat-row"
      onClick={() => openChat(chat.id)}
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
      {/* ── THE FIXED COLUMNS ──────────────────────────────────────────────
          Every slot from here to the right edge is a fixed width, present
          whether or not the row has anything to put in it. That is what makes
          hundreds of rows read as a TABLE rather than as hundreds of
          separately-tidy lines: a branch column whose x depends on the length
          of the title beside it is a column you cannot scan down.

          The cost is real — an empty slot is reserved space on a row with
          nothing to say — and it is the right trade here. The title takes the
          flex; these take the alignment. */}
      <span className="hidden w-48 shrink-0 justify-end lg:flex">
        <BranchMark worktrees={worktrees} />
      </span>
      <span className="flex w-14 shrink-0 justify-end">
        <PrMark prs={ownPrs} />
      </span>
      <span className="hidden w-7 shrink-0 items-center justify-end gap-0.5 text-2xs text-faint sm:flex">
        {folded > 0 && (
          <>
            <MessagesSquare aria-hidden className="size-3" />
            {folded}
            <span className="sr-only">
              {folded} nested chat{folded === 1 ? "" : "s"}
            </span>
          </>
        )}
      </span>
      {/* The status WORD drops at `sm` and the project name does not. The glyph's
          tone already carries the status, and the project is the one column this
          page has that the sidebar's rows don't — dropping it on a phone would
          leave a list of titles from nowhere in particular. It just gets less
          width to say it in.

          The sr-only copy is NOT a duplicate: the visual one is behind a
          breakpoint and the glyph beside it says "needs input" in colour alone,
          so a phone reader would get an unlabelled marker. Stated once for
          assistive tech at every width, `aria-hidden` on the one that comes and
          goes — the same split the sidebar's `MarkerLabel` makes. */}
      <span className="sr-only">{meta.label}</span>
      <span
        aria-hidden
        className={cn(
          "hidden w-16 shrink-0 truncate text-right text-2xs opacity-80 sm:block",
          toneText(meta.tone),
        )}
      >
        {meta.label}
      </span>
      <span className="flex w-[4.5rem] shrink-0 items-center justify-end gap-1 text-2xs text-faint sm:w-28">
        {global && <Globe aria-hidden className="size-3 shrink-0" />}
        <span className="truncate">
          {global ? GLOBAL_PROJECT_NAME : (project?.name ?? chat.projectId)}
        </span>
      </span>
      <span className="w-7 shrink-0 cm-mono text-right !text-2xs text-faint">
        {relTimeShort(chat.updatedAt ?? chat.createdAt)}
      </span>
    </RowButton>
  );
}

/**
 * Shared empties. A fresh `[]` per render is a new reference for every chat
 * that owns nothing, which is most of them — and these are read by components
 * one `React.memo` away from mattering.
 */
const EMPTY_TREES: readonly HomeWorktreeRow[] = [];
const EMPTY_PRS: readonly PrRecord[] = [];
