import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Power,
  SquareTerminal,
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
import { StatusDot, statusMeta, toneText } from "../ui/StatusDot.js";
import { formatDuration } from "../metrics/duration.js";
import { TitleText } from "../ui/TitleText.js";
import { purposeIcon } from "../config/sections.js";
import {
  childChatTint,
  childChatTitle,
  processTint,
  processTitle,
} from "./rowMarkers.js";
import { Chip } from "../ui/Chip.js";
import { Tooltip } from "../ui/Tooltip.js";
import { Spinner } from "../ui/Spinner.js";
import { ScrollArea } from "../ui/ScrollArea.js";
import { useProjects, useActiveProject } from "../../stores/projects.js";
import {
  useChats,
  useProjectChatTree,
  useProjectAgentCounts,
  isReviewerChat,
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
import { useLongPress } from "../../lib/useLongPress.js";
import { foldedChildrenLabel } from "./reviewLabel.js";
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
  const { chat, children } = branch;
  const [expanded, setExpanded] = useState(false);
  // A branch never hides the transcript that's on screen. The PRs panel links
  // straight to a reviewer chat, and landing there with its parent collapsed
  // left the sidebar with no row for what you were looking at.
  const open = expanded || children.some((c) => c.id === activeChatId);

  return (
    <div data-flip-id={chat.id}>
      <ChatRow
        chat={chat}
        active={chat.id === activeChatId}
        needsInput={attentionByChat.has(chat.id)}
        now={now}
        runtimeMs={branchRuntimeMs(runtimeByChat, chat.id, children)}
        // `childChats`, not `children`: React reads a `children` prop as the
        // element's body, so passing the list under that name would put it one
        // typo away from being rendered instead of counted.
        childChats={children}
        childrenNeedInput={children.some((c) => attentionByChat.has(c.id))}
        expanded={open}
        onToggleChildren={() => setExpanded((v) => !v)}
        onClick={() => onSelect(chat.id)}
      />
      {open && children.length > 0 && (
        // The thread rail is drawn once, absolutely, rather than as a border on
        // a padded wrapper: the wrapper's padding would inset the rows, and a
        // child row's highlight has to reach both edges exactly like every
        // other row's. Indentation is the row's own left padding instead.
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-4 w-px bg-line-soft" />
          {children.map((child) => {
            const props = {
              chat: child,
              active: child.id === activeChatId,
              needsInput: attentionByChat.has(child.id),
              now,
              runtimeMs: runtimeByChat[child.id] ?? 0,
              onClick: () => onSelect(child.id),
            };
            // Two child rows, because they have different things to say. A
            // reviewer's identity is the PR it read and the verdict it left, and
            // neither is in its title; a spawned chat's identity IS its title,
            // and it has no PR to summarise. One row doing both would spend its
            // width on a `#` column that half the children must leave blank.
            return isReviewerChat(child) ? (
              <ReviewRow key={child.id} {...props} />
            ) : (
              <SpawnRow key={child.id} {...props} />
            );
          })}
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

/**
 * A row marker's count, for assistive tech only.
 *
 * The glyphs carry their meaning in COLOUR and their counts in a tooltip, and
 * neither reaches a screen reader: `Tooltip` portals its bubble to the body
 * with nothing associating it back, and the trigger is a roleless, unfocusable
 * span. So the readable form is stated directly, inside the trigger — where it
 * joins the row button's accessible name, which is where you'd want a count
 * read out. `ProjectAgentBadge` above solves the identical problem the same way
 * and for the same reason.
 *
 * `when` is what keeps that name usable: "No child chats. No processes." on
 * every quiet row is noise in front of the title on the one row that matters.
 * A marker with nothing to report says nothing.
 */
function MarkerLabel({ text, when }: { text: string; when: boolean }) {
  return when ? <span className="sr-only">{text}</span> : null;
}

function ChatRow({
  chat,
  active,
  needsInput,
  now,
  runtimeMs,
  childChats,
  childrenNeedInput,
  expanded,
  onToggleChildren,
  onClick,
}: {
  chat: Chat;
  active: boolean;
  needsInput: boolean;
  /** Shared "current time" tick so every row ages in lockstep. */
  now: number;
  /** Agent time under this chat — its own, its subagents', its children's. */
  runtimeMs: number;
  /** Reviewer and spawned chats folded under this row. Usually empty. */
  childChats: Chat[];
  childrenNeedInput: boolean;
  expanded: boolean;
  onToggleChildren: () => void;
  onClick: () => void;
}) {
  const prSettled = useChats((s) => s.prSettled[chat.id] ?? false);
  const meta = statusMeta(chat.status, prSettled);

  // The action tray, when it was asked for by a HOLD rather than by hovering.
  //
  // A touch device has no hover, and the tray used to answer that by being
  // permanently out on a coarse pointer — a 32px gutter overhanging every title
  // in the list, on the screen with the least width to spare, and covering the
  // one part of the row you read. So on touch it now arrives the way a phone
  // asks for a row's actions anywhere else: press and hold.
  const [trayHeld, setTrayHeld] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const press = useLongPress(useCallback(() => setTrayHeld(true), []));

  // An action taken is the tray's job done, so it goes away with the press that
  // used it. Rename is where this MATTERS rather than merely tidies: the pencil
  // is inside the rail, so the dismissal below deliberately ignores it, and
  // `rename.start()` then unmounts this whole block. Commit the rename from the
  // on-screen keyboard — OS chrome, which dispatches no pointer event to the
  // page — and the rail remounts still flagged open, sliding the tray back over
  // the title you just finished editing, for nobody.
  const trayAction = (run: () => void) => () => {
    setTrayHeld(false);
    run();
  };

  // Any press OUTSIDE the tray puts it away — including elsewhere on this row,
  // and including a press on another row, which is what keeps one tray out at a
  // time without the rows having to know about each other.
  //
  // Outside the TRAY, not outside the row: the tray's own buttons are 24px and
  // they SLIDE, so dismissing on a press that lands on one would move it out
  // from under the finger before the click resolves — and a `click` whose down
  // and up have different targets is dispatched to their common ancestor, i.e.
  // never to the button that was pressed.
  useEffect(() => {
    if (!trayHeld) return;
    const onPress = (e: PointerEvent) => {
      if (e.target instanceof Node && railRef.current?.contains(e.target)) return;
      setTrayHeld(false);
    };
    window.addEventListener("pointerdown", onPress, true);
    return () => window.removeEventListener("pointerdown", onPress, true);
  }, [trayHeld]);
  // Per-row subscription: re-renders this row (and refreshes its age) the moment
  // its activity clock advances — the recency ordering itself lives in the selector.
  const activityAt = useChats(
    (s) => s.lastActivity[chat.id] ?? chat.updatedAt ?? chat.createdAt,
  );
  const age = relTimeShort(activityAt, now);
  const PurposeIcon = purposeIcon(chat.purpose?.kind);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rename = useChatRename(chat);

  const childCount = `${childChats.length} chat${childChats.length === 1 ? "" : "s"}`;

  // OS processes this branch is holding — the session subprocess, every MCP
  // server under it, and any background shell it started, summed across the
  // chats folded into the row. Per-row subscription like `activityAt`
  // above: one poll updates every row, and only the rows whose number moved
  // re-render.
  // `useMemo` over the STORE'S OWN reference, never a selector that computes.
  // `branchProcessCount` returns a fresh `{session, shells}` every call, and a
  // zustand selector is compared with `Object.is` — so as a selector this hands
  // `useSyncExternalStore` a new snapshot on every check, never converges, and
  // takes the whole app down with `Minified React error #185`. Not theoretical:
  // it did, the first time this returned an object instead of a number. Same
  // trap `useProjectChatTree` documents, and `stores/prs.ts` explains at length.
  const procByChat = useChatProcesses((s) => s.byChat);
  const procs = useMemo(
    () => branchProcessCount(procByChat, chat.id, childChats),
    [procByChat, chat.id, childChats],
  );
  const processCount = procs.session + procs.shells;
  const killProcesses = useChatProcesses((s) => s.kill);
  const [killing, setKilling] = useState(false);
  const branchRunning =
    chat.status === "running" || childChats.some((c) => c.status === "running");
  // A LABEL, not an explanation. These sit on hover over a 24px button in a
  // narrow column, and a sentence there is a paragraph floating over the
  // sidebar — the rationale belongs in Settings → Context, which is where the
  // policy is actually set. The one thing worth interrupting for is that a turn
  // is mid-flight, because that is the only part which is not recoverable.
  const killTip = branchRunning
    ? `End ${processCount} processes — interrupts a running turn`
    : `End ${processCount} processes`;

  const onKillProcesses = async (): Promise<void> => {
    if (killing) return;
    setKilling(true);
    try {
      await killProcesses(branchChatIds(chat.id, childChats));
    } finally {
      setKilling(false);
    }
  };
  // What is folded under here, for the two places that stand in for the expanded
  // rows: reviewers broken down by PR, spawned chats counted. The runtime tooltip
  // keeps the plain count — it is about where the time went, and a per-PR
  // breakdown there is noise.
  const foldedLabel = foldedChildrenLabel(childChats);

  return (
    // `overflow-hidden` is what lets the action tray start fully off the row and
    // slide in: clipped HERE it can never reach the scroll container, where an
    // element past the right edge turns `overflow-y: auto` into a horizontal
    // scrollbar across the whole list.
    <div className="group/row relative overflow-hidden">
      <button
        data-testid="chat-row"
        {...press.press}
        // The click that ends a hold belongs to the gesture. Without this,
        // holding a row to reach its delete button also navigates you into the
        // chat you were about to act on.
        onClick={(e) => {
          if (press.swallowsClick(e)) return;
          onClick();
        }}
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
        {/* What this row is holding, stacked in its own gutter between the
            status marker and the title.

            Always mounted, faint when there is nothing to report, because the
            alternative is a title that starts at a different x on every other
            row — and the eye reads a ragged left edge as disorder long before it
            reads the missing glyph as "nothing here". Faint IS the empty state.

            10px glyphs, no digits: see `rowMarkers`, which owns the colour
            rules and puts the counts in the tooltips.

            The shared `Tooltip`, NOT a `title` attribute. A native tooltip is
            the browser's to schedule — around a second of hover before it
            appears, if it appears at all — and these glyphs are the ONLY place
            the counts live now, so "hover and wait and maybe" is not a way to
            read them. The portal also gets the bubble out from under the row's
            `overflow-hidden`.

            The padding is the hover TARGET: a 10px glyph is not something you
            can reliably put a pointer on, and it buys the gap between the two
            at the same time — they still read as one two-storey marker rather
            than two markers that happen to be near each other. */}
        <span className="-mx-1.5 flex shrink-0 flex-col items-center [&_svg]:size-2.5">
          <Tooltip
            side="right"
            label={childChatTitle(childChats, childrenNeedInput)}
            triggerClassName={cn(
              "px-1.5 py-0.5 transition-colors duration-300",
              childChatTint(childChats, childrenNeedInput),
            )}
          >
            <MessagesSquare aria-hidden />
            <MarkerLabel
              text={childChatTitle(childChats, childrenNeedInput)}
              when={childChats.length > 0}
            />
          </Tooltip>
          <Tooltip
            side="right"
            label={processTitle(procs)}
            triggerClassName={cn("px-1.5 py-0.5 transition-colors duration-300", processTint(procs))}
          >
            <SquareTerminal aria-hidden />
            <MarkerLabel text={processTitle(procs)} when={processCount > 0} />
          </Tooltip>
        </span>
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
                    childChats.length
                      ? `${formatDuration(runtimeMs)} of agent time — this chat, its ` +
                        `subagents, and ${childCount}`
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
            // Selectable again, against the column's blanket `select-none`.
            // Nothing resets `user-select` for form controls, so the input
            // INHERITS it — measured `none` here against `auto` for the same
            // control outside the aside — and this field is the far end of the
            // very flow the blanket exists for: hold the row, tap the pencil,
            // land in a title you now cannot select to replace. On iOS the
            // callout is also how Select All and Paste are reached at all.
            className="w-full select-text [-webkit-touch-callout:default] border border-accent-line bg-inset px-1.5 py-0.5 text-base font-semibold text-primary outline-none"
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
          flow, and why they stand down for EVERY way the tray can arrive:
          pointer hover, keyboard focus landing in the rail, or a touch HOLD.

          The hold is the touch answer, and `data-tray` is what carries it —
          an ATTRIBUTE variant rather than a conditional class, because `cn` is
          plain clsx with no conflict resolution, so a bare `translate-x-0`
          would sit beside `translate-x-full` as two same-specificity utilities
          and win or lose on emit order. `group-data-…` compiles to a class +
          attribute selector, which is how the hover and focus variants beside
          it already outrank the resting transform. Same reason `ui/IconButton`
          reads its selected look off `aria-current`. */}
      {!rename.editing && (
        <div
          ref={railRef}
          data-tray={trayHeld ? "open" : undefined}
          className="group/rail absolute inset-y-0 right-0"
        >
          {needsInput && (
            <span
              className={cn(
                // The scroll track shares this surface's background, so gutter
                // and scrollbar read as one undifferentiated band and the dot
                // looked like it was floating in it.
                "pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2.5",
                "group-hover/row:hidden group-focus-within/rail:hidden",
                "group-data-[tray=open]/rail:hidden",
              )}
            >
              {/* All that is left out here. The counts for child chats and
                  processes moved to the stacked glyphs beside the title, where
                  they are visible on EVERY row rather than only at rest — the
                  gutter's markers vanish the moment the tray slides in, which
                  is exactly when you are deciding whether to press Power. */}
              <StatusDot tone="warn" pulse size={6} />
            </span>
          )}
          <div
            className={cn(
              "absolute inset-y-0 right-0 flex items-center gap-0.5 border-l border-line px-1.5",
              "translate-x-full transition-transform duration-150 ease-[var(--ease-out)]",
              "group-hover/row:translate-x-0 group-focus-within/rail:translate-x-0",
              "group-data-[tray=open]/rail:translate-x-0",
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
              <IconButton size="sm" tip={killTip} disabled={killing} onClick={trayAction(onKillProcesses)}>
                <Power />
              </IconButton>
            )}
            {childChats.length > 0 && (
              <IconButton
                size="sm"
                active={expanded}
                aria-expanded={expanded}
                tip={expanded ? `Hide ${foldedLabel}` : `Show ${foldedLabel}`}
                onClick={trayAction(onToggleChildren)}
              >
                <MessagesSquare />
              </IconButton>
            )}
            <IconButton size="sm" tip="Rename chat" onClick={trayAction(rename.start)}>
              <Pencil />
            </IconButton>
            <IconButton size="sm" tip="Delete chat" onClick={trayAction(() => setConfirmDelete(true))}>
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

/**
 * A folded row for a chat another chat SPAWNED — title, status, age.
 *
 * Deliberately not `ReviewRow` with the PR bits blanked. That row spends its
 * first column on `#140` and its middle on what the review posted, and a spawned
 * chat has neither: it would show `PR` over an empty column for every row, which
 * is the layout claiming a fact it does not have. What identifies a spawned chat
 * is the title its brief was given, so the title is what gets the width.
 *
 * Everything else is `ReviewRow`'s, on purpose — the same left padding so both
 * kinds line up against the one thread rail, the same full-bleed highlight, the
 * same status glyph and pulse, the same age-or-attention-dot at the right edge.
 * A branch holding one of each should read as one list, not two.
 */
function SpawnRow({
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
  const activityAt = useChats(
    (s) => s.lastActivity[chat.id] ?? chat.updatedAt ?? chat.createdAt,
  );
  const meta = statusMeta(chat.status);

  return (
    <button
      data-testid="spawn-row"
      onClick={onClick}
      title={chat.title}
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
        className={cn(
          "min-w-0 flex-1 truncate text-2xs",
          active ? "text-primary" : "text-secondary",
        )}
      >
        <TitleText title={chat.title} />
      </span>
      {/* The status word, which the reviewer row spends on its verdict instead.
          Dimmer than the title: on a row whose point is WHICH chat this is, the
          title has to win, and five children all saying "Idle" in full strength
          is a column of noise beside five titles that differ. */}
      <span className={cn("shrink-0 text-2xs", toneText(meta.tone), "opacity-80")}>
        {meta.label}
      </span>
      {runtimeMs > 0 && (
        <span
          className="shrink-0 text-2xs text-accent-2"
          title={`${formatDuration(runtimeMs)} of agent time`}
        >
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
  const chatCount = branches.reduce((n, b) => n + 1 + b.children.length, 0);
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
        // NOT SELECTABLE on a coarse pointer, on purpose, and there it has to
        // be the whole column.
        //
        // `ChatRow`'s tray opens on a press-and-hold, and press-and-hold is
        // already spoken for on a touch device: it is how you select text, and
        // on iOS how you raise the callout over what you selected. Left alone,
        // holding a row hands you a blue selection over the chat's title and a
        // Copy bubble on top of the tray you asked for.
        //
        // `pointer-coarse:` because that conflict is the WHOLE reason, and it
        // does not exist for a mouse — dragging is how you select, and nothing
        // here opens on a slow click. Unconditional, this would cost the build
        // stamp at the bottom of the column: it renders in full precisely so it
        // can answer "which bundle am I looking at" in a bug report, and taking
        // away copy would leave you retyping it by eye off a `!text-2xs` mono
        // line. Same signal `index.css` uses for its other touch-only rules.
        "pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none]",
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
