/**
 * The Growth subpage — how big the repo is, how it got there, and what it is
 * made of.
 *
 * Same skeleton as the other tabs (controls, hero, chart, breakdown, a tail)
 * over a dataset that is NOT a Dispatch ledger: it is the project's own git
 * history, walked by the server on every visit and streamed back with
 * progress. The page has three states and shows which one it is in:
 *
 *   walking   the progress card — phase, commits done of total, elapsed. This
 *             is the whole page on first load, and a banner above a dimmed
 *             report on Reload.
 *   failed    the error, in git's own words (an unborn repo, a missing dir).
 *   report    hero + tiles, the chart, the composition table, the biggest
 *             commits.
 *
 * Every control below the project picker is a re-shape in memory (see
 * `growth-shape`); only the project picker and Reload walk again.
 *
 * THE HERO IS LINES AT HEAD FOR TEXT FILES, EXCLUDING GENERATED. That is the
 * number a reader means by "how big is the codebase", and the hint under it
 * says exactly what was excluded so the figure can be reconciled with a
 * `wc -l` that disagrees. The generated toggle brings the lockfiles back for
 * anyone who wants the raw numstat — it is a view toggle, not a re-walk.
 */
import { useEffect, useMemo, useState } from "react";
import { GitCommitHorizontal, FolderGit2, Layers } from "lucide-react";
import { METRIC_OTHER_KEY, type GrowthReport } from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { Select } from "../ui/Select.js";
import { useProjects } from "../../stores/projects.js";
import {
  GROWTH_MEASURE_LABELS,
  GROWTH_RANGES,
  GROWTH_SPLIT_LABELS,
  growthRangeStart,
  useGrowth,
} from "../../stores/growth.js";
import { GrowthChart } from "./GrowthChart.js";
import { ChartLegend } from "./MetricsChart.js";
import { Card, Hero, StatTile, ago, compact, count } from "./chrome.js";
import {
  shapeGrowth,
  type GrowthBucket,
  type GrowthMeasure,
  type GrowthShape,
  type GrowthSplit,
} from "./growth-shape.js";
import { colorFor, useChartPalette } from "./palette.js";
import { cn } from "../../lib/cn.js";

const BUCKET_LABELS: Record<string, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
};

/** A signed figure for a delta tile: "+1,204" / "−86" / "0". */
function signed(n: number): string {
  if (n > 0) return `+${compact(n)}`;
  if (n < 0) return `−${compact(-n)}`;
  return "0";
}

/** "1.2s" / "48s" / "2m 05s" — the walk's cost, shown so "no cache" is felt. */
function elapsed(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const monthYear = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
const dayStamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

/* --------------------------------------------------------------- progress */

/**
 * The walk, as it happens.
 *
 * A determinate bar once the count is in — `rev-list --count` is milliseconds,
 * so "counting" is a blink and the bar is what a reader actually sees. The
 * elapsed figure ticks so a long walk on a big repo reads as working rather
 * than hung; the point of streaming was to make that distinction visible.
 */
function Progress({ compactRow = false }: { compactRow?: boolean }) {
  const progress = useGrowth((s) => s.progress);
  const startedAt = useGrowth((s) => s.startedAt);
  const since = useElapsed(startedAt);

  const walking = progress?.phase === "walking" ? progress : null;
  const pct = walking && walking.total > 0 ? Math.min(100, (walking.done / walking.total) * 100) : 0;

  return (
    <div
      className={cn(
        "rounded-lg border border-line bg-panel",
        compactRow ? "px-3 py-2" : "px-4 py-3",
      )}
      role="status"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-primary">
          {walking ? "Reading history" : "Counting commits"}
        </span>
        <span className="cm-mono !text-2xs text-muted tabular-nums">
          {walking ? `${count(walking.done)} of ${count(walking.total)} commits` : "…"}
        </span>
        <span className="ml-auto cm-mono !text-2xs text-faint tabular-nums">{elapsed(since)}</span>
      </div>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-inset"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div
          className={cn(
            "h-full rounded-full bg-accent transition-[width] duration-150 ease-out",
            !walking && "w-1/6 cm-anim-pulse",
          )}
          style={walking ? { width: `${pct}%` } : undefined}
        />
      </div>
      {!compactRow && (
        <p className="mt-2 text-2xs text-faint">
          Walking the trunk's first-parent history with git — nothing is cached, so this runs
          every time the tab opens.
        </p>
      )}
    </div>
  );
}

/** Milliseconds since `startedAt`, refreshed four times a second while mounted. */
function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return startedAt ? Math.max(0, now - startedAt) : 0;
}

/* ------------------------------------------------------------ composition */

/**
 * The composition table — every group, not just the charted ones.
 *
 * The chart caps at N series and folds the rest; this lists them all with a
 * share bar in the row, so a reader can find the 0.4% of Shell the chart
 * folded into Other. It is also the page's accessible fallback for the
 * light-mode series colours that sit under 3:1 (see MetricsChart's header).
 *
 * "Lines" is the running net at HEAD — what the hero sums. "Added / Deleted"
 * are within the range, so the columns answer "how much of this is recent".
 */
function Composition({
  shape,
  split,
  color,
}: {
  shape: GrowthShape;
  split: GrowthSplit;
  color: (key: string, i: number) => string;
}) {
  const grand = Math.max(1, shape.linesNow);
  const top = shape.groups[0]?.now ?? 1;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-2xs text-faint">
          <th className="px-2 py-1 text-left font-medium">
            {split === "extension" ? "Extension" : split === "language" ? "Language" : "Scope"}
          </th>
          <th className="px-2 py-1 text-right font-medium">Lines</th>
          <th className="w-[160px] px-2 py-1 text-left font-medium">Share</th>
          <th className="px-2 py-1 text-right font-medium">Files</th>
          <th className="px-2 py-1 text-right font-medium">Added</th>
          <th className="px-2 py-1 text-right font-medium">Deleted</th>
          {split === "language" && <th className="px-2 py-1 text-left font-medium">Extensions</th>}
        </tr>
      </thead>
      <tbody>
        {shape.groups.map((g, i) => {
          // Groups past the chart's cap are Other on the chart, so their row
          // wears the fold's grey — the swatch must agree with the legend.
          const charted = i < shape.series.length - (shape.folded ? 1 : 0);
          const hue = charted ? color(g.key, i) : color(METRIC_OTHER_KEY, i);
          const share = (g.now / grand) * 100;
          return (
            <tr key={g.key} className="border-t border-line-soft">
              <td className="max-w-[220px] px-2 py-1.5">
                <span className="flex items-center gap-2">
                  <span aria-hidden className="size-2 shrink-0 rounded-sm" style={{ background: hue }} />
                  <span className="min-w-0 truncate text-secondary">{g.label}</span>
                </span>
              </td>
              <td className="cm-mono px-2 py-1.5 text-right text-primary tabular-nums">
                {count(g.now)}
              </td>
              <td className="px-2 py-1.5">
                <span className="flex items-center gap-2">
                  {/* Sized against the LARGEST group, not the whole: a bar at
                      100% for the top row gives the rest a scale to read
                      against, where bars all under 40% would be six stubs. */}
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-inset">
                    <span
                      className="block h-full rounded-full"
                      style={{ width: `${Math.max(1, (g.now / Math.max(1, top)) * 100)}%`, background: hue }}
                    />
                  </span>
                  <span className="cm-mono w-[42px] shrink-0 text-right !text-2xs text-muted tabular-nums">
                    {share < 1 && share > 0 ? "<1" : Math.round(share)}%
                  </span>
                </span>
              </td>
              <td className="cm-mono px-2 py-1.5 text-right text-muted tabular-nums">
                {count(g.files)}
              </td>
              <td className="cm-mono px-2 py-1.5 text-right text-muted tabular-nums">
                {g.added ? `+${count(g.added)}` : "–"}
              </td>
              <td className="cm-mono px-2 py-1.5 text-right text-muted tabular-nums">
                {g.deleted ? `−${count(g.deleted)}` : "–"}
              </td>
              {split === "language" && (
                <td className="max-w-[240px] truncate px-2 py-1.5 text-2xs text-faint">
                  {g.keys.filter((k) => !k.startsWith("!")).sort().join("  ")}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ---------------------------------------------------------------- notable */

/**
 * The biggest commits by lines moved — ranked on non-generated lines, so a
 * lockfile bump does not top a list meant to explain the chart's spikes.
 */
function Notable({ report }: { report: GrowthReport }) {
  if (!report.notable.length) return null;
  const top = Math.max(1, ...report.notable.map((n) => n.additions + n.deletions));
  return (
    <ul className="divide-y divide-line-soft">
      {report.notable.map((c) => (
        <li key={c.sha} className="flex items-center gap-3 px-2 py-1.5 text-xs">
          <span className="cm-mono w-[62px] shrink-0 !text-2xs text-faint">{c.sha.slice(0, 7)}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-secondary">{c.subject}</span>
            <span className="block truncate text-2xs text-faint">
              {c.author} · {dayStamp.format(new Date(c.ts))} · {count(c.files)} file{c.files === 1 ? "" : "s"}
            </span>
          </span>
          {/* A two-tone stub: additions solid, deletions faded, sized against
              the biggest commit here — the churn chart's encoding in miniature. */}
          <span className="hidden w-[120px] shrink-0 items-center gap-px sm:flex" aria-hidden>
            <span
              className="h-1.5 rounded-l-full bg-accent"
              style={{ width: `${(c.additions / top) * 100}%` }}
            />
            <span
              className="h-1.5 rounded-r-full bg-accent opacity-50"
              style={{ width: `${(c.deletions / top) * 100}%` }}
            />
          </span>
          <span className="cm-mono w-[120px] shrink-0 text-right !text-2xs tabular-nums">
            <span className="text-primary">+{count(c.additions)}</span>{" "}
            <span className="text-muted">−{count(c.deletions)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------------- subpage */

export function GrowthMetrics() {
  const projects = useProjects((s) => s.projects);
  const activeProjectId = useProjects((s) => s.activeProjectId);

  const projectId = useGrowth((s) => s.projectId);
  const report = useGrowth((s) => s.report);
  const loading = useGrowth((s) => s.loading);
  const error = useGrowth((s) => s.error);
  const rangeId = useGrowth((s) => s.rangeId);
  const measure = useGrowth((s) => s.measure);
  const split = useGrowth((s) => s.split);
  const bucket = useGrowth((s) => s.bucket);
  const includeGenerated = useGrowth((s) => s.includeGenerated);
  const limit = useGrowth((s) => s.limit);
  const { open, setRange, setMeasure, setSplit, setBucket, setIncludeGenerated, setLimit, leave } =
    useGrowth();

  // Which repo to open with: the active project, else the first. Keyed on that
  // DEFAULT rather than on the store's pick, so a project chosen from the
  // Select does not re-run this and walk twice — and so a project list that
  // arrives after mount still starts the walk when it lands.
  const fallback = activeProjectId ?? projects[0]?.id ?? null;
  useEffect(() => {
    const pick = useGrowth.getState().projectId ?? fallback;
    if (pick) open(pick);
  }, [fallback, open]);
  // Leaving drops the report — see the store for why nothing is kept.
  useEffect(() => () => leave(), [leave]);

  const palette = useChartPalette();
  const color = useMemo(() => (key: string, i: number) => colorFor(palette, key, i), [palette]);

  const shape = useMemo(
    () =>
      report
        ? shapeGrowth(report, {
            from: growthRangeStart(rangeId),
            split,
            bucket,
            includeGenerated,
            limit,
          })
        : null,
    [report, rangeId, split, bucket, includeGenerated, limit],
  );

  const project = projects.find((p) => p.id === projectId);
  const net = shape ? shape.addedInRange - shape.deletedInRange : 0;
  const allTime = rangeId === "all";

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-3 p-3">
      {/* Controls: which repo, which window, whether generated files count. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {projects.length > 1 && (
          <Select
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
            value={projectId ?? ""}
            onChange={open}
            label="Project"
            leftIcon={<FolderGit2 />}
            width={240}
          />
        )}
        <Select
          options={GROWTH_RANGES.map((r) => ({ value: r.id, label: r.label }))}
          value={rangeId}
          onChange={setRange}
          label="Range"
          width={180}
        />
        <span className="mx-0.5 h-4 w-px bg-line-soft" aria-hidden />
        <Button
          variant="toggle"
          aria-pressed={includeGenerated}
          onClick={() => setIncludeGenerated(!includeGenerated)}
          title="Count lockfiles, build output and minified assets"
        >
          Include generated
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-danger-line bg-danger-ghost px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {loading && !report && <Progress />}
      {loading && report && <Progress compactRow />}

      {report && shape && (
        <div className={cn("flex flex-col gap-3 transition-opacity", loading && "opacity-60")}>
          <div className="flex flex-wrap items-end gap-3">
            {/* Capped, or the hero's hint sets the row's width and pushes the
                tiles onto a second line. Two hint lines: what the number IS,
                then where it came from and how fresh it is. */}
            <div className="min-w-[280px] max-w-[440px]">
              <Hero
                label={includeGenerated ? "Lines at HEAD" : "Lines of code at HEAD"}
                value={compact(shape.linesNow)}
                hint={
                  <>
                    <span className="cm-mono">{report.ref}</span>
                    {project ? ` · ${project.name}` : ""}
                    {includeGenerated ? "" : " · lockfiles & build output excluded"}
                    <br />
                    {count(report.commits)} commits by {count(report.authors)} author
                    {report.authors === 1 ? "" : "s"} since {monthYear.format(new Date(report.firstTs))}
                    {" · walked "}
                    {ago(report.generatedAt)} in {elapsed(report.elapsedMs)}
                  </>
                }
              />
            </div>
            <StatTile
              label={allTime ? "Net growth" : "Net change in range"}
              value={signed(net)}
              hint={allTime ? "lines, all time" : `from ${compact(shape.linesAtStart)} lines`}
            />
            <StatTile label="Added" value={`+${compact(shape.addedInRange)}`} hint="lines in range" />
            <StatTile label="Deleted" value={`−${compact(shape.deletedInRange)}`} hint="lines in range" />
            <StatTile
              label="Commits"
              value={count(shape.commitsInRange)}
              hint={allTime ? "on the trunk" : "in range"}
            />
            <StatTile
              label="Files"
              value={count(shape.groups.reduce((n, g) => n + g.files, 0))}
              hint="tracked at HEAD"
            />
          </div>

          <Card
            controls={
              <>
                <Select
                  options={(Object.keys(GROWTH_MEASURE_LABELS) as GrowthMeasure[]).map((m) => ({
                    value: m,
                    label: GROWTH_MEASURE_LABELS[m],
                  }))}
                  value={measure}
                  onChange={setMeasure}
                  label="Chart"
                  width={180}
                />
                <Select
                  options={(Object.keys(GROWTH_SPLIT_LABELS) as GrowthSplit[]).map((s) => ({
                    value: s,
                    label: GROWTH_SPLIT_LABELS[s],
                  }))}
                  value={split}
                  onChange={setSplit}
                  label="Split by"
                  width={160}
                />
                <Select
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "day", label: "Daily" },
                    { value: "week", label: "Weekly" },
                    { value: "month", label: "Monthly" },
                  ]}
                  value={bucket}
                  onChange={(v) => setBucket(v as GrowthBucket)}
                  label="Bucket"
                  width={140}
                />
                {split !== "none" && (
                  <Select
                    options={[4, 6, 8].map((n) => ({ value: String(n), label: `Top ${n}` }))}
                    value={String(limit)}
                    onChange={(v) => setLimit(Number(v))}
                    label="Series"
                    width={130}
                  />
                )}
              </>
            }
            note={[
              shape.folded ? `${shape.folded} more folded into Other` : null,
              bucket === "auto" ? `bucketed ${BUCKET_LABELS[shape.bucket]}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || null}
          >
            <div className="p-3">
              <div style={{ height: 320 }}>
                <GrowthChart measure={measure} shape={shape} palette={palette} color={color} height={320} />
              </div>
              <div className="mt-3">
                <ChartLegend
                  entries={shape.series.map((s) => ({ key: s.key, label: s.label, total: s.now }))}
                  label={(_k, fallback) => fallback ?? _k}
                  format={count}
                  color={color}
                />
              </div>
            </div>
          </Card>

          <Card
            title={
              split === "none"
                ? "Composition"
                : `Composition by ${GROWTH_SPLIT_LABELS[split].toLowerCase()}`
            }
            icon={<Layers />}
            note={
              report.binaries
                ? `${count(report.binaries)} binary change${report.binaries === 1 ? "" : "s"} carry no lines`
                : null
            }
          >
            <div className="p-1">
              <Composition shape={shape} split={split} color={color} />
            </div>
          </Card>

          <Card
            title="Biggest commits"
            icon={<GitCommitHorizontal />}
            note="by lines moved, generated files excluded"
          >
            <div className="p-1">
              <Notable report={report} />
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
