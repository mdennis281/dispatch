/**
 * The homepage — what is happening across every project, and where you pick the
 * one you want.
 *
 * ── WHAT THIS PAGE LEADS WITH, AND WHY IT CHANGED ────────────────────────────
 *
 * It led with numbers: a 5xl runtime hero, four stat tiles, and a grid of nine
 * project cards each with a sparkline. The verdict was "looks like another
 * metrics page", and that was right — the figures were all true and none of them
 * answered the question you actually arrive with, which is *what is going on
 * right now*. Three agents running, one blocked on a question, four worktrees
 * checked out and two PRs waiting on CI is the state of the install; a tool-call
 * count for the last seven days is trivia beside it.
 *
 * So the order is now: the CHATS (nested, grouped by what they're doing — see
 * `HomeChats`), the WORKTREES, the PULL REQUESTS, and only then the rollup, as a
 * single stacked column in a smaller footprint. The numbers are all still here.
 * They have simply stopped being the page.
 *
 * ── THE THREE NEW LISTS COST NOTHING ─────────────────────────────────────────
 *
 * None of them is behind `GET /api/home` and none of them should be. Every chat
 * in the install is already in `stores/chats` and every tracked PR in
 * `stores/prs`, both hydrated on connect and both following live events — so the
 * lists are a fold over memory that updates as things happen, where a copy on
 * the overview endpoint would have been a second, staler answer sitting behind a
 * TTL. The endpoint still owns exactly what only the ledger can answer: the
 * rollup. It remains one request, one pass over `data/state.db`, and zero
 * subprocesses.
 *
 * ── WHY IT IS FULL-BLEED ─────────────────────────────────────────────────────
 *
 * No sidebar, like `new-project`: the sidebar's top control IS a project picker
 * and this page's project list is also one. Two of them side by side would
 * disagree about which project is "active" — the rail is scoped to one, this
 * page is scoped to none — and the reader would have to work out which one their
 * click meant.
 *
 * That is also why the GLOBAL CHAT button is in this header. The global chat
 * shipped with exactly one entry point, a row in the sidebar's project selector;
 * this page hides the sidebar, so the one surface in the app that is
 * conceptually global had no way to open the one chat that is. It routes through
 * `selectGlobalChat` like every other navigation — the pseudo-project is a
 * project id as far as the stores are concerned, and the project↔chat invariant
 * applies to it unchanged.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
 *
 * LIVE PR AND CI READS. The PR card above is the registry's own cached snapshot,
 * never a `gh` call — see `HomePrs`. THE GROWTH CURVE, which walks git history
 * and streams NDJSON because it needs a progress bar. MOBILE SWIPE GESTURES,
 * out of scope by decision: the homepage is reached on a phone the way every
 * other destination is, through the brand mark in the top bar, and nothing here
 * touches the shell's geometry or the viewport.
 */
import { Activity, Clock, FolderGit2, Globe, Inbox, RefreshCw, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import {
  HOME_SPARK_UNIT,
  HOME_WINDOW_LABELS,
  type HomeProject,
  type HomeWindow,
} from "@dispatch/shared";
import { ScrollArea } from "../ui/ScrollArea.js";
import { IconButton } from "../ui/IconButton.js";
import { Button } from "../ui/Button.js";
import { RowButton } from "../ui/RowButton.js";
import { Tabs } from "../ui/Tabs.js";
import { DispatchMark } from "../ui/DispatchMark.js";
import { StatusDot, toneText } from "../ui/StatusDot.js";
import { Card, compact, count, ago } from "../metrics/chrome.js";
import { formatDuration } from "../metrics/duration.js";
import { Sparkline } from "./Sparkline.js";
import { HomeChats } from "./HomeChats.js";
import { HomeWorktrees } from "./HomeWorktrees.js";
import { HomePrs } from "./HomePrs.js";
import { useHome } from "../../stores/home.js";
import { openProject, selectGlobalChat } from "../../stores/navigation.js";
import { midTruncate } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";

/** The window picker. Three widths, because it is a glance and not a report. */
const WINDOWS: HomeWindow[] = ["24h", "7d", "30d"];

export function HomeView() {
  const overview = useHome((s) => s.overview);
  const loading = useHome((s) => s.loading);
  const refetching = useHome((s) => s.refetching);
  const error = useHome((s) => s.error);
  const fetchMs = useHome((s) => s.fetchMs);
  const window = useHome((s) => s.window);
  const setWindow = useHome((s) => s.setWindow);
  const load = useHome((s) => s.load);

  // One fetch on arrival, no polling — see stores/home. The store holds the
  // previous snapshot across visits, so this is a `refetching` on every visit
  // after the first and the numbers never blink.
  useEffect(() => {
    void load();
  }, [load]);

  // A clock, NOT a poll. Every relative stamp fed by the SNAPSHOT — the footer's
  // "as of", each project row's last-touched, every line of the tail — is
  // computed during render from `Date.now()`, and a page that deliberately
  // doesn't refetch would otherwise keep insisting the reading was from "just
  // now" an hour later, which is worse than no stamp at all.
  //
  // The lists above it don't need this: they are driven by live store events and
  // re-render when their own rows move.
  //
  // One `setState` a minute, and it fetches nothing. `ago()` is minute-grained
  // above the first minute, so that is exactly the rate at which its output can
  // change.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const totals = overview?.totals;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <div className="flex h-12 shrink-0 items-center gap-2 px-3 cm-hairline-b">
        <DispatchMark className="size-5 shrink-0" />
        <span className="text-base font-semibold text-primary">Overview</span>
        <div className="flex-1" />
        {/* THE GLOBAL CHAT'S ONLY ENTRY POINT WITHOUT A SIDEBAR. See the module
            docblock. Labelled rather than an icon button: it STARTS something,
            and the one other control up here (Reload) is a glyph precisely
            because it doesn't. The label survives at `sm` — it is three words
            and this bar has nothing else competing for the width. */}
        <Button size="sm" leftIcon={<Globe />} onClick={() => selectGlobalChat()}>
          Global chat
        </Button>
        {/* FORCED. The server answers every ordinary request from its cache —
            that is the whole design — so an unforced reload would return the
            same snapshot it started with and the button would be a spinner that
            changes nothing. See `HomeService.overview`. */}
        <IconButton size="sm" tip="Reload" onClick={() => void load({ force: true })}>
          <RefreshCw className={cn(refetching && "animate-spin")} />
        </IconButton>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {/* `max-w` with auto margins: these are rows in cards, and a row stretched
            across a 2560px monitor puts its two ends in different postcodes. */}
        <div className="mx-auto flex max-w-5xl flex-col gap-3 p-3 sm:p-4">
          {/* Shown whenever there IS an error, not only when there is nothing to
              paint under it. Once the first load succeeds the store keeps the
              last snapshot forever, so gating the banner on `!overview` meant a
              failed Reload stopped the spinner, left the old figures up and said
              nothing — the one case where the user explicitly asked for a newer
              number and silently did not get one.

              It is about the ROLLUP only. The lists below are live from the
              stores and are unaffected by a failed overview fetch, which is why
              this sits above the activity card rather than at the top of the
              page where it would read as "this page is broken". */}
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-danger-line bg-danger-ghost px-3 py-2 text-xs text-danger"
            >
              {overview
                ? `Could not refresh the rollup: ${error}. Showing the last reading.`
                : error}
            </p>
          )}

          <HomeChats />
          <HomeWorktrees />
          <HomePrs />

          {/* THE DEMOTED ROLLUP. One card, one column, stacked: the totals as a
              strip of small figures, then one row per project with its shape
              beside it. It was a hero plus four tiles plus a three-across card
              grid, which is the same information in four times the height and
              read as the point of the page. */}
          <Card
            title="Activity"
            icon={<Activity />}
            controls={
              <Tabs
                value={window}
                onChange={(id) => setWindow(id as HomeWindow)}
                tabs={WINDOWS.map((w) => ({ id: w, label: HOME_WINDOW_LABELS[w] }))}
              />
            }
            note={overview ? "busiest project first" : undefined}
          >
            {/* FOUR figures on one line, not four boxes. Runtime still leads —
                it is the only one that is a RESOURCE rather than a count — but
                as the first item in a strip instead of a 5xl number with a
                paragraph of white space under it. */}
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-3 py-2 cm-hairline-b">
              <Figure
                label="Runtime"
                value={totals ? formatDuration(totals.runtimeMs) : "—"}
                title="Agent runtime in this window — attributed, so parallel tool calls each count"
              />
              <Figure
                label="Tool calls"
                value={totals ? compact(totals.events) : "—"}
                title="Recorded activity in this window: tool calls, skills, MCP"
              />
              <Figure
                label="Chats"
                value={totals ? count(totals.chats) : "—"}
                title={totals ? `across ${count(totals.projects)} projects` : undefined}
              />
              {/* The two LIVE figures sit at the far end with their dots, which
                  is the one piece of emphasis left in this card: everything
                  beside them is a reading, and these two are a state. */}
              <div className="ml-auto flex items-baseline gap-x-5">
                <Figure
                  label="Working"
                  value={totals ? count(totals.working) : "—"}
                  tone={totals && totals.working > 0 ? "working" : undefined}
                />
                <Figure
                  label="Needs you"
                  value={totals ? count(totals.attention) : "—"}
                  tone={totals && totals.attention > 0 ? "warn" : undefined}
                />
              </div>
            </div>

            {loading && !overview ? (
              <Skeleton rows={3} />
            ) : overview && overview.projects.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-faint">
                No projects yet. Add one from the sidebar&rsquo;s project menu.
              </p>
            ) : (
              overview?.projects.map((p) => (
                <ProjectRow key={p.id} project={p} window={window} />
              ))
            )}
          </Card>

          <Card title="Recent activity" icon={<Zap />}>
            {loading && !overview ? (
              <Skeleton rows={5} />
            ) : overview && overview.recent.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-faint">
                Nothing recorded in this window.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {overview?.recent.map((r, i) => (
                  <li
                    // The ledger's rowid isn't on the wire, and two rows CAN
                    // share a (ts, identifier) — the index is the only stable
                    // key, and the list is replaced wholesale on every load.
                    key={`${r.ts}-${r.identifier}-${i}`}
                    className="flex items-baseline gap-2 px-3 py-1.5 text-xs"
                  >
                    <span className="cm-mono shrink-0 !text-2xs text-faint">{ago(r.ts)}</span>
                    <span className="truncate font-medium text-secondary">{r.identifier}</span>
                    <span className="ml-auto min-w-0 truncate text-2xs text-faint">
                      {r.projectName ?? "—"}
                      {r.chatTitle ? ` · ${r.chatTitle}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* The page's own receipt. A cached snapshot is served in single-digit
              milliseconds and may be a few seconds old (see server/services/home),
              so saying how old and how long it took is cheaper than pretending it
              is live. It covers the rollup only — the lists above are live. */}
          {overview && (
            <p className="cm-mono px-1 pb-1 !text-2xs text-faint">
              rolled up in {overview.computeMs}ms
              {fetchMs !== null && `, served in ${fetchMs}ms`} · as of {ago(overview.computedAt)}
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/**
 * One figure in the totals strip — label above, value below, inline.
 *
 * Deliberately not `StatTile`: that is a bordered box with a hint line, built
 * for a row of four across the top of the Metrics page, and four of them here
 * would reinstate exactly the footprint this rework was asked to shrink.
 */
function Figure({
  label,
  value,
  hint,
  tone,
  title,
}: {
  label: string;
  value: string;
  hint?: string;
  /** Set only when the figure is non-zero and LIVE — gets a pulsing dot. */
  tone?: "working" | "warn";
  title?: string;
}) {
  return (
    <span className="flex flex-col" title={title}>
      <span className="text-2xs text-muted">{label}</span>
      <span className="flex items-center gap-1.5">
        {tone && <StatusDot tone={tone} pulse size={5} />}
        <span className={cn("text-sm font-semibold", tone ? toneText(tone) : "text-primary")}>
          {value}
        </span>
        {hint && <span className="text-2xs text-faint">{hint}</span>}
      </span>
    </span>
  );
}

/**
 * One project, as a ROW.
 *
 * It was a 240px card in a three-across grid. Same figures, same sparkline, same
 * whole-tile hit area — one line instead of five, so nine projects are a block
 * you scan rather than a screenful you scroll. Stacking them also puts the
 * sparklines in a COLUMN, which is the one arrangement where their shapes can
 * actually be compared against each other.
 */
function ProjectRow({ project: p, window }: { project: HomeProject; window: HomeWindow }) {
  return (
    <RowButton
      onClick={() => openProject(p.id)}
      className="flex w-full items-center gap-3 px-3 py-1.5 hover:bg-hover"
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-accent [&_svg]:size-3.5">
        <FolderGit2 />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-primary">{p.name}</span>
        <span className="block truncate cm-mono !text-2xs text-faint">
          {midTruncate(p.repoPath, 34)}
        </span>
      </span>
      {/* The two markers that mean "look at this one". Same tones and the same
          pulse as the sidebar's rows, so they read as one vocabulary. */}
      {p.attention > 0 && (
        <span className={cn("flex shrink-0 items-center gap-1 text-2xs", toneText("warn"))}>
          <StatusDot tone="warn" pulse size={5} />
          {p.attention}
        </span>
      )}
      {p.working > 0 && (
        <span className={cn("flex shrink-0 items-center gap-1 text-2xs", toneText("working"))}>
          <StatusDot tone="working" pulse size={5} />
          {p.working}
        </span>
      )}
      {/* The shape drops at `sm`, where a 64px sparkline between two number
          columns is a smudge rather than a trend. */}
      <span className="hidden w-28 shrink-0 sm:block">
        <Sparkline values={p.spark} label={HOME_SPARK_UNIT[window]} />
      </span>
      <span className="flex shrink-0 items-center gap-2.5 text-2xs text-muted">
        <span
          className="hidden items-center gap-1 sm:flex"
          title="Agent runtime in this window"
        >
          <Clock className="size-3 text-faint" />
          {formatDuration(p.runtimeMs)}
        </span>
        <span className="flex items-center gap-1" title="Recorded activity in this window">
          <Zap className="size-3 text-faint" />
          {compact(p.events)}
        </span>
        <span className="flex items-center gap-1" title="Chats in this project">
          <Inbox className="size-3 text-faint" />
          {count(p.chats)}
        </span>
      </span>
      {/* Wide enough for `ago`'s widest output — past 30 days it falls back to a
          locale date, and a column sized for "3d ago" clipped it. */}
      <span className="w-16 shrink-0 truncate text-right text-2xs text-faint">
        {p.lastActivityAt ? ago(p.lastActivityAt) : "never"}
      </span>
    </RowButton>
  );
}

/**
 * The first-load placeholder, and only ever that.
 *
 * Sized to the rows it stands in for so the numbers don't jump into place when
 * they land. A revisit never sees this — the store keeps the previous snapshot,
 * so there is something real to paint while the refetch is in flight.
 */
function Skeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2 p-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-8 animate-pulse rounded bg-panel-2" />
      ))}
    </div>
  );
}
