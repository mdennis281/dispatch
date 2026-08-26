/**
 * The chart palette, resolved to concrete colours.
 *
 * The values themselves live in the files under `theme/` as
 * `--p-chart-1…8` — that is where every colour in this app is declared, and the
 * validation notes for the set live beside them. This module only READS them.
 *
 * Why resolve rather than hand Recharts `var(--p-chart-1)`: those end up on SVG
 * presentation attributes (`fill`, `stroke`), where `var()` support is real but
 * uneven, and a chart that silently paints black on one engine is not a failure
 * you notice in review. `getComputedStyle` gives a hex, which every renderer
 * agrees on. The read is once per theme flip, not per frame.
 */
import { useEffect, useState } from "react";
import { useTheme } from "../../stores/theme.js";

/** How many categorical slots exist. A ninth series folds into "Other". */
export const SERIES_SLOTS = 8;

export interface ChartPalette {
  /** The eight categorical hues, in their fixed order. */
  series: string[];
  /** The grey the "Other" fold and de-emphasised marks wear. */
  other: string;
  /** Gridlines — one step off the surface. */
  grid: string;
  /** The surface the chart is painted on; the 2px gaps and rings are this. */
  surface: string;
  /** Axis/tick ink. Text never wears a series colour. */
  ink: string;
}

/** Read one `--p-*` off the document, with a fallback for the pre-paint frame. */
function readVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function readPalette(): ChartPalette {
  return {
    series: Array.from({ length: SERIES_SLOTS }, (_, i) =>
      readVar(`--p-chart-${i + 1}`, "#3987e5"),
    ),
    other: readVar("--p-chart-other", "#6b7280"),
    grid: readVar("--p-chart-grid", "rgba(128,128,128,0.15)"),
    surface: readVar("--p-panel", "#111418"),
    ink: readVar("--p-text-muted", "#6b7280"),
  };
}

/**
 * The active palette, re-read when the theme flips.
 *
 * Keyed on the RESOLVED theme rather than the preference, so `system` following
 * the OS mid-session re-reads too (the store recomputes `resolved` on the media
 * query — see stores/theme).
 */
export function useChartPalette(): ChartPalette {
  const resolved = useTheme((s) => s.resolved);
  const [palette, setPalette] = useState<ChartPalette>(readPalette);
  useEffect(() => {
    // The attribute is written synchronously by the store's `applyTheme`, but
    // the stylesheet cascade settles on the next frame — reading in the same
    // tick returns the OUTGOING theme's values.
    const id = requestAnimationFrame(() => setPalette(readPalette()));
    return () => cancelAnimationFrame(id);
  }, [resolved]);
  return palette;
}

/**
 * The colour for a series.
 *
 * Assigned by the series' POSITION IN THE RESPONSE, which the server sorts by
 * total and holds stable for a given query — so a series keeps its colour while
 * you change chart type, and only re-maps when the data behind it actually
 * changes. `__other__` is always the grey, whatever position it lands in.
 */
export function colorFor(palette: ChartPalette, key: string, index: number): string {
  if (key === "__other__") return palette.other;
  return palette.series[index % palette.series.length]!;
}

/**
 * Fixed slots for the activity classes.
 *
 * The three classes are a CLOSED, ORDERED set — thinking / working / blocked —
 * so they get fixed hues rather than positional ones. The rule is "colour
 * follows the entity, never its rank": the runtime page paints the same three
 * classes in a meter, in a chart and in a table, and the server sorts each of
 * those by time, so a positional assignment would repaint blocked from aqua to
 * blue the moment a window had more waiting in it than generating.
 *
 * The first three slots rather than any three — `--p-chart-1…3` as the theme
 * files name them, which is array indices 0–2 here. The palette's adjacent-pair
 * separation is validated in the order the slots are declared (see
 * `theme/*.css`), and these three are always drawn touching each other in the
 * meter, so they need to be a validated-adjacent run rather than three picked
 * out of the middle.
 *
 * The STATES are deliberately not in here. There are nine of them and eight
 * slots, so any fixed map would have to leave one out — and the server already
 * folds the ninth into "Other". States keep the positional assignment the rest
 * of the page uses.
 */
export const CLASS_SLOT: Record<"thinking" | "working" | "blocked", number> = {
  thinking: 0,
  working: 1,
  blocked: 2,
};

/** The fixed colour for one activity class. */
export function classColor(palette: ChartPalette, cls: keyof typeof CLASS_SLOT): string {
  return palette.series[CLASS_SLOT[cls]]!;
}

/**
 * The colour for a group of a SPAN query.
 *
 * Same as {@link colorFor}, except that `class` groups take their fixed slot —
 * so the chart's "Blocked" series and the meter's "Blocked" segment are the
 * same hue, which they were not when both were assigned by position.
 */
export function spanColorFor(
  palette: ChartPalette,
  dim: string,
  key: string,
  index: number,
): string {
  if (dim === "class" && key in CLASS_SLOT) {
    return classColor(palette, key as keyof typeof CLASS_SLOT);
  }
  return colorFor(palette, key, index);
}
