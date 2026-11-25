/**
 * The sidebar's project switcher: the header row that says which project you
 * are in, and the menu that moves you to another one.
 *
 * It was a flat list of every project in creation order between two dividers,
 * which stopped scaling somewhere past a dozen repos — picking one meant reading
 * the whole column every time. So the menu now leads with a search box (focused
 * on open where there is a real keyboard), puts the two non-project
 * destinations beside it as tiles rather than as rows you have to scroll past,
 * and orders the list by when you last spoke to each project, with A–Z one
 * click away and remembered.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowDownAZ,
  Bot,
  ChevronsUpDown,
  Clock,
  FolderGit2,
  Globe,
  LayoutGrid,
  Pause,
  Play,
  Plus,
  Search,
  X,
} from "lucide-react";
import { GLOBAL_PROJECT_ID, type PauseState } from "@dispatch/shared";
import { useShallow } from "zustand/react/shallow";
import { Popover, MenuItem } from "../ui/Popover.js";
import { IconButton } from "../ui/IconButton.js";
import { RowButton } from "../ui/RowButton.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { StatusDot, toneText } from "../ui/StatusDot.js";
import { Tooltip } from "../ui/Tooltip.js";
import { Kbd } from "../ui/Kbd.js";
import { useActiveProject, useRealProjects } from "../../stores/projects.js";
import { useChats, useProjectAgentCounts, type ProjectAgentCounts } from "../../stores/chats.js";
import { useScheduler } from "../../stores/scheduler.js";
import { useLayoutMode } from "../../stores/layout.js";
import { goHome, selectGlobalChat, selectProject } from "../../stores/navigation.js";
import { cn } from "../../lib/cn.js";
import { midTruncate, relTimeShort } from "../../lib/format.js";
import {
  loadProjectSort,
  projectLastTouched,
  rankProjects,
  saveProjectSort,
  type ProjectSort,
} from "./projectRanking.js";

/**
 * The right-hand half of a project row: how many agents are live in it.
 *
 * Three tallies, never summed into one number — "3 working", "2 queued" and
 * "1 waiting on you" are different calls to action, and a project you have to go
 * answer must not hide inside a busy-looking count. Queued is kept apart from
 * working for the same reason in the other direction: a project whose turns are
 * all parked behind the context cap has nothing moving in it, and reading as
 * busy is exactly the wrong signal when you are picking where to go next.
 *
 * `queued` and `working` share the accent family — see `statusMeta` — so they
 * are separated by FILL, not hue: a live agent is a pulsing disc, a queued one a
 * still outline. Nothing renders for a quiet project: a row of zeroes would make
 * the menu read as a dashboard rather than a picker.
 */
function ProjectAgentBadge({ counts }: { counts: ProjectAgentCounts | undefined }) {
  const working = counts?.working ?? 0;
  const queued = counts?.queued ?? 0;
  const attention = counts?.attention ?? 0;
  if (!working && !queued && !attention) return null;

  // "working" rather than "running": the count also covers `waiting`, which is
  // an agent with a tool in flight but nothing streaming.
  const label = [
    attention ? `${attention} awaiting input` : null,
    working ? `${working} working` : null,
    queued ? `${queued} queued` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span className="flex items-center gap-1.5 tabular-nums" title={label}>
      {/* The dots carry the meaning by colour and fill alone, so the readable
          form goes to assistive tech directly — a `title` is not reliably
          announced. */}
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
      {queued > 0 && (
        <span aria-hidden className={cn("flex items-center gap-1", toneText("accent"))}>
          {/* A touch larger than the filled dots: at 5px the hole inside a
              1.5px ring closes up and the outline reads as a disc again. */}
          <StatusDot tone="accent" hollow size={7} />
          {queued}
        </span>
      )}
    </span>
  );
}

/** Stable empty fallback — a fresh `{}` per render would re-render every subscriber. */
const NO_PAUSES: Record<string, PauseState> = {};

export function ProjectSwitcher({
  onAddProject,
  onManageConfig,
}: {
  onAddProject: () => void;
  onManageConfig: () => void;
}) {
  const active = useActiveProject();
  const globalActive = active?.id === GLOBAL_PROJECT_ID;
  const activePaused = useScheduler((s) =>
    active ? s.snapshot?.projectPauses?.[active.id] !== undefined : false,
  );
  const sm = useLayoutMode() === "sm";

  return (
    <Popover
      align="start"
      // Wide enough for a name, the agent tallies, an age and the pause toggle
      // on one line; Popover clamps it to the viewport on a phone.
      width={sm ? 320 : 288}
      className="flex flex-col !overflow-hidden"
      // Without this the row is only as wide as its own content: the trigger
      // wrapper is `inline-flex`, so the button's `w-full` measures against
      // itself. A short project name left the highlight stopping mid-band with
      // bare `surface` beside it, and the chevron floating mid-row.
      triggerClassName="w-full"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          className={cn(
            // Full-bleed and square, like every other row in this column: it
            // fills the header band rather than sitting in it as a card, so the
            // sidebar has ONE row shape from the project name to the last chat.
            "flex h-12 w-full items-center gap-2 px-2.5 text-left transition-colors hover:bg-hover",
            open && "bg-active",
          )}
        >
          {/* Bare glyph, no tile: the accent fill and ring read as a badge on a
              row that is already the header. The span keeps size-6 so the
              title's left edge doesn't move. */}
          <span className="flex size-6 items-center justify-center text-accent [&_svg]:size-4">
            {globalActive ? <Globe /> : <FolderGit2 />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base font-semibold text-primary">
              {active?.name ?? "No project"}
            </span>
            <span className="block truncate cm-mono !text-2xs text-faint">
              {/* A path is the useful subtitle for a repo and a misleading one
                  for the global chat, whose repoPath is an empty scratch dir
                  nobody should go looking for. */}
              {globalActive
                ? "every project · spawn and observe"
                : active
                  ? midTruncate(active.repoPath, 30)
                  : "—"}
            </span>
          </span>
          {/* The menu says it too, but that is closed — and a project you are
              sitting in that silently won't run is the confusing case. */}
          {activePaused && (
            <Tooltip label="This project is paused — resume it from this menu">
              <span className="flex shrink-0 text-warn [&_svg]:size-3.5">
                <Pause aria-label="Project paused" />
              </span>
            </Tooltip>
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 text-faint" />
        </button>
      )}
    >
      {(close) => (
        <SwitcherMenu
          close={close}
          touch={sm}
          activeId={active?.id ?? null}
          onAddProject={onAddProject}
          onManageConfig={onManageConfig}
        />
      )}
    </Popover>
  );
}

/**
 * Only true where focusing a field costs nothing. On a phone it would summon
 * the soft keyboard over the very list you opened the menu to tap, so there you
 * get the list first and the search box is one tap away.
 */
function hasRealKeyboard(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
}

/**
 * The menu body. Its own component so the per-chat subscription below only
 * exists while the menu is open: recency is a fold over EVERY chat, and the
 * chat map churns on every streamed status change.
 */
function SwitcherMenu({
  close,
  touch,
  activeId,
  onAddProject,
  onManageConfig,
}: {
  close: () => void;
  touch: boolean;
  activeId: string | null;
  onAddProject: () => void;
  onManageConfig: () => void;
}) {
  // Real repos only — the global chat is NOT one of them and gets its own tile.
  // Listing it among the projects would read as "a repo called Global", which
  // is exactly the leak this pseudo-project approach has to avoid.
  const projects = useRealProjects();
  const agentCounts = useProjectAgentCounts();
  const chatsById = useChats(useShallow((s) => s.byId));
  const projectPauses = useScheduler((s) => s.snapshot?.projectPauses ?? NO_PAUSES);
  const scopedBusy = useScheduler((s) => s.scopedBusy);

  const [query, setQuery] = useState("");
  const [sort, setSortState] = useState<ProjectSort>(loadProjectSort);
  const setSort = (s: ProjectSort) => {
    setSortState(s);
    saveProjectSort(s);
  };
  // -1 = nothing highlighted. With no query there is no "best match" for Enter
  // to take, and pre-highlighting the top row made it look selected.
  const [hi, setHi] = useState(-1);

  const lastTouched = useMemo(
    () => projectLastTouched(projects, Object.values(chatsById)),
    [projects, chatsById],
  );
  const ranked = useMemo(
    () => rankProjects(projects, { query, sort, lastTouched }),
    [projects, query, sort, lastTouched],
  );
  const now = Date.now();

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A frame late on purpose: Popover's first render is an invisible measuring
  // pass, and `visibility: hidden` elements refuse focus.
  useEffect(() => {
    if (!hasRealKeyboard()) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    if (hi < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${hi}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const pick = (id: string) => {
    selectProject(id);
    close();
    // Deliberately NOT dismissLeftDrawer(): unlike the sidebar's nav items,
    // switching project navigates you INTO the sidebar, not out of it.
    // `selectProject` clears the open chat, so closing the drawer here left a
    // phone staring at the empty state with the chat list it needs to pick
    // from hidden behind a second tap.
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((i) => Math.min(ranked.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      const target = ranked[hi < 0 ? 0 : hi];
      if (target && (hi >= 0 || query.trim())) {
        e.preventDefault();
        pick(target.project.id);
      }
    }
  };

  return (
    <>
      {/* ── header: find + the two places that aren't a project ───────── */}
      <div className="shrink-0 space-y-1.5 p-1.5 cm-hairline-b">
        <label
          className={cn(
            "flex items-center gap-2 rounded-md border border-line bg-inset px-2 transition-colors",
            "focus-within:border-accent-line",
            touch ? "h-10" : "h-8",
          )}
        >
          <Search className="size-3.5 shrink-0 text-faint" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHi(e.target.value.trim() ? 0 : -1);
            }}
            onKeyDown={onKeyDown}
            placeholder="Find a project…"
            aria-label="Find a project"
            // `!shadow-none`: opt out of the global `:focus-visible` ring. The
            // LABEL is the field you perceive and it already lights its border
            // via `focus-within`; the ring drew a second box inset inside it.
            className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none !shadow-none placeholder:text-faint"
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="go"
          />
          {query ? (
            <IconButton
              tip="Clear"
              className="-mr-1"
              onClick={() => {
                setQuery("");
                setHi(-1);
                inputRef.current?.focus();
              }}
            >
              <X />
            </IconButton>
          ) : (
            !touch && <Kbd>↑↓</Kbd>
          )}
        </label>
        {/* The two destinations that are not repos, as tiles beside the search
            rather than rows among the projects. Overview leads because this
            control is already "which project am I in", and "all of them" is
            the same question one level up.

            Overview, unlike picking a project, DOES dismiss the chat picker on a
            phone — `goHome` clears `leftOpen` itself. The overview is
            full-bleed, so `App` stops rendering the drawer entirely, and a flag
            left set would have `currentSlot` reporting a picker that isn't on
            screen.

            Global chat is routed through `selectGlobalChat` like every other
            navigation: it is a project id as far as the stores are concerned,
            so the project↔chat invariant applies to it unchanged. */}
        <div className="grid grid-cols-2 gap-1.5">
          <Tile
            icon={<LayoutGrid />}
            touch={touch}
            onClick={() => {
              goHome();
              close();
            }}
          >
            Overview
          </Tile>
          <Tile
            icon={<Globe />}
            touch={touch}
            active={activeId === GLOBAL_PROJECT_ID}
            onClick={() => {
              selectGlobalChat();
              close();
            }}
          >
            Global chat
          </Tile>
        </div>
      </div>

      {/* ── list heading + sort ─────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center justify-between gap-2 px-2.5 pb-1 pt-2">
        <span className="text-2xs font-medium uppercase tracking-wider text-faint">
          Projects
          <span className="ml-1.5 tabular-nums normal-case tracking-normal">
            {query.trim() ? `${ranked.length}/${projects.length}` : projects.length}
          </span>
        </span>
        <SegmentedControl<ProjectSort>
          compact
          value={sort}
          onChange={setSort}
          segments={[
            { value: "recent", label: "Most recently used", icon: <Clock /> },
            { value: "name", label: "Alphabetical", icon: <ArrowDownAZ /> },
          ]}
        />
      </div>

      {/* ── the list ───────────────────────────────────────────────────── */}
      <div
        ref={listRef}
        role="listbox"
        aria-label="Projects"
        className="cm-scroll min-h-0 flex-1 overflow-y-auto px-1 pb-1"
        // Its own scroller, so the search box and the actions below stay put
        // however many repos there are. Capped so a long list leaves the footer
        // on screen instead of pushing it off the bottom of the menu.
        style={{ maxHeight: touch ? "min(52dvh, 440px)" : "min(56vh, 420px)" }}
        onMouseLeave={() => !query.trim() && setHi(-1)}
      >
        {projects.length === 0 ? (
          <p className="px-2 py-3 text-xs text-faint">No projects yet.</p>
        ) : ranked.length === 0 ? (
          <p className="px-2 py-3 text-xs text-faint">
            Nothing matches “{query.trim()}”.
          </p>
        ) : (
          ranked.map(({ project: p, nameHits, pathOnly }, idx) => {
            const paused = projectPauses[p.id];
            const isActive = p.id === activeId;
            const touched = lastTouched[p.id];
            return (
              <div key={p.id} data-idx={idx} className="group/proj relative flex items-center">
                <RowButton
                  role="option"
                  aria-selected={isActive}
                  onClick={() => pick(p.id)}
                  onMouseMove={() => setHi(idx)}
                  title={p.repoPath}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm pl-2 pr-9",
                    touch ? "min-h-11 py-2 text-base" : "py-1.5 text-sm",
                    idx === hi ? "bg-active text-primary" : "text-secondary",
                    isActive && "text-primary",
                  )}
                >
                  <FolderGit2
                    aria-hidden
                    className={cn("size-3.5 shrink-0", isActive ? "text-accent" : "text-muted")}
                  />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate", isActive && "font-medium")}>
                      <Highlighted text={p.name} hits={nameHits} />
                    </span>
                    {/* Shown only when the PATH is why the row is here — a
                        listed "zeta" for the query "claude" looks like a bug
                        until you can see it lives in claude-manager/. */}
                    {pathOnly && (
                      <span className="block truncate cm-mono !text-2xs text-faint">
                        {midTruncate(p.repoPath, 40)}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-2xs text-faint">
                    {paused ? (
                      <span className="text-warn">paused</span>
                    ) : (
                      <ProjectAgentBadge counts={agentCounts[p.id]} />
                    )}
                    {/* The sort key, made visible: "why is this one on top" is
                        answered on the row instead of left to trust. */}
                    {sort === "recent" && touched ? (
                      <span className="w-6 text-right tabular-nums">{relTimeShort(touched, now)}</span>
                    ) : null}
                  </span>
                </RowButton>
                {/* A sibling, not a child: a button inside a button is invalid
                    and swallows the inner click. Shown on hover only while
                    running — thirteen pause glyphs down the menu would read as
                    thirteen things to worry about — but always once paused,
                    since that is the state to undo. Always shown where there is
                    no hover to reveal it. The menu stays open so the row
                    visibly flips.

                    The positioning is on THIS span, not the IconButton: a `tip`
                    wraps the button in Tooltip's own `relative inline-flex`
                    span, so `absolute` on the button resolved against that
                    zero-width wrapper and the glyph hung off the menu's edge. */}
                <span
                  className={cn(
                    "absolute inset-y-0 right-1 flex items-center",
                    !paused &&
                      "opacity-0 focus-within:opacity-100 group-hover/proj:opacity-100 [@media(hover:none)]:opacity-100",
                  )}
                >
                  <IconButton
                    tip={
                      paused
                        ? `Resume ${p.name} — tell ${paused.interrupted.length || "no"} interrupted chat${paused.interrupted.length === 1 ? "" : "s"} what happened, then run its queue`
                        : `Pause ${p.name} — interrupt its running turns and hold new ones`
                    }
                    disabled={!!scopedBusy[`project:${p.id}`]}
                    onClick={() => {
                      const s = useScheduler.getState();
                      void (paused ? s.resumeProject(p.id) : s.pauseProject(p.id));
                    }}
                  >
                    {/* Faint until reached for. On touch the glyph is always
                        shown, and fifteen RED pause bars down a phone-width
                        menu read as fifteen alarms. */}
                    {paused ? (
                      <Play className="text-accent-hi" />
                    ) : (
                      <Pause className="text-faint transition-colors group-hover/proj:text-danger" />
                    )}
                  </IconButton>
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* ── actions ────────────────────────────────────────────────────── */}
      <div className="shrink-0 p-1 cm-hairline-t">
        <MenuItem
          icon={<Plus />}
          dense={!touch}
          onClick={() => {
            close();
            onAddProject();
          }}
        >
          New project…
        </MenuItem>
        <MenuItem
          icon={<Bot />}
          dense={!touch}
          onClick={() => {
            close();
            onManageConfig();
          }}
        >
          Agents &amp; modes…
        </MenuItem>
      </div>
    </>
  );
}

function Tile({
  icon,
  children,
  onClick,
  active,
  touch,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  touch: boolean;
}) {
  return (
    <RowButton
      onClick={onClick}
      aria-current={active || undefined}
      className={cn(
        "flex items-center gap-2 rounded-md border px-2 text-xs font-medium [&_svg]:size-3.5",
        touch ? "h-10" : "h-8",
        active
          ? "border-accent-line bg-accent-ghost text-primary [&_svg]:text-accent"
          : "border-line text-secondary hover:border-line-strong hover:bg-hover hover:text-primary [&_svg]:text-muted",
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </RowButton>
  );
}

/** `text` with the characters at `hits` picked out — so you can see what your query matched. */
function Highlighted({ text, hits }: { text: string; hits: number[] }) {
  if (hits.length === 0) return <>{text}</>;
  const set = new Set(hits);
  const out: ReactNode[] = [];
  let run = "";
  let runHit = set.has(0);
  const flush = (key: number) => {
    if (!run) return;
    out.push(
      runHit ? (
        <span key={key} className="font-semibold text-accent-hi">
          {run}
        </span>
      ) : (
        run
      ),
    );
  };
  for (let i = 0; i < text.length; i++) {
    const h = set.has(i);
    if (h !== runHit) {
      flush(i);
      run = "";
      runHit = h;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}
