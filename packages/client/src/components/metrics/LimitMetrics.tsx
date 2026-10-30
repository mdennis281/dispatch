/**
 * The Limits subpage — every account's limit windows over time, and the
 * transitions nobody announced.
 *
 * The header meter answers "how much is left right now" and forgets. This page
 * is the memory: a line per window per account, with each reset marked where
 * it happened, and a log that names the ones that shouldn't have — a weekly
 * window emptied mid-week, a 5-hour window falling from 80% to 20%, a reset
 * time that moved. Unexpected kinds are coloured; scheduled resets are not,
 * because a page where everything is highlighted highlights nothing.
 *
 * The chart is drawn here rather than through `MetricsChart`: that chart plots
 * bucketed SUMS, and a limit reading is a level sampled at irregular instants.
 * Bucketing it would average a reset away — the one thing this page exists to
 * show.
 */
import { useEffect, useMemo } from "react";
import { AlertTriangle, Clock, Coins, Info } from "lucide-react";
import {
  LIMIT_EVENT_LABELS,
  UNEXPECTED_LIMIT_EVENTS,
  type LimitEvent,
  type LimitPeriod,
  type LimitWindowSeries,
  type LimitYield,
} from "@dispatch/shared";
import { Select } from "../ui/Select.js";
import { Spinner } from "../ui/Spinner.js";
import { RANGE_PRESETS } from "../../stores/metrics.js";
import { useLimitMetrics } from "../../stores/metrics-limits.js";
import { Card, Hero, StatTile, ago, compact, count } from "./chrome.js";
import { colorFor, useChartPalette } from "./palette.js";
import { WEAK_POINTS, YieldChart, formatPerPoint, gaugeWindows, usd } from "./YieldChart.js";
import { cn } from "../../lib/cn.js";

/** The page re-reads this often while open; the sampler itself is slower. */
const POLL_MS = 60_000;

const isUnexpected = (e: LimitEvent) => UNEXPECTED_LIMIT_EVENTS.includes(e.kind);

function stamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function until(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "now";
  const min = Math.round(diff / 60_000);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `in ${hr}h ${min % 60}m`;
  return `in ${Math.floor(hr / 24)}d ${hr % 24}h`;
}

/** "between 14:05 and 14:30" — a change seen across a gap is that gap. */
function when(e: LimitEvent): string {
  if (e.prevTs === null || e.ts - e.prevTs < 90_000) return stamp(e.ts);
  return `${stamp(e.prevTs)} – ${stamp(e.ts)}`;
}

function describe(e: LimitEvent): string {
  if (e.detail) return e.detail;
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);
  const parts = [`${pct(e.fromPercent)} → ${pct(e.toPercent)}`];
  if (e.kind === "early_reset" && e.prevResetsAt !== null) {
    parts.push(`was due ${stamp(e.prevResetsAt)}`);
  }
  if (e.kind === "reset_moved" && e.prevResetsAt !== null && e.resetsAt !== null) {
    const h = (e.resetsAt - e.prevResetsAt) / 3_600_000;
    parts.push(`${stamp(e.prevResetsAt)} → ${stamp(e.resetsAt)} (${h > 0 ? "+" : ""}${h.toFixed(1)}h)`);
  }
  return parts.join(" · ");
}

/* ------------------------------------------------------------------- chart */

const W = 1000;
const H = 180;
const PAD = { l: 34, r: 8, t: 8, b: 20 };

function AccountChart({
  windows,
  events,
  from,
  to,
}: {
  windows: LimitWindowSeries[];
  events: LimitEvent[];
  from: number;
  to: number;
}) {
  const palette = useChartPalette();
  const x = (ts: number) => PAD.l + ((Math.max(ts, from) - from) / Math.max(1, to - from)) * (W - PAD.l - PAD.r);
  const y = (pct: number) => PAD.t + (1 - Math.min(Math.max(pct, 0), 110) / 100) * (H - PAD.t - PAD.b);
  const ticks = useMemo(() => {
    const n = 6;
    return Array.from({ length: n + 1 }, (_, i) => from + ((to - from) * i) / n);
  }, [from, to]);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[180px] w-full" preserveAspectRatio="none">
        {[0, 25, 50, 75, 100].map((p) => (
          <g key={p}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(p)} y2={y(p)} className="stroke-line-soft" strokeWidth={1} />
            <text x={PAD.l - 4} y={y(p) + 3} textAnchor="end" className="fill-faint text-2xs">
              {p}%
            </text>
          </g>
        ))}
        {ticks.map((t, i) => (
          <text
            key={t}
            x={x(t)}
            y={H - 4}
            textAnchor={i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"}
            className="fill-faint text-2xs"
          >
            {new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </text>
        ))}
        {events.map((e) => (
          <line
            key={e.seq}
            x1={x(e.ts)}
            x2={x(e.ts)}
            y1={PAD.t}
            y2={H - PAD.b}
            strokeWidth={isUnexpected(e) ? 2 : 1}
            strokeDasharray={isUnexpected(e) ? undefined : "3 3"}
            className={isUnexpected(e) ? "stroke-warn" : "stroke-line"}
          >
            <title>{`${LIMIT_EVENT_LABELS[e.kind]} · ${e.title} · ${describe(e)} · ${when(e)}`}</title>
          </line>
        ))}
        {windows.map((w, i) => {
          // A step line: a reading holds until the next one. Interpolating
          // would draw a reset as a slow decline.
          const pts = w.points.filter((p) => p.ts < to);
          if (!pts.length) return null;
          let d = `M${x(pts[0]!.ts)},${y(pts[0]!.percent)}`;
          for (let k = 1; k < pts.length; k++) {
            d += ` H${x(pts[k]!.ts)} V${y(pts[k]!.percent)}`;
          }
          const last = pts.at(-1)!;
          return (
            <g key={w.windowId}>
              <path
                d={d}
                fill="none"
                stroke={colorFor(palette, w.windowId, i)}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
              {/* The newest reading as a dot: a window read once so far has
                  no line yet, and would otherwise draw nothing at all. */}
              <circle cx={x(last.ts)} cy={y(last.percent)} r={3.5} fill={colorFor(palette, w.windowId, i)} />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 px-1 text-2xs text-muted">
        {windows.map((w, i) => {
          const last = w.points.at(-1);
          return (
            <span key={w.windowId} className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-full" style={{ background: colorFor(palette, w.windowId, i) }} />
              <span className="text-secondary">{w.title}</span>
              {last && (
                <span className="cm-mono tabular-nums">
                  {Math.round(last.percent)}%{last.resetsAt ? ` · resets ${until(last.resetsAt)}` : ""}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ yields */

const PERIOD_LABELS: Record<LimitPeriod, string> = {
  "1h": "Hour",
  "3h": "3 hours",
  "6h": "6 hours",
  "1d": "Day",
};

function periodLabel(y: LimitYield, period: LimitPeriod): string {
  const day = new Date(y.start).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  if (period === "1d") return day;
  const hm = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric" });
  return `${day}, ${hm(y.start)}–${hm(y.end)}`;
}

/** A window's role in an account: the shortest (session) or longest (weekly). */
type Role = "short" | "long";

/** The account's gauge for `role` — the same pick the chart rows make. An account with one window has no "short". */
function windowOf(y: LimitYield, role: Role) {
  const [short, long] = gaugeWindows(y.windows);
  return role === "long" ? (long ?? short) : long ? short : undefined;
}

/** "$1.20" when priced, else tokens — Codex has no price, only tokens. */
function perPoint(y: { costUsd: number | null; total: number }, points: number): string {
  if (points <= 0) return "—";
  return y.costUsd !== null ? formatPerPoint(y.costUsd / points, true) : formatPerPoint(y.total / points, false);
}

function PerPointCell({ y, role }: { y: LimitYield; role: Role }) {
  const w = windowOf(y, role);
  const pts = w?.points ?? 0;
  const weak = pts < WEAK_POINTS;
  return (
    <td
      className={cn("cm-mono px-2 py-1.5 text-right tabular-nums", weak ? "text-faint" : "text-primary")}
      title={
        w && pts > 0
          ? `${compact(y.tokens.total / pts)} tokens per 1% of ${w.title}, over ${Math.round(pts)} point(s)` +
            (weak ? ` — under ${WEAK_POINTS} points, so ±1-point rounding dominates` : "")
          : undefined
      }
    >
      {perPoint(y.tokens, pts)}
    </td>
  );
}

/** Idle periods are rows now (that's how the chart tells idle from unwatched); a table would drown in them. */
const active = (y: LimitYield) => y.tokens.total > 0 || y.windows.some((w) => w.points > 0);

function YieldTable({ yields, period }: { yields: LimitYield[]; period: LimitPeriod }) {
  const rows = yields.filter(active);
  if (!rows.length) {
    return <p className="px-3 py-3 text-xs text-muted">Nothing yet — this fills in as accounts are used.</p>;
  }
  const title = (role: Role) => {
    const t = rows.map((y) => windowOf(y, role)?.title).find(Boolean);
    return t ? t.toLowerCase() : role === "long" ? "longest window" : "shortest window";
  };
  const num = "cm-mono px-2 py-1.5 text-right tabular-nums";
  return (
    <div className="flex flex-col gap-2 p-1">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-2xs text-muted">
              <th className="px-2 py-1.5 text-left font-medium">{PERIOD_LABELS[period]}</th>
              <th className="px-2 py-1.5 text-left font-medium">Account</th>
              <th className="px-2 py-1.5 text-left font-medium">Points used</th>
              <th className="px-2 py-1.5 text-right font-medium">API value</th>
              <th className="px-2 py-1.5 text-right font-medium">Tokens</th>
              <th className="px-2 py-1.5 text-right font-medium">Per 1% {title("short")}</th>
              <th className="px-2 py-1.5 text-right font-medium">Per 1% {title("long")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((y) => {
              const cost = y.tokens.costUsd;
              return (
                <tr key={`${y.subscriptionId}|${y.start}`} className="border-t border-line-soft">
                  <td className="whitespace-nowrap px-2 py-1.5 text-muted">
                    {periodLabel(y, period)}
                    {y.partial && (
                      <span
                        className="ml-1 text-faint"
                        title={`Only ${Math.round(y.coverage * 100)}% of this period was watched — the app was off or reads failed`}
                      >
                        (partial)
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-secondary">{y.subscriptionLabel}</td>
                  <td className="px-2 py-1.5 text-muted">
                    {y.windows
                      .filter((w) => w.points > 0)
                      .map((w) => `${w.title} +${Math.round(w.points)}`)
                      .join(" · ") || "—"}
                  </td>
                  <td className={cn(num, "text-secondary")}>
                    {cost === null ? "—" : usd(cost)}
                    {y.tokens.unpriced > 0 && cost !== null && (
                      <span
                        className="text-faint"
                        title={`${y.tokens.unpriced} turn(s) carried no price and aren't in this figure`}
                      >
                        *
                      </span>
                    )}
                  </td>
                  <td className={cn(num, "text-muted")}>{compact(y.tokens.total)}</td>
                  <PerPointCell y={y} role="short" />
                  <PerPointCell y={y} role="long" />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- subpage */

export function LimitMetrics() {
  const { report, rangeId, setRange, period, setPeriod, load, loading, refetching, error } =
    useLimitMetrics();

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preset = RANGE_PRESETS.find((r) => r.id === rangeId);
  const to = Date.now();
  const from = preset?.ms ? to - preset.ms : (report?.oldest ?? to - 86_400_000);
  const events = report?.events ?? [];
  const unexpected = events.filter(isUnexpected);
  const resets = events.filter((e) => e.kind === "reset" || e.kind === "early_reset");

  const accounts = useMemo(() => {
    const ids = new Set<string>();
    for (const a of report?.accounts ?? []) ids.add(a.subscriptionId);
    for (const w of report?.windows ?? []) ids.add(w.subscriptionId);
    return [...ids].map((id) => ({
      id,
      status: report?.accounts.find((a) => a.subscriptionId === id),
      windows: (report?.windows ?? []).filter((w) => w.subscriptionId === id),
      events: events.filter((e) => e.subscriptionId === id),
    }));
  }, [report, events]);

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          options={RANGE_PRESETS.map((r) => ({ value: r.id, label: r.label }))}
          value={rangeId}
          onChange={setRange}
          label="Range"
          width={170}
        />
        <span className="text-2xs text-faint">
          {report?.oldest ? `Tracking since ${stamp(report.oldest)}` : "Tracking starts with the first read"}
          {" · "}every account is read every 5–15 minutes, and just after each announced reset
        </span>
      </div>

      {error && (
        <div className="rounded-lg border border-danger-line bg-danger-ghost px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex h-[360px] items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <div className={cn("flex flex-col gap-3 transition-opacity", refetching && "opacity-60")}>
          <div className="flex flex-wrap items-end gap-3">
            <Hero
              label="Unexpected changes in this window"
              value={count(unexpected.length)}
              hint="Early resets, drops inside a window, moved reset times, plan changes"
            />
            <StatTile label="Resets" value={count(resets.length)} />
            <StatTile label="Accounts" value={count(accounts.length)} />
            <StatTile label="Readings stored" value={count(report?.sampleRows ?? 0)} />
          </div>

          {accounts.map((a) => (
            <Card
              key={a.id}
              title={a.status?.label ?? a.windows[0]?.subscriptionLabel ?? a.id}
              icon={<Clock />}
              note={
                a.status ? (
                  <span className={cn(a.status.error && "text-warn")}>
                    {a.status.planType ? `${a.status.planType} · ` : ""}
                    {a.status.resetCredits !== null ? `${a.status.resetCredits} reset credit(s) · ` : ""}
                    {a.status.error
                      ? `last read failed (${a.status.error})`
                      : a.status.lastOkAt
                        ? `read ${ago(a.status.lastOkAt)}`
                        : "not read yet"}
                    {a.status.nextAt ? ` · next ${until(a.status.nextAt)}` : ""}
                  </span>
                ) : (
                  "no longer sampled"
                )
              }
            >
              <div className="p-3">
                {a.windows.length ? (
                  <AccountChart windows={a.windows} events={a.events} from={from} to={to} />
                ) : (
                  <p className="text-xs text-muted">No readings yet.</p>
                )}
              </div>
            </Card>
          ))}

          <Card
            title="What 1% buys"
            icon={<Coins />}
            controls={
              <Select
                options={(Object.keys(PERIOD_LABELS) as LimitPeriod[]).map((p) => ({
                  value: p,
                  label: PERIOD_LABELS[p],
                }))}
                value={period}
                onChange={(v) => setPeriod(v as LimitPeriod)}
                label="Per"
                width={130}
              />
            }
            note="API value per point of each window · a turn's spend is spread over the time it ran · hover a bar for its figures"
          >
            <YieldChart
              yields={report?.yields ?? []}
              windows={report?.windows ?? []}
              period={report?.period ?? period}
              from={from}
              to={to}
            />
            <details className="group cm-hairline-t">
              <summary className="cursor-pointer select-none px-3 py-2 text-2xs text-muted hover:text-secondary">
                Per-period table
              </summary>
              <YieldTable yields={report?.yields ?? []} period={report?.period ?? period} />
            </details>
          </Card>

          <Card
            title="Resets and changes"
            icon={<Info />}
            note="A change seen between two reads is shown as that span — it happened somewhere inside it"
          >
            {events.length ? (
              <div className="overflow-x-auto p-1">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-2xs text-muted">
                      <th className="px-2 py-1.5 text-left font-medium">When</th>
                      <th className="px-2 py-1.5 text-left font-medium">Account</th>
                      <th className="px-2 py-1.5 text-left font-medium">Window</th>
                      <th className="px-2 py-1.5 text-left font-medium">What</th>
                      <th className="px-2 py-1.5 text-left font-medium">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.seq} className="border-t border-line-soft">
                        <td className="whitespace-nowrap px-2 py-1.5 text-muted">{when(e)}</td>
                        <td className="px-2 py-1.5 text-secondary">
                          {accounts.find((a) => a.id === e.subscriptionId)?.status?.label ??
                            report?.windows.find((w) => w.subscriptionId === e.subscriptionId)
                              ?.subscriptionLabel ??
                            e.subscriptionId}
                        </td>
                        <td className="px-2 py-1.5 text-secondary">{e.title}</td>
                        <td className={cn("px-2 py-1.5", isUnexpected(e) ? "text-warn" : "text-muted")}>
                          <span className="inline-flex items-center gap-1">
                            {isUnexpected(e) && <AlertTriangle className="size-3" />}
                            {LIMIT_EVENT_LABELS[e.kind]}
                          </span>
                        </td>
                        <td className="cm-mono px-2 py-1.5 text-muted">{describe(e)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-3 py-3 text-xs text-muted">
                Nothing yet. Resets show up here as they happen — this history starts now and
                can't be filled in backwards.
              </p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
