/**
 * The pieces both halves of the Metrics screen are built from.
 *
 * Usage counts things and Runtime measures time, but they are the same PAGE —
 * hero figure, supporting tiles, a chart, a breakdown, an activity tail — and a
 * tile that is 92px wide on one tab and 96px on the other reads as two products
 * stapled together. So the furniture lives here once and the two views differ
 * only in what they put in it.
 */
import type { ReactNode } from "react";

const num = new Intl.NumberFormat();

/** Compact big numbers (1,284 / 12.9K / 1.4M) — a hero figure isn't a receipt. */
export function compact(n: number): string {
  if (n < 10_000) return num.format(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** Thousands-separated, for table cells and counts that aren't the hero. */
export function count(n: number): string {
  return num.format(n);
}

/** "3d ago" style stamp, matching the Memory view's. */
export function ago(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * The one number the page leads with. Exactly one per view.
 *
 * Proportional figures, NOT `tabular-nums`: equal-width digits make a large
 * standalone number look loose, and there is nothing beside it to align to.
 * `hint` is where the measure gets defined — on the runtime page the hero is
 * wall clock and the tile beside it is a plain sum, and a reader who can't tell
 * which is which has been shown two numbers and given one.
 */
export function Hero({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <p className="text-2xs text-muted">{label}</p>
      <p className="mt-0.5 text-5xl font-semibold leading-none text-primary">{value}</p>
      {hint && <p className="mt-1.5 text-2xs text-faint">{hint}</p>}
    </div>
  );
}

/** A supporting number beside the hero figure. Proportional figures, no delta. */
export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
}) {
  return (
    <div className="min-w-[92px] rounded-lg border border-line bg-panel px-3 py-2">
      <p className="text-2xs text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-2xs text-faint">{hint}</p>}
    </div>
  );
}

/** A titled card — the box every section of both views sits in. */
export function Card({
  title,
  icon,
  note,
  children,
  controls,
}: {
  title?: string;
  icon?: ReactNode;
  /** A right-aligned caveat. Never let a card bound what it shows silently. */
  note?: ReactNode;
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-panel">
      {(title || controls) && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 cm-hairline-b">
          {icon && <span className="text-faint [&_svg]:size-3.5">{icon}</span>}
          {title && <span className="text-2xs font-medium text-muted">{title}</span>}
          {controls}
          {note && <span className="ml-auto text-2xs text-faint">{note}</span>}
        </div>
      )}
      {children}
    </section>
  );
}
