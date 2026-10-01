/**
 * The homepage — what Dispatch has been doing across every project, and where
 * you pick the one you want.
 *
 * ── WHY IT IS FULL-BLEED ─────────────────────────────────────────────────────
 *
 * No sidebar, like `new-project` and for a sharper version of the same reason:
 * the sidebar's top control IS a project picker, and this page's grid is also a
 * project picker. Two of them side by side would disagree about which project is
 * "active" — the rail is scoped to one, the grid is scoped to none — and the
 * reader would have to work out which one their click meant.
 *
 * ── WHY THESE NUMBERS ────────────────────────────────────────────────────────
 *
 * A FEW figures that arrive instantly, not a dense dashboard. The brief for this
 * surface was "snappy", and the honest reading of that is a budget: anything
 * that can't be answered from the state database and memory doesn't go on it.
 * So what's here is the five questions a glance at the top of the app is for:
 *
 *   Runtime        how much agent time the window actually cost. The one
 *                  figure that is a RESOURCE rather than a count, so it leads.
 *   Working now    is anything running. The only live number on the page.
 *   Needs you      is anything BLOCKED on you — the one thing here that is a
 *                  call to action rather than a reading.
 *   Activity       tool calls, as the sense of scale the runtime figure needs.
 *   Per project    the same four, one card each, with a daily shape beside them.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
 *
 * OPEN PRs AND CI STATE. They are the obvious thing to want here and the single
 * most expensive thing the app can ask for — a `gh` call per repo, seconds when
 * the network is slow, and this page's whole premise is that it is already there
 * when you arrive. The Workspace modal's PR roster answers it on demand. If it
 * ever belongs here it arrives lazily after first paint and never blocks a
 * number beside it.
 *
 * THE GROWTH CURVE, for the same reason squared: it walks git history and
 * streams NDJSON because it needs a progress bar.
 *
 * MOBILE SWIPE GESTURES. Out of scope by decision, deferred. The homepage is
 * reached on a phone the way every other destination is — the brand mark in the
 * top bar — and nothing here touches the shell's geometry or the viewport.
 */
import { Activity, Clock, FolderGit2, Inbox, RefreshCw, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import {
  HOME_SPARK_UNIT,
  HOME_WINDOW_LABELS,
  type HomeProject,
  type HomeWindow,
} from "@dispatch/shared";
import { ScrollArea } from "../ui/ScrollArea.js";
import { IconButton } from "../ui/IconButton.js";
import { Tabs } from "../ui/Tabs.js";
import { DispatchMark } from "../ui/DispatchMark.js";
import { StatusDot, toneText } from "../ui/StatusDot.js";
import { Hero, StatTile, Card, compact, count, ago } from "../metrics/chrome.js";
import { formatDuration } from "../metrics/duration.js";
import { Sparkline } from "./Sparkline.js";
import { useHome } from "../../stores/home.js";
import { openProject } from "../../stores/navigation.js";
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

  // A clock, NOT a poll. Every relative stamp on this page — the footer's "as
  // of", each card's last-touched, every line of the tail — is computed during
  // render from `Date.now()`, and nothing on a page that deliberately doesn't
  // refetch ever causes another render. So a tab left open kept insisting the
  // reading was from "just now" an hour later, which is worse than no stamp:
  // the footer exists to admit the numbers are slightly old.
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
        <Tabs
          value={window}
          onChange={(id) => setWindow(id as HomeWindow)}
          tabs={WINDOWS.map((w) => ({ id: w, label: HOME_WINDOW_LABELS[w] }))}
        />
        <div className="flex-1" />
        {/* FORCED. The server answers every ordinary request from its cache —
            that is the whole design — so an unforced reload would return the
            same snapshot it started with and the button would be a spinner
            that changes nothing. See `HomeService.overview`. */}
        <IconButton size="sm" tip="Reload" onClick={() => void load({ force: true })}>
          <RefreshCw className={cn(refetching && "animate-spin")} />
        </IconButton>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {/* `max-w` with auto margins: the grid below is cards, and cards stretched
            across a 2560px monitor stop reading as a set. */}
        <div className="mx-auto flex max-w-5xl flex-col gap-3 p-3 sm:p-4">
          {/* Shown whenever there IS an error, not only when there is nothing
              to paint under it. Once the first load succeeds the store keeps
              the last snapshot forever, so gating the banner on `!overview`
              meant a failed Reload stopped the spinner, left the old figures up
              and said nothing — the one case where the user explicitly asked
              for a newer number and silently did not get one. The stale figures
              stay on screen (they are still the best answer available); the
              banner says they are stale, and the footer's "as of" says how. */}
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-danger-line bg-danger-ghost px-3 py-2 text-xs text-danger"
            >
              {overview ? `Could not refresh: ${error}. Showing the last reading.` : error}
            </p>
          )}

          {/* FOUR tiles, in one row beside the hero. It was five — a Projects
              count was in here — and that count is the grid directly below this
              row, stated as nine cards. Dropping it is what lets the tiles sit
              on a single line, which in turn stops the hero from being a 5xl
              number stranded in the top third of a double-height box.

              One column at `sm`, where the hero would otherwise be that number
              in a 90px box with four tiles squeezed beside it. */}
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2.2fr)]">
            <Hero
              label={`Agent runtime · ${HOME_WINDOW_LABELS[window]}`}
              value={totals ? formatDuration(totals.runtimeMs) : "—"}
              hint="attributed — parallel tool calls each count"
            />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile
                label="Working now"
                value={totals ? count(totals.working) : "—"}
                hint={
                  totals && totals.working > 0 ? (
                    <span className={cn("flex items-center gap-1", toneText("working"))}>
                      <StatusDot tone="working" pulse size={5} />
                      live
                    </span>
                  ) : (
                    "nothing running"
                  )
                }
              />
              <StatTile
                label="Needs you"
                value={totals ? count(totals.attention) : "—"}
                hint={
                  totals && totals.attention > 0 ? (
                    <span className={cn("flex items-center gap-1", toneText("warn"))}>
                      <StatusDot tone="warn" pulse size={5} />
                      blocked
                    </span>
                  ) : (
                    "clear"
                  )
                }
              />
              <StatTile
                label="Activity"
                value={totals ? compact(totals.events) : "—"}
                hint="tool calls, skills, MCP"
              />
              <StatTile
                label="Chats"
                value={totals ? count(totals.chats) : "—"}
                hint={totals ? `across ${count(totals.projects)} projects` : "archived excluded"}
              />
            </div>
          </div>

          <Card
            title="Projects"
            icon={<FolderGit2 />}
            note={overview ? "busiest first" : undefined}
          >
            {loading && !overview ? (
              <Skeleton rows={3} />
            ) : overview && overview.projects.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-faint">
                No projects yet. Add one from the sidebar&rsquo;s project menu.
              </p>
            ) : (
              <div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3">
                {overview?.projects.map((p) => (
                  <ProjectCard key={p.id} project={p} window={window} />
                ))}
              </div>
            )}
          </Card>

          <Card title="Recent activity" icon={<Activity />}>
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
              so saying how old and how long it took is cheaper than pretending
              it is live. */}
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
 * One project.
 *
 * A BUTTON, not a card with a link in the corner: the whole tile is the target,
 * because picking a project is the only thing anyone does here and a 240px card
 * with a 60px hit area is a worse version of the sidebar's menu.
 */
function ProjectCard({ project: p, window }: { project: HomeProject; window: HomeWindow }) {
  return (
    <button
      onClick={() => openProject(p.id)}
      // `bg-panel` over the grid's `gap-px bg-line`: the gaps ARE the hairlines,
      // so the cards need no borders of their own and nothing doubles up at the
      // seams.
      className="flex flex-col gap-2 bg-panel px-3 py-2.5 text-left transition-colors hover:bg-hover"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center text-accent [&_svg]:size-3.5">
          <FolderGit2 />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-primary">{p.name}</span>
          <span className="block truncate cm-mono !text-2xs text-faint">
            {midTruncate(p.repoPath, 30)}
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
      </div>

      <Sparkline values={p.spark} label={HOME_SPARK_UNIT[window]} />

      <div className="flex items-center gap-3 text-2xs text-muted">
        <span className="flex items-center gap-1" title="Agent runtime in this window">
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
        <span className="ml-auto shrink-0 text-faint">
          {p.lastActivityAt ? ago(p.lastActivityAt) : "never"}
        </span>
      </div>
    </button>
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
