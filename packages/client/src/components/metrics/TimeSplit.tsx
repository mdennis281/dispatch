/**
 * Where the window's time went — the card this whole subpage exists to show.
 *
 * It plots ATTRIBUTED milliseconds, not busy, and that is not a detail. A
 * part-to-whole form has to sum to its whole or it is lying about the parts, and
 * only the attributed sum decomposes: `busyMs` is a union of intervals, so the
 * per-state unions do NOT add up to it — two states overlapping inside one actor
 * are counted once in busy and twice in the parts. The hero figure above this
 * card carries busy; this card carries the breakdown; the parallelism tile is
 * the bridge between them. Nothing here is labelled "wall clock".
 *
 * TWO DEPTHS, one encoding. The meter is the three-way rollup — thinking (the
 * only state that burns tokens) / working / blocked — which is the coarse answer
 * most readings want. Under it, every state that has time in the window, so the
 * fine answer ("blocked on WHAT") never needs a second control to reach.
 *
 * Colour means CLASS throughout the card, and only class: three fixed hues (see
 * `palette.CLASS_SLOT`), reused by every state row under the class it rolls up
 * to. The states are not colour-coded because there are nine of them and eight
 * palette slots, and because within a class the row's own label is the
 * identity — the bar beside it is a magnitude gauge, not a second name.
 */
import {
  METRIC_ACTIVITY_CLASSES,
  METRIC_ACTIVITY_CLASS_LABELS,
  METRIC_STATES,
  METRIC_STATE_CLASS,
  METRIC_STATE_LABELS,
  type MetricActivityClass,
  type MetricSpanSummary,
  type MetricState,
} from "@dispatch/shared";
import { Button } from "../ui/Button.js";
import { formatDuration, formatShare, share } from "./duration.js";
import { classColor, useChartPalette } from "./palette.js";

/** The 2px surface gap the house spec puts between touching fills. */
const GAP = "2px";

export function TimeSplit({
  summary,
  onPickState,
  selectedStates,
}: {
  summary: MetricSpanSummary;
  /** Filter the whole page to one state — the rows are the fastest way in. */
  onPickState: (state: MetricState) => void;
  selectedStates: string[] | undefined;
}) {
  const palette = useChartPalette();
  const total = summary.attributedMs;

  const classes = METRIC_ACTIVITY_CLASSES.map((cls) => ({
    cls,
    ms: summary.byClass[cls] ?? 0,
  })).filter((c) => c.ms > 0);

  // Fixed state ORDER, filtered to what the window actually holds — sorting by
  // size would reshuffle the list on every range change, and this list is read
  // by position ("is generating above or below shell today").
  const states = METRIC_STATES.map((state) => ({
    state,
    cls: METRIC_STATE_CLASS[state],
    ms: summary.byState[state] ?? 0,
  })).filter((s) => s.ms > 0);

  if (!total || !states.length) {
    return (
      <p className="px-3 py-6 text-center text-xs text-muted">
        No runtime recorded in this window.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* The meter. Segments are separated by a 2px gap in the surface colour
          rather than a border — white doing the separating, no extra ink. */}
      <div className="flex h-2.5 w-full items-stretch" style={{ gap: GAP }} aria-hidden>
        {classes.map(({ cls, ms }) => (
          <div
            key={cls}
            className="rounded-full"
            style={{
              // A segment narrower than 2px is invisible; floor it so a class
              // with real time in it never disappears from the meter that is
              // supposed to account for the whole window.
              width: `${share(ms, total)}%`,
              minWidth: GAP,
              background: classColor(palette, cls as MetricActivityClass),
            }}
          />
        ))}
      </div>

      {/* The meter's legend — always present, and carrying the values, so the
          card is fully readable without resolving a single hue. */}
      <ul className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {classes.map(({ cls, ms }) => (
          <li key={cls} className="flex items-baseline gap-1.5">
            <span
              aria-hidden
              className="size-2 shrink-0 translate-y-px rounded-sm"
              style={{ background: classColor(palette, cls as MetricActivityClass) }}
            />
            <span className="text-xs text-secondary">{METRIC_ACTIVITY_CLASS_LABELS[cls]}</span>
            <span className="cm-mono text-xs font-semibold text-primary tabular-nums">
              {formatDuration(ms)}
            </span>
            <span className="cm-mono !text-2xs text-faint tabular-nums">{formatShare(ms, total)}</span>
          </li>
        ))}
      </ul>

      {/* Per-state rows: the same time, one level finer. */}
      <ul className="flex flex-col gap-1 pt-1">
        {states.map(({ state, cls, ms }) => {
          const on = selectedStates?.includes(state) ?? false;
          return (
            <li key={state} className="flex items-center gap-2">
              <div className="w-[132px] shrink-0">
                <Button
                  variant="link"
                  onClick={() => onPickState(state)}
                  aria-pressed={on}
                  title={`Filter to ${METRIC_STATE_LABELS[state]}`}
                  className={on ? "max-w-full text-accent" : "max-w-full text-secondary"}
                >
                  <span className="min-w-0 truncate">{METRIC_STATE_LABELS[state]}</span>
                </Button>
              </div>
              {/* Track and fill: one series, one colour — the class's. The track
                  is the panel's own hairline surface, not a lighter tint of the
                  hue, because these bars sit in a column and a coloured track
                  would read as nine more values. */}
              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line-soft">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${share(ms, total)}%`,
                    minWidth: GAP,
                    background: classColor(palette, cls),
                  }}
                />
              </div>
              <span className="cm-mono w-[76px] shrink-0 text-right text-xs text-primary tabular-nums">
                {formatDuration(ms)}
              </span>
              <span className="cm-mono w-[42px] shrink-0 text-right !text-2xs text-muted tabular-nums">
                {formatShare(ms, total)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
