import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RotateCw, Gauge } from "lucide-react";
import type { UsageWindow } from "@cm/shared";
import { useUsage } from "../../stores/usage.js";
import { untilShort, relTime } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";

/** Escalating tone by utilization — accent (fine) → warn → danger. */
function tone(pct: number): { text: string; bar: string } {
  if (pct >= 90) return { text: "text-danger", bar: "bg-danger" };
  if (pct >= 70) return { text: "text-warn", bar: "bg-warn" };
  return { text: "text-accent-hi", bar: "bg-accent" };
}

const clampPct = (p: number) => Math.max(0, Math.min(100, p));

/** A labelled window row inside the dropdown (bar + percent + reset countdown). */
function WindowRow({
  label,
  win,
  now,
}: {
  label: string;
  win: UsageWindow | null;
  now: number;
}) {
  if (!win) return null;
  const pct = Math.round(win.percent);
  const t = tone(win.percent);
  return (
    <div className="px-3 py-2">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11.5px] font-medium text-secondary">{label}</span>
        <span className={cn("cm-mono text-[11px] font-semibold", t.text)}>{pct}%</span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-line">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full transition-[width]", t.bar)}
          style={{ width: `${clampPct(win.percent)}%` }}
        />
      </div>
      {win.resetsAt !== null && (
        <div className="mt-1 text-[10.5px] text-faint">resets in {untilShort(win.resetsAt, now)}</div>
      )}
    </div>
  );
}

/**
 * Header usage meter: a compact 5-hour pill; on hover a dropdown with the 5h +
 * weekly windows, reset countdowns, and a manual refresh. Data is polled once
 * server-side (every 5 min) and pushed over the bus, so this only reads the store
 * (plus a lazy initial REST load on mount).
 */
export function UsageMeter() {
  const usage = useUsage((s) => s.usage);
  const refreshing = useUsage((s) => s.refreshing);
  const load = useUsage((s) => s.load);
  const refresh = useUsage((s) => s.refresh);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const btnRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lazy initial load; live `usage-update` events keep it fresh thereafter.
  useEffect(() => {
    void load();
  }, [load]);

  // While open, keep the panel glued to the trigger and countdowns ticking.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      clearInterval(tick);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const openNow = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const closeSoon = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  };

  // Nothing to show for an API-key-only / offline account (no windows at all).
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) return null;

  // Trigger shows the 5-hour window (falls back to weekly if only that exists).
  const primary = usage.fiveHour ?? usage.sevenDay!;
  const primaryLabel = usage.fiveHour ? "5h" : "7d";
  const t = tone(primary.percent);

  return (
    <div className="relative inline-flex" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <button
        ref={btnRef}
        onClick={openNow}
        aria-label="Claude usage"
        className={cn(
          "flex items-center gap-1.5 rounded-md border border-line bg-panel-2/60 px-2 py-1",
          "transition-colors hover:border-line-strong",
          usage.stale && "opacity-70",
        )}
      >
        <span className="cm-mono text-[9.5px] text-faint">{primaryLabel}</span>
        <span className="relative h-1 w-7 overflow-hidden rounded-full bg-line">
          <span
            className={cn("absolute inset-y-0 left-0 rounded-full", t.bar)}
            style={{ width: `${clampPct(primary.percent)}%` }}
          />
        </span>
        <span className={cn("text-[11px] font-semibold tabular-nums", t.text)}>
          {Math.round(primary.percent)}%
        </span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            onMouseEnter={openNow}
            onMouseLeave={closeSoon}
            style={{ top: pos.top, right: pos.right }}
            className={cn(
              "fixed z-[120] w-[248px] overflow-hidden rounded-md border border-line-strong",
              "bg-overlay/98 backdrop-blur-md shadow-[var(--shadow-pop)] cm-anim-rise",
            )}
          >
            <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
              <Gauge className="size-3.5 text-muted" />
              <span className="text-[11.5px] font-semibold tracking-tight text-primary">
                Claude usage
              </span>
            </div>

            <div className="divide-y divide-line-soft">
              <WindowRow label="5-hour session" win={usage.fiveHour} now={now} />
              <WindowRow label="Weekly" win={usage.sevenDay} now={now} />
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-1.5">
              <span className="text-[10px] text-faint">
                {usage.error === "rate_limited"
                  ? "rate-limited · showing last"
                  : usage.error === "unauthenticated"
                    ? "sign-in needed"
                    : `updated ${relTime(usage.fetchedAt, now)}`}
              </span>
              <button
                onClick={() => void refresh()}
                disabled={refreshing}
                className="inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10.5px] text-secondary transition-colors hover:bg-white/[0.06] hover:text-primary disabled:opacity-50 [&_svg]:size-3"
              >
                <RotateCw className={cn(refreshing && "cm-anim-spin")} />
                Refresh
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
