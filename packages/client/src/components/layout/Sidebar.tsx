import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronsUpDown,
  Plus,
  Play,
  Square,
  Gamepad2,
  Database,
  Clapperboard,
  FolderGit2,
  Bot,
  Circle,
  Trash2,
  Pencil,
  MessagesSquare,
  Cpu,
  Power,
  BarChart3,
  Brain,
  FolderOpen,
  GitBranch,
  type LucideIcon,
} from "lucide-react";
import { parsePrRecordKey } from "@dispatch/shared";
import type { Chat, PrRecord, SubApp, RunnerInstance, Project } from "@dispatch/shared";
import { Popover, MenuItem } from "../ui/Popover.js";
import { IconButton } from "../ui/IconButton.js";
import { SectionLabel } from "../ui/Panel.js";
import { StatusDot, statusMeta, toneText, type DotTone } from "../ui/StatusDot.js";
import { formatDuration } from "../metrics/duration.js";
import { TitleText } from "../ui/TitleText.js";
import { purposeIcon } from "../config/sections.js";
import { Chip, Badge, type Tone } from "../ui/Chip.js";
import { Spinner } from "../ui/Spinner.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { useProjects, useActiveProject } from "../../stores/projects.js";
import {
  useChats,
  useProjectChatTree,
  useProjectAgentCounts,
  reviewTargetKey,
  type ChatBranch,
  type ProjectAgentCounts,
} from "../../stores/chats.js";
import { usePrs } from "../../stores/prs.js";
import { useChatRuntime, branchRuntimeMs } from "../../stores/chatRuntime.js";
import {
  useChatProcesses,
  branchProcessCount,
  branchChatIds,
} from "../../stores/chatProcesses.js";
import { useView, openOverlay } from "../../stores/view.js";
import { useLayout, dismissLeftDrawer } from "../../stores/layout.js";
import { selectChat, selectProject } from "../../stores/navigation.js";
import { useProjectMemories } from "../../stores/memory.js";
import { useGit, useGitChangeCount } from "../../stores/git.js";
import { useRunners } from "../../stores/runners.js";
import { useAttention } from "../../stores/attention.js";
import { actions } from "../../lib/actions.js";
import { cn } from "../../lib/cn.js";
import { midTruncate, relTimeShort } from "../../lib/format.js";
import { useFlipReorder } from "../../lib/useFlip.js";
import { foldedReviewsLabel } from "./reviewLabel.js";
import { DeleteChatDialog } from "../chat/DeleteChatDialog.js";
import { useChatRename } from "../chat/useChatRename.js";
import { BranchWorktreePicker } from "../panels/BranchWorktreePicker.js";
import {
  useLaunchTargets,
  useLaunchBranch,
  launchSubApp,
  findRunner,
  type LaunchTarget,
} from "../panels/useLauncher.js";

/**
 * The build stamp Vite's `define` inlines (see vite.config.ts). The `typeof`
 * guard is the one form that is safe when the identifier is UNDECLARED — which
 * it is under the client's vitest config, a deliberately plugin-free node
 * runner that never loads vite.config.ts. Reading the bare name there would be
 * a ReferenceError, so a JSX test of this component would fail on the version
 * line rather than on whatever it meant to assert.
 *
 * The `v` prefix belongs to the STAMP, not to the label — the fallback is the
 * word "dev", and `vdev` would be nonsense.
 */
const BUILD_VERSION = typeof __BUILD_VERSION__ === "string" ? `v${__BUILD_VERSION__}` : "dev";

const SUBAPP_ICON: Record<string, LucideIcon> = {
  game: Gamepad2,
  "metrics-server": Database,
  "studio-director": Clapperboard,
};

/** Runner states that mean "this subApp is live / in-flight" (vs a dead record). */
function isActive(status: RunnerInstance["status"] | undefined): boolean {
  return status === "running" || status === "starting" || status === "stopping";
}

/* ------------------------------------------------------------ project head */

/**
 * The right-hand half of a project row: how many agents are live in it.
 *
 * Two tones, never summed into one number — "3 working" and "1 waiting on you"
 * are different calls to action, and a project you have to go answer must not
 * hide inside a busy-looking count. Nothing renders for a quiet project: a row
 * of zeroes would make the menu read as a dashboard rather than a picker.
 */
function ProjectAgentBadge({ counts }: { counts: ProjectAgentCounts | undefined }) {
  const working = counts?.working ?? 0;
  const attention = counts?.attention ?? 0;
  if (!working && !attention) return null;

  // "working" rather than "running": the count also covers `waiting` and
  // `queued`, which are agents with a turn in flight but nothing streaming.
  const label = [
    attention ? `${attention} awaiting input` : null,
    working ? `${working} working` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span className="flex items-center gap-1.5 tabular-nums" title={label}>
      {/* The dots carry the meaning by colour alone, so the readable form goes
          to assistive tech directly — a `title` is not reliably announced. */}
      <span className="sr-only">{label}</span>
      {attention > 0 && (
        <span aria-hidden className={cn("flex items-center gap-1", toneText("warn"))}>
          <StatusDot tone="warn" pulse size={5} />
          {attention}
        </span>
      )}
      {working > 0 && (
        <span aria-hidden className={cn("flex items-center gap-1", toneText("working"))}>
          <StatusDot tone="working" pulse size={5} />
          {working}
        </span>
      )}
    </span>
  );
}

function ProjectSelector({
  onAddProject,
  onManageConfig,
}: {
  onAddProject: () => void;
  onManageConfig: () => void;
}) {
  const projects = useProjects((s) => s.projects);
  const active = useActiveProject();
  const agentCounts = useProjectAgentCounts();

  return (
    <Popover
      align="start"
      width={236}
      className="p-1"
      // Without this the row is only as wide as its own content: the trigger
      // wrapper is `inline-flex`, so the button's `w-full` measures against
      // itself. A short project name left the highlight stopping mid-band with
      // bare `surface` beside it, and the chevron floating mid-row.
      triggerClassName="w-full"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          aria-expanded={open}
          className={cn(
            // Full-bleed and square, like every other row in this column: it
            // fills the header band rather than sitting in it as a card, so the
            // sidebar has ONE row shape from the project name to the last chat.
            "flex h-12 w-full items-center gap-2 px-2.5 text-left transition-colors hover:bg-hover",
            open && "bg-active",
          )}
        >
          {/* Bare glyph, no tile: the accent fill and ring read as a badge on a
              row that is already the header, and it was the one card left in a
              column that is otherwise full-bleed rows. The span keeps size-6 so
              the title's left edge doesn't move. */}
          <span className="flex size-6 items-center justify-center text-accent [&_svg]:size-4">
            <FolderGit2 />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base font-semibold text-primary">
              {active?.name ?? "No project"}
            </span>
            <span className="block truncate cm-mono !text-2xs text-faint">
              {active ? midTruncate(active.repoPath, 30) : "—"}
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-faint" />
        </button>
      )}
    >
      {(close) => (
        <div className="flex flex-col">
          {projects.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-faint">No projects yet.</p>
          )}
          {projects.map((p) => (
            <MenuItem
              key={p.id}
              icon={<FolderGit2 />}
              active={p.id === active?.id}
              hint={<ProjectAgentBadge counts={agentCounts[p.id]} />}
              onClick={() => {
                selectProject(p.id);
                close();
                // Deliberately NOT dismissLeftDrawer(): unlike the nav items below,
                // switching project navigates you INTO the sidebar, not out of it.
                // `selectProject` clears the open chat, so closing the drawer here
                // left a phone staring at the empty state with the chat list it
                // needs to pick from hidden behind a second tap.
              }}
            >
              {p.name}
            </MenuItem>
          ))}
          <div className="my-1 h-px bg-line" />
          <MenuItem
            icon={<Plus />}
            onClick={() => {
              close();
              onAddProject();
            }}
          >
            New project…
          </MenuItem>
          <MenuItem
            icon={<Bot />}
            onClick={() => {
              close();
              onManageConfig();
            }}
          >
            Agents &amp; modes…
          </MenuItem>
        </div>
      )}
    </Popover>
  );
}

/* ------------------------------------------------------------------ subApp */

function SubAppRow({
  app,
  project,
  target,
  runner,
}: {
  app: SubApp;
  project: Project;
  target: LaunchTarget | undefined;
  runner?: RunnerInstance;
}) {
  const Icon = SUBAPP_ICON[app.id] ?? Circle;
  const [busy, setBusy] = useState(false);

  // The server publishes runner-update on start/stop; clear the local pending
  // flag the moment a fresh status lands so the control settles on truth.
  useEffect(() => {
    setBusy(false);
  }, [runner?.status]);

  const running = runner?.status === "running";
  const transitioning = busy || runner?.status === "starting" || runner?.status === "stopping";

  const start = () => {
    if (!target) return;
    setBusy(true);
    launchSubApp(target, app.id, project.id);
  };
  const stop = () => {
    if (!runner) return;
    setBusy(true);
    actions.stopRunner(runner.id);
  };

  return (
    <div className="group flex items-center gap-2 px-2.5 py-1.5 pr-2 transition-colors hover:bg-hover">
      <Icon className={cn("size-3.5 shrink-0", running ? "text-accent-hi" : "text-muted")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-secondary group-hover:text-primary">
          {app.name}
        </span>
      </span>
      {running && runner?.port && (
        <Chip tone="success" mono>
          :{runner.port}
        </Chip>
      )}
      {transitioning ? (
        <span className="flex size-6 items-center justify-center">
          <Spinner size={12} />
        </span>
      ) : running ? (
        <IconButton size="sm" tip="Stop" onClick={stop}>
          <Square />
        </IconButton>
      ) : (
        <IconButton
          size="sm"
          tip="Run"
          onClick={start}
          disabled={!target}
          // `cm-touch-reveal` (index.css): always visible on a coarse pointer,
          // where there is no hover to reveal it with.
          className="cm-touch-reveal opacity-0 group-hover:opacity-100"
        >
          <Play />
        </IconButton>
      )}
    </div>
  );
}

/**
 * The 3px bar marking the selected row.
 *
 * Always mounted, never conditionally rendered: it has to be here to animate
 * OUT of, and a rail that only exists while selected can only ever pop. Active
 * plays `cm-rail-in` (slide from the edge, overshoot, recover — see index.css);
 * inactive is a plain transition back to nothing, so clicking down the list
 * reads as one selection travelling rather than two unrelated bars blinking.
 */
function ActiveRail({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        // `cm-rail` is the hook reduced-motion needs: the retract is a Tailwind
        // transition on the inactive branch below, which a rule naming only
        // `cm-rail-in` cannot reach.
        "cm-rail pointer-events-none absolute inset-y-0 left-0 w-[3px] origin-left bg-accent",
        active
          ? "cm-rail-in scale-x-100 opacity-100"
          // `scale`, NOT `transform`, and the difference is the whole retract.
          // Tailwind v4 compiles `scale-x-*` to the independent `scale`
          // property (`scale: var(--tw-scale-x) var(--tw-scale-y)`), so a
          // hand-written `transition-[transform,opacity]` covers nothing here:
          // `scale` snapped 100% → 0% on one frame and the fade had a
          // zero-width bar left to fade. The named `transition-transform` would
          // work — v4 expands it to `transform, translate, scale, rotate` — but
          // it can't carry opacity too, so the list stays explicit and names
          // `scale` itself. The entry keyframes are unaffected: they animate
          // `transform`, which composes with `scale` independently.
          : "scale-x-0 opacity-0 transition-[scale,opacity] duration-200 ease-[var(--ease-out)]",
      )}
    />
  );
}

/* -------------------------------------------------------------------- chat */

/**
 * A chat, and the reviewer chats filed under it.
 *
 * Dispatch spawns one reviewer chat PER ROUND, so a PR reviewed four times put
 * four near-identical `review: #135 …` rows in the sidebar — four rows about one
 * change, interleaved by recency with everything else and never next to the chat
 * that made it. Folded under their parent they cost one row and stay one click
 * away.
 *
 * Collapsed by default, and the flag is component state rather than a store:
 * it's where this reader's eye is right now, and nothing else in the app has an
 * opinion about it.
 */
function ChatBranchRows({
  branch,
  activeChatId,
  attentionByChat,
  runtimeByChat,
  now,
  onSelect,
}: {
  branch: ChatBranch;
  activeChatId: string | null;
  attentionByChat: Set<string>;
  runtimeByChat: Record<string, number>;
  now: number;
  onSelect: (id: string) => void;
}) {
  const { chat, reviews } = branch;
  const [expanded, setExpanded] = useState(false);
  // A branch never hides the transcript that's on screen. The PRs panel links
  // straight to a reviewer chat, and landing there with its parent collapsed
  // left the sidebar with no row for what you were looking at.
  const open = expanded || reviews.some((r) => r.id === activeChatId);

  return (
    <div data-flip-id={chat.id}>
      <ChatRow
        chat={chat}
        active={chat.id === activeChatId}
        needsInput={attentionByChat.has(chat.id)}
        now={now}
        runtimeMs={branchRuntimeMs(runtimeByChat, chat.id, reviews)}
        reviews={reviews}
        reviewsNeedInput={reviews.some((r) => attentionByChat.has(r.id))}
        expanded={open}
        onToggleReviews={() => setExpanded((v) => !v)}
        onClick={() => onSelect(chat.id)}
      />
      {open && reviews.length > 0 && (
        // The thread rail is drawn once, absolutely, rather than as a border on
        // a padded wrapper: the wrapper's padding would inset the rows, and a
        // reviewer row's highlight has to reach both edges exactly like every
        // other row's. Indentation is the row's own left padding instead.
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-4 w-px bg-line-soft" />
          {reviews.map((review) => (
            <ReviewRow
              key={review.id}
              chat={review}
              active={review.id === activeChatId}
              needsInput={attentionByChat.has(review.id)}
              now={now}
              runtimeMs={runtimeByChat[review.id] ?? 0}
              onClick={() => onSelect(review.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The subtext's separator. Dimmer than either figure it sits between, so the
 * eye reads three values rather than one punctuated string.
 */
function Dot() {
  return <span className="text-faint/50"> · </span>;
}

function ChatRow({
  chat,
  active,
  needsInput,
  now,
  runtimeMs,
  reviews,
  reviewsNeedInput,
  expanded,
  onToggleReviews,
  onClick,
}: {
  chat: Chat;
  active: boolean;
  needsInput: boolean;
  /** Shared "current time" tick so every row ages in lockstep. */
  now: number;
  /** Agent time under this chat — its own, its subagents', its reviewers'. */
  runtimeMs: number;
  /** Reviewer chats folded under this row. Usually empty. */
  reviews: Chat[];
  reviewsNeedInput: boolean;
  expanded: boolean;
  onToggleReviews: () => void;
  onClick: () => void;
}) {
  const prSettled = useChats((s) => s.prSettled[chat.id] ?? false);
  const meta = statusMeta(chat.status, prSettled);
  // Per-row subscription: re-renders this row (and refreshes its age) the moment
  // its activity clock advances — the recency ordering itself lives in the selector.
  const activityAt = useChats(
    (s) => s.lastActivity[chat.id] ?? chat.updatedAt ?? chat.createdAt,
  );
  const age = relTimeShort(activityAt, now);
  const PurposeIcon = purposeIcon(chat.purpose?.kind);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rename = useChatRename(chat);

  // What the folded reviews are up to, in one colour: somebody is stopped on a
  // question, somebody is mid-review, or nothing is moving. Collapsing the rows
  // must not collapse the fact that one of them needs you.
  const reviewTone: DotTone = reviewsNeedInput
    ? "warn"
    : reviews.some((r) => r.status === "running" || r.status === "waiting")
      ? "working"
      : "muted";
  const reviewCount = `${reviews.length} review${reviews.length === 1 ? "" : "s"}`;

  // OS processes this branch is holding — the session subprocess, every MCP
  // server under it, and any background shell it started, summed across the
  // reviewer chats folded into the row. Per-row subscription like `activityAt`
  // above: one poll updates every row, and only the rows whose number moved
  // re-render.
  const processCount = useChatProcesses((s) => branchProcessCount(s.byChat, chat.id, reviews));
  const killProcesses = useChatProcesses((s) => s.kill);
  const [killing, setKilling] = useState(false);
  // Named so the tip can say what will actually end, rather than "kill
  // processes" — the reviewer chats are the surprising half of the number.
  const processScope = reviews.length
    ? `this chat and ${reviewCount}`
    : "this chat";
  const branchRunning =
    chat.status === "running" || reviews.some((r) => r.status === "running");
  const killTip =
    `End ${processCount} process${processCount === 1 ? "" : "es"} held by ${processScope}` +
    (branchRunning
      ? " — a turn is RUNNING and will be interrupted"
      : ". The transcript is kept; the next message starts a fresh session.");

  const onKillProcesses = async (): Promise<void> => {
    if (killing) return;
    setKilling(true);
    try {
      await killProcesses(branchChatIds(chat.id, reviews));
    } finally {
      setKilling(false);
    }
  };
  // Which PRs those reviews belong to, for the two places that stand in for the
  // expanded rows. The runtime tooltip keeps the plain count — it is about where
  // the time went, and a per-PR breakdown there is noise.
  const reviewsByPr = foldedReviewsLabel(reviews);

  return (
    // `overflow-hidden` is what lets the action tray start fully off the row and
    // slide in: clipped HERE it can never reach the scroll container, where an
    // element past the right edge turns `overflow-y: auto` into a horizontal
    // scrollbar across the whole list.
    <div className="group/row relative overflow-hidden">
      <button
        data-testid="chat-row"
        onClick={onClick}
        className={cn(
          // Square and full-bleed: the highlight is the ROW, so it runs edge to
          // edge and the list reads as a list rather than a stack of cards.
          "relative flex w-full items-center gap-2.5 py-1.5 pl-2.5 pr-8 text-left transition-colors",
          active ? "bg-accent-ghost/70" : "hover:bg-hover",
        )}
      >
        <ActiveRail active={active} />
        {/* A chat the app spawned for a job wears that job's icon instead of the
            status dot — in a sidebar of a dozen rows it's the only way to spot
            the one that's off editing your config. It's a bare glyph in the
            dot's slot, tinted with the SAME tone the dot would have used: the
            icon says what the chat is, its colour says how the chat is doing,
            so one marker carries both and the row keeps one colour language.
            An unknown purpose kind falls back to the dot. */}
        {PurposeIcon ? (
          <span
            title={chat.purpose?.label ?? chat.purpose?.kind}
            className={cn(
              "flex size-[15px] shrink-0 items-center justify-center [&_svg]:size-3.5",
              toneText(meta.tone),
              "transition-colors duration-300",
              meta.pulse && "animate-pulse",
            )}
          >
            <PurposeIcon />
          </span>
        ) : (
          <StatusDot tone={meta.tone} pulse={meta.pulse} size={7} />
        )}
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-base",
              active ? "font-semibold text-primary" : "text-secondary",
            )}
          >
            {/* `**category**:` in a title takes the accent — the category is
                what the eye scans a long sidebar FOR. See ui/TitleText. */}
            <TitleText title={chat.title} />
          </span>
          {/* Three different measurements, so three different colours — one grey
              run of text made them read as a single caption nobody parsed.
              STATUS takes the tone its own dot already has, so the row keeps one
              colour language (idle stays faint; a failure is red in both places).
              AGE is neutral. RUNTIME is `accent-2`, which is this palette's
              "something the machine did on your behalf" — the same violet
              `ui/Chip`'s `agent` tone uses for a subagent. */}
          <span className="mt-px block truncate text-2xs">
            <span className={toneText(meta.tone)}>{meta.label}</span>
            <Dot />
            <span className="text-muted">{age}</span>
            {runtimeMs > 0 && (
              <>
                <Dot />
                <span
                  className="text-accent-2"
                  title={
                    reviews.length
                      ? `${formatDuration(runtimeMs)} of agent time — this chat, its ` +
                        `subagents, and ${reviewCount}`
                      : `${formatDuration(runtimeMs)} of agent time — this chat and its subagents`
                  }
                >
                  {formatDuration(runtimeMs)}
                </span>
              </>
            )}
          </span>
        </span>
      </button>

      {/* Rename edits the row IN PLACE — same interaction as the transcript
          header, overlaid on the row so the list doesn't reflow mid-edit. It's
          a sibling of the row button because an input nested inside a button is
          invalid and swallows its own clicks. */}
      {rename.editing && (
        <div className="absolute inset-x-1 inset-y-0 flex items-center pl-[26px] pr-1">
          <input
            {...rename.inputProps}
            aria-label="Rename chat"
            className="w-full border border-accent-line bg-inset px-1.5 py-0.5 text-base font-semibold text-primary outline-none"
          />
        </div>
      )}

      {/* right rail (sibling of the row button — never a nested button): what the
          row is quietly telling you at rest, and the actions that slide over it.

          The actions are a full-height TRAY, not floating glyphs. They overhang
          the title — three 24px buttons in a 32px gutter always will — and
          against a chat called `**review**: #139 chore(config): commit the…` a
          transparent pencil sat in the middle of the word it was covering. The
          tray carries the row's own highlight one step further (`bg-active` over
          `bg-hover`, `accent-ghost` at full strength over the selected row's
          70%), so it reads as part of this row rather than a card dropped on
          top, and the left border is the only edge it needs: where the border
          is, the title ends.

          It stays MOUNTED and merely translated, so its buttons keep their tab
          stop — which is why the resting markers are pinned rather than in
          flow, and why they stand down for EITHER way the tray can arrive
          (pointer hover, or keyboard focus landing in the rail). On a coarse
          pointer `cm-touch-reveal` parks the tray permanently out, so
          `cm-touch-hide` takes the markers away entirely rather than leaving
          them underneath it. */}
      {!rename.editing && (
        <div className="group/rail absolute inset-y-0 right-0">
          {(needsInput || processCount > 0 || (reviews.length > 0 && !expanded)) && (
            <span
              className={cn(
                // The scroll track shares this surface's background, so gutter
                // and scrollbar read as one undifferentiated band and the
                // markers looked like they were floating in it. `pr-2.5` is as
                // tight as the bubble's 8px overhang allows — any tighter and
                // the row's `overflow-hidden` takes a bite out of it.
                // `gap-3.5` because each bubble overhangs to the RIGHT, so the
                // spacing between the two pairs is the gap minus that overhang.
                "cm-touch-hide pointer-events-none absolute inset-y-0 right-0 flex items-center gap-3.5 pr-2.5",
                "group-hover/row:hidden group-focus-within/rail:hidden",
              )}
            >
              {/* Side by side, processes first: the review badge keeps the slot
                  it has always had, so the new one arrives beside it rather than
                  shifting it. `gap-2.5` because each count overhangs its icon to
                  the right — at the old 1.5 the digits collided with the next
                  icon. */}
              {processCount > 0 && (
                <IconCount
                  icon={Cpu}
                  count={processCount}
                  // `accent-2` is this palette's "something the machine did on
                  // your behalf" — the same violet the runtime figure on the
                  // subtext line uses, and this is the other half of that cost:
                  // one says how long it ran, the other what it is still holding.
                  iconClass="text-accent-2"
                  tone="agent"
                  title={`${processCount} OS process${
                    processCount === 1 ? "" : "es"
                  } held by ${processScope} — its runtime subprocess, the MCP servers under it, and any background shell it started`}
                />
              )}
              {reviews.length > 0 && !expanded && (
                <IconCount
                  icon={MessagesSquare}
                  count={reviews.length}
                  iconClass={toneText(reviewTone)}
                  // The GLYPH keeps the full three-way state (muted / working /
                  // needs-you); the bubble only has to separate "go look at
                  // this" from the rest, and `Badge` has no muted fill anyway.
                  tone={reviewTone === "warn" ? "warn" : "accent"}
                  title={reviewsByPr}
                />
              )}
              {needsInput && <StatusDot tone="warn" pulse size={6} />}
            </span>
          )}
          <div
            className={cn(
              "cm-touch-reveal absolute inset-y-0 right-0 flex items-center gap-0.5 border-l border-line px-1.5",
              "translate-x-full transition-transform duration-150 ease-[var(--ease-out)]",
              "group-hover/row:translate-x-0 group-focus-within/rail:translate-x-0",
              // OPAQUE, in two layers. `--p-active` and `--p-accent-ghost` are
              // translucent OVERLAYS (0.07 and 0.12 alpha) — as a bare
              // background the tray was 93% see-through and the row's title
              // read straight through the icons. The sidebar's own `surface`
              // goes underneath as a solid floor and the highlight is painted
              // over it as a gradient layer, which keeps it the off-colour of
              // the row it covers while actually covering it.
              "bg-surface",
              active
                ? "bg-[image:linear-gradient(var(--p-accent-ghost),var(--p-accent-ghost))]"
                : "bg-[image:linear-gradient(var(--p-active),var(--p-active))]",
            )}
          >
            {/* Reap, not evict. Nothing takes a chat's processes away on a
                timer — idle chats hold their session on purpose, because a chat
                parked waiting for someone to test something has to still be
                there when they get back. So the decision is a button, and it
                only appears on a row that actually has something to give back.

                No confirmation dialog: this is REVERSIBLE in the way
                `DeleteChatDialog` explains delete is not — the transcript
                survives and the next message starts a fresh session. What it can
                cost is a running turn, so the tip says so in as many words. */}
            {processCount > 0 && (
              <IconButton size="sm" tip={killTip} disabled={killing} onClick={onKillProcesses}>
                <Power />
              </IconButton>
            )}
            {reviews.length > 0 && (
              <IconButton
                size="sm"
                active={expanded}
                aria-expanded={expanded}
                tip={expanded ? `Hide ${reviewsByPr}` : `Show ${reviewsByPr}`}
                onClick={onToggleReviews}
              >
                <MessagesSquare />
              </IconButton>
            )}
            <IconButton size="sm" tip="Rename chat" onClick={rename.start}>
              <Pencil />
            </IconButton>
            <IconButton size="sm" tip="Delete chat" onClick={() => setConfirmDelete(true)}>
              <Trash2 />
            </IconButton>
          </div>
        </div>
      )}

      <DeleteChatDialog
        chatId={chat.id}
        title={chat.title}
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}

/**
 * An icon with its count as a corner badge.
 *
 * The count used to sit INLINE beside the icon, which was fine while there was
 * one of them and stopped being fine at two: `[icon]2 [icon]9` in a 40px gutter
 * reads as one four-character number, and no amount of gap fixes that because
 * the digits are the same size and weight as each other. Anchoring each count to
 * its own icon binds them visually — the pair is one glyph, so two pairs are two
 * glyphs rather than four things in a row.
 *
 * No chip behind the digits. The markers live in the right gutter, past where
 * the title truncates, so there is never anything under them to separate from —
 * and a filled badge would need the tray's two-layer opaque treatment to survive
 * the active row's gradient, which is a lot of machinery for 10px of text that
 * has nothing behind it.
 */
function IconCount({
  icon: Icon,
  count,
  iconClass,
  tone,
  title,
}: {
  icon: LucideIcon;
  count: number;
  /** Foreground colour for the GLYPH. A tone via `toneText`, or a palette class. */
  iconClass: string;
  /** Fill for the bubble. `Badge` pairs each with its contrast-correct ink. */
  tone: Tone;
  title: string;
}) {
  return (
    <span
      title={title}
      className={cn("relative inline-flex items-center [&_svg]:size-4", iconClass)}
    >
      <Icon />
      {/* The shared `Badge`, not a hand-rolled chip: it already pairs every fill
          with its `-fg` ink, and that pairing is the thing a bespoke one gets
          wrong — a `text-white` badge is legible in exactly one theme. Reusing
          it also means these read as the same object as the nav's counts.

          The overhang has to stay INSIDE the row's `overflow-hidden`, and the
          row is clipped at exactly the gutter's padding — so this offset and
          that padding are one measurement, not two. */}
      <span className="pointer-events-none absolute -top-2 -right-1.5">
        <Badge count={count} tone={tone} size="sm" />
      </span>
    </span>
  );
}

/**
 * One reviewer chat, under the chat whose PR it read.
 *
 * Deliberately NOT a `ChatRow`. The parent directly above already carries the
 * change's title, and `review: #139 chore(config): commit the…` repeated under
 * it is the same sentence twice at half the width. What the parent can't say is
 * which PR this round read, what came back of it, and what it cost — so that is
 * the whole row, on one line, in the same four colours the parent's subtext uses.
 */
function ReviewRow({
  chat,
  active,
  needsInput,
  now,
  runtimeMs,
  onClick,
}: {
  chat: Chat;
  active: boolean;
  needsInput: boolean;
  now: number;
  runtimeMs: number;
  onClick: () => void;
}) {
  const key = reviewTargetKey(chat);
  const record = usePrs((s) => (key ? s.byKey[key] : undefined));
  const activityAt = useChats(
    (s) => s.lastActivity[chat.id] ?? chat.updatedAt ?? chat.createdAt,
  );
  const meta = statusMeta(chat.status);
  const number = record?.number ?? (key ? parsePrRecordKey(key)?.number : undefined);
  const posted = reviewSummary(chat, record);

  return (
    <button
      data-testid="review-row"
      onClick={onClick}
      title={record?.title ?? chat.purpose?.label}
      className={cn(
        // Indented by PADDING, not by a margin — the highlight still runs the
        // full width of the sidebar, exactly like the row it hangs off.
        "relative flex w-full items-center gap-2 py-1 pl-7 pr-2.5 text-left transition-colors",
        active ? "bg-accent-ghost/70" : "hover:bg-hover",
      )}
    >
      <ActiveRail active={active} />
      <span
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3",
          toneText(meta.tone),
          "transition-colors duration-300",
          meta.pulse && "animate-pulse",
        )}
      >
        <MessagesSquare />
      </span>
      <span
        className={cn("cm-mono shrink-0 !text-2xs", active ? "text-primary" : "text-secondary")}
      >
        {number != null ? `#${number}` : "PR"}
      </span>
      {/* What came back, or — when the registry can't say — what the reviewer is
          doing. Findings take `warn` when the review asked for changes, because
          "3 comments" and "3 comments that block the merge" are not the same
          news and the row is the only place that distinction is cheap to make. */}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-2xs",
          posted
            ? record?.reviewAgent?.postedEvent === "REQUEST_CHANGES"
              ? "text-warn"
              : "text-info"
            : toneText(meta.tone),
        )}
      >
        {posted ?? meta.label}
      </span>
      {runtimeMs > 0 && (
        <span className="shrink-0 text-2xs text-accent-2" title={`${formatDuration(runtimeMs)} reviewing`}>
          {formatDuration(runtimeMs)}
        </span>
      )}
      {needsInput ? (
        <StatusDot tone="warn" pulse size={5} />
      ) : (
        <span className="shrink-0 text-2xs text-muted">{relTimeShort(activityAt, now)}</span>
      )}
    </button>
  );
}

/**
 * What this reviewer left on the pull request, when the registry still knows.
 *
 * `reviewAgent` remembers ONE round — the last — so only the reviewer whose chat
 * id it names can be credited with its findings. Any earlier round falls back to
 * its own status, because labelling it with the newest round's count would be a
 * confident claim about work it never did.
 */
function reviewSummary(chat: Chat, record: PrRecord | undefined): string | null {
  const agent = record?.reviewAgent;
  if (!agent || agent.chatId !== chat.id || !agent.postedAt) return null;
  const n = agent.findings ?? 0;
  return n ? `${n} comment${n === 1 ? "" : "s"}` : "no comments";
}

/* -------------------------------------------------------------- top-level nav */

/** A chat-independent, project-scoped surface toggle (Memory, Source Control). */
function NavButton({
  icon: Icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  /** Right-aligned tally; hidden when undefined (never rendered as "0"). */
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative flex w-full items-center gap-2 px-2.5 py-1.5 text-sm font-medium transition-colors [&_svg]:size-3.5",
        active ? "bg-accent-ghost text-primary" : "text-secondary hover:bg-hover hover:text-primary",
      )}
    >
      {/* The same rail the selected chat row wears — one marker for "this is
          what you are looking at", wherever the selection happens to be. */}
      <ActiveRail active={active} />
      <Icon className={active ? "text-accent" : "text-muted"} />
      <span className="flex-1 text-left">{label}</span>
      {count !== undefined && (
        <span className="cm-mono !text-2xs text-faint">{count}</span>
      )}
    </button>
  );
}

/* ----------------------------------------------------------------- sidebar */

/**
 * Fire-and-focus chat creation: dispatch create-chat for the current project
 * with no custom agent, and select the chat the moment its id streams back into
 * the store — no dialog. create-chat is fire-and-forget, so we watch the chats
 * store for the newly-appeared id (with an 8s safety net).
 *
 * Effort is deliberately NOT sent: the server resolves it from the app's
 * per-provider default (Settings → Chat), and an explicit value here WINS over
 * that chain — which is exactly how every new chat used to land on medium no
 * matter what the setting said. `modeId` is still whatever the caller pins (the
 * `+` button pins "auto"), so Settings → Default mode does NOT reach these — a
 * separate decision, since dropping the pin would change the un-configured
 * default from acceptEdits to ask.
 */
function createChatAndFocus(input: { projectId: string; modeId?: string }): void {
  const before = new Set(useChats.getState().order);
  actions.createChat({
    projectId: input.projectId,
    modeId: input.modeId,
  });

  let done = false;
  const finish = (id: string) => {
    if (done) return;
    done = true;
    unsub();
    clearTimeout(timer);
    selectChat(id);
  };
  const unsub = useChats.subscribe((s) => {
    const fresh = s.order.find((id) => !before.has(id));
    if (fresh) finish(fresh);
  });
  const timer = setTimeout(() => {
    done = true;
    unsub();
  }, 8000);
}

export function Sidebar() {
  // Below `md` this whole column lives inside an off-canvas `Drawer`, so it
  // fills the drawer instead of carrying its own 260px. At `md` and `lg` the
  // classes are byte-for-byte what they always were.
  const mode = useLayout((s) => s.mode);
  const leftOpen = useLayout((s) => s.leftOpen);
  const inDrawer = mode === "sm";

  const project = useActiveProject();
  const branches = useProjectChatTree(project?.id ?? null);
  const chatCount = branches.reduce((n, b) => n + 1 + b.reviews.length, 0);
  const runtimeByChat = useChatRuntime((s) => s.byChat);
  const refreshRuntime = useChatRuntime((s) => s.refresh);
  const refreshProcesses = useChatProcesses((s) => s.refresh);
  const activeChatId = useChats((s) => s.activeChatId);
  const runners = useRunners((s) => s.byId);
  const attentionItems = useAttention((s) => s.items);
  const view = useView((s) => s.view);
  const setView = useView((s) => s.setView);
  const memCount = useProjectMemories(project?.id ?? null).length;
  const changeCount = useGitChangeCount();

  // Keep the Source Control tally live without opening the view. One `git
  // status` a minute is nothing, and it means the badge is already right when
  // you go looking — the open view polls far faster on its own.
  const setGitRepo = useGit((s) => s.setRepoPath);
  const refreshGit = useGit((s) => s.refresh);
  useEffect(() => {
    setGitRepo(project?.repoPath ?? null);
  }, [project?.repoPath, setGitRepo]);
  useEffect(() => {
    if (!project?.repoPath) return;
    const t = setInterval(() => void refreshGit(), 60_000);
    return () => clearInterval(t);
  }, [project?.repoPath, refreshGit]);

  // Opening a chat always returns to the chat workspace (out of the Memory view);
  // selectChat does that, and keeps the project selection in step. On a phone it
  // also closes the drawer, which is otherwise sitting on top of the transcript
  // you just asked for.
  const setActiveChat = (id: string) => {
    selectChat(id);
    dismissLeftDrawer();
  };

  // Launch target for the Apps section. The SAME selection the right panel's
  // Runner picker drives (see useLaunchBranch) — one project, one answer to
  // "which branch does Run use?".
  const { targets } = useLaunchTargets(project?.id);
  const {
    branch: selectedBranch,
    setBranch: setSelectedBranch,
    target: selectedTarget,
  } = useLaunchBranch(project?.id, targets, project?.repoPath);

  // Agent time per row. One indexed GROUP BY behind it, so the poll is cheap —
  // see `stores/chatRuntime` for why this is polled rather than pushed. Same
  // 30s beat as the age clock below: both label the same rows, and refreshing
  // one without the other makes a live chat's two figures disagree.
  useEffect(() => {
    void refreshRuntime();
    const t = setInterval(() => void refreshRuntime(), 30_000);
    return () => clearInterval(t);
  }, [refreshRuntime]);

  // Processes per row, on the same 30s beat and for the same reason: it labels
  // the same rows as the runtime figure beside it. The server caches the scan
  // behind its own TTL, so this poll costs one cheap read no matter how many
  // clients are connected.
  useEffect(() => {
    void refreshProcesses();
    const t = setInterval(() => void refreshProcesses(), 30_000);
    return () => clearInterval(t);
  }, [refreshProcesses]);

  // Shared clock so every chat row's "age" label ages together. 30s is plenty
  // for m/h/d/w granularity and keeps the sidebar idle-cheap.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // FLIP: animate chat rows sliding to their new slot when activity reorders them.
  // Skipped while the drawer is closed — see the `active` note in lib/useFlip:
  // every reorder that happened off-canvas would otherwise replay at once on the
  // first frame after opening.
  const chatListRef = useRef<HTMLDivElement>(null);
  useFlipReorder(chatListRef, !inDrawer || leftOpen);

  // New chat = instant create with defaults + auto-select (no dialog). Gated on a
  // selected project, so the trigger is disabled until there's somewhere to create.
  const startNewChat = () => {
    if (!project) return;
    setView("chat");
    dismissLeftDrawer();
    // Deterministic default: "auto" is always a valid primary segment (both the
    // broker's mode-fallback map and the composer understand it without a stored
    // ModeConfig), so a fresh chat opens on Auto — never on whichever mode file
    // happened to enumerate first on disk (readdir order is arbitrary).
    createChatAndFocus({ projectId: project.id, modeId: "auto" });
  };

  const attentionByChat = useMemo(() => {
    const set = new Set<string>();
    for (const i of attentionItems) {
      if (i.kind === "permission" || i.kind === "question") set.add(i.chatId);
    }
    return set;
  }, [attentionItems]);

  // Match a live runner to the SELECTED branch/worktree target (so the row's
  // Run/Stop reflects the branch the picker is pointed at).
  const runnerFor = (subAppId: string): RunnerInstance | undefined =>
    findRunner(runners, {
      subAppId,
      branch: selectedTarget?.branch,
      worktreePath: selectedTarget?.worktreePath,
    });

  return (
    <aside
      className={cn(
        "flex flex-col border-r border-line bg-surface",
        inDrawer ? "h-full w-full" : "w-[260px] shrink-0",
      )}
    >
      <div className="flex h-12 shrink-0 items-center cm-hairline-b">
        {/* Adding a project is a full page, not a dialog: it ends by handing
            the repo to an agent, and that hand-off needs the config it's
            handing over visible beside it. See NewProjectView. */}
        <ProjectSelector
          onAddProject={() => setView("new-project")}
          onManageConfig={() => openOverlay("agents")}
        />
      </div>

      <ScrollArea className="min-h-0 flex-1 py-2">
        {/* top-level nav: chat-independent, project-scoped surfaces */}
        <div className="pb-1">
          <NavButton
            icon={Brain}
            label="Memory"
            count={memCount}
            active={view === "memory"}
            onClick={() => {
              setView(view === "memory" ? "chat" : "memory");
              dismissLeftDrawer();
            }}
          />
          <NavButton
            icon={GitBranch}
            label="Source Control"
            // Only a non-zero tally is worth the pixels — a clean tree says so
            // by showing nothing at all.
            count={changeCount || undefined}
            active={view === "git"}
            onClick={() => {
              setView(view === "git" ? "chat" : "git");
              dismissLeftDrawer();
            }}
          />
          {/* Below Source Control because it's the wider lens on the same
              thing: git shows what CHANGED in the checkout, this shows what's
              on the disk — including the drives and mounts no repo covers. */}
          <NavButton
            icon={FolderOpen}
            label="Files"
            active={view === "files"}
            onClick={() => {
              setView(view === "files" ? "chat" : "files");
              dismissLeftDrawer();
            }}
          />
          {/* Last in the group: it is the only one that is not about the CURRENT
              state of the project — it is the record of what has already
              happened, across every project. */}
          <NavButton
            icon={BarChart3}
            label="Metrics"
            active={view === "metrics"}
            onClick={() => {
              setView(view === "metrics" ? "chat" : "metrics");
              dismissLeftDrawer();
            }}
          />
        </div>

        <div className="my-2 h-px bg-line-soft" />

        {/* subApps */}
        <div className="mb-1 flex items-center gap-1.5 px-2.5 pb-1">
          <SectionLabel className="px-0">Apps</SectionLabel>
          <span className="cm-mono !text-2xs text-faint">{project?.subApps.length ?? 0}</span>
          {project && project.subApps.length > 0 && (
            <div className="ml-auto">
              <BranchWorktreePicker
                targets={targets}
                value={selectedBranch}
                onChange={setSelectedBranch}
                align="end"
              />
            </div>
          )}
        </div>
        <div>
          {!project ? (
            <p className="px-2.5 py-1.5 text-xs text-faint">No project selected.</p>
          ) : project.subApps.length === 0 ? (
            <p className="px-2.5 py-1.5 text-xs text-faint">No apps configured.</p>
          ) : (
            project.subApps.map((app) => (
              <SubAppRow
                key={app.id}
                app={app}
                project={project}
                target={selectedTarget}
                runner={runnerFor(app.id)}
              />
            ))
          )}
        </div>

        <div className="my-2.5 h-px bg-line-soft" />

        {/* chats — no "+" here. It fired the exact same startNewChat as the
            pinned footer button 400px below it, and two controls for one action
            in one column is how a sidebar starts feeling like a toolbar. The
            footer one wins: it's pinned, so it's reachable from any scroll
            position, and it's labelled. */}
        <div className="mb-1 flex items-center justify-between px-2.5 pb-1">
          <SectionLabel className="px-0">Chats</SectionLabel>
          {/* Every chat, folded reviewers included — the tally answers "how much
              is in this project", and a count that dropped by four when a PR got
              reviewed four times would answer something else. */}
          <span className="cm-mono !text-2xs text-faint">{chatCount || ""}</span>
        </div>
        {/* No horizontal padding and no gaps: a row's highlight has to reach both
            edges of the sidebar, which it can't do from inside a padded box, and
            square rows with air between them read as a stack of cards. */}
        <div ref={chatListRef}>
          {chatCount === 0 ? (
            <p className="px-2.5 py-1.5 text-xs text-faint">
              {project ? "No chats yet." : "Select a project to see its chats."}
            </p>
          ) : (
            branches.map((branch) => (
              <ChatBranchRows
                key={branch.chat.id}
                branch={branch}
                activeChatId={activeChatId}
                attentionByChat={attentionByChat}
                runtimeByChat={runtimeByChat}
                now={now}
                onSelect={setActiveChat}
              />
            ))
          )}
        </div>
      </ScrollArea>

      {/* new chat */}
      <div className="cm-hairline-t pb-2.5">
        <button
          onClick={startNewChat}
          disabled={!project}
          // Edge to edge and square, so the one action pinned under the list
          // belongs to the same column as the list. `bg-panel-2` still lifts it
          // off `surface` — it is a button, not a row you can land on.
          className="flex w-full items-center justify-center gap-1.5 bg-panel-2 py-2.5 text-sm font-medium text-secondary transition-colors hover:bg-active hover:text-primary disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5"
        >
          <Plus />
          New chat
        </button>
        {/* Build stamp, not a page-load clock: it says which bundle you're
            looking at, which is the first question when dev (4319) and the
            installed app (4318) disagree. */}
        <p
          className="cm-mono mt-2 text-center !text-2xs text-faint"
          title="Build version (UTC) — vyyyy.mm.dd.sssss, where sssss is the seconds elapsed since UTC midnight"
        >
          {BUILD_VERSION}
        </p>
      </div>

    </aside>
  );
}
