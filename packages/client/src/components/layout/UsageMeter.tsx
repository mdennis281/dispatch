import { useEffect, useState } from "react";
import { RotateCw, Gauge as GaugeIcon } from "lucide-react";
import type { UsageWindow } from "@dispatch/shared";
import { useUsage } from "../../stores/usage.js";
import { useChats } from "../../stores/chats.js";
import { untilShort, relTime } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { HoverCard } from "../ui/HoverCard.js";
import { SplitBar } from "../ui/SplitBar.js";
import { GAUGE_TRIGGER, Gauge } from "./Gauge.js";

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
        <span className="text-xs font-medium text-secondary">{label}</span>
        <span className={cn("cm-mono text-xs font-semibold", t.text)}>{pct}%</span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-line">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full transition-[width]", t.bar)}
          style={{ width: `${clampPct(win.percent)}%` }}
        />
      </div>
      {win.resetsAt !== null && (
        <div className="mt-1 text-2xs text-faint">resets in {untilShort(win.resetsAt, now)}</div>
      )}
    </div>
  );
}

/**
 * Header usage meter: the 5-hour window as a gauge in the status line; on hover
 * a panel with the 5h + weekly windows, reset countdowns, and a manual refresh.
 * Data is polled once server-side (every 5 min) and pushed over the bus, so this
 * only reads the store (plus a lazy initial REST load on mount).
 *
 * The TRIGGER shows one window, not both. Two stacked 2px tracks in a 33px
 * title bar is a picture of a chart rather than a reading, and the weekly
 * figure is not one anybody acts on hour to hour — it belongs in the panel,
 * where it has room for its own label and reset countdown.
 */
export function UsageMeter() {
  const usage = useUsage((s) => s.usage);
  const refreshing = useUsage((s) => s.refreshing);
  const load = useUsage((s) => s.load);
  const refresh = useUsage((s) => s.refresh);
  const activeHarness = useChats((s) =>
    s.activeChatId ? s.byId[s.activeChatId]?.harness : undefined,
  );

  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Lazy initial load; live `usage-update` events keep it fresh thereafter.
  useEffect(() => {
    void load(activeHarness ?? undefined);
  }, [load, activeHarness]);

  // Countdowns tick only while the panel is open — "resets in 41m" is the only
  // thing in here that goes stale on its own, and it is not on screen until
  // then. `HoverCard` owns the hover and the placement.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, [open]);

  // Nothing to show for an API-key-only / offline account (no windows at all).
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) return null;

  // The gauge shows the 5-hour window (falls back to weekly if only that exists).
  const primary = usage.fiveHour ?? usage.sevenDay!;
  const primaryLabel = usage.provider === "codex" ? "usage" : usage.fiveHour ? "5h" : "7d";
  const t = tone(primary.percent);

  return (
    <HoverCard
      label={`${usage.provider === "codex" ? "Codex" : "Claude"} usage`}
      width={248}
      onOpenChange={setOpen}
      // Stale means the last refresh failed and these numbers are the previous
      // ones; the panel says so in words, and the whole gauge dims so you can
      // see it without opening anything.
      className={cn(GAUGE_TRIGGER, usage.stale && "opacity-70")}
      card={() => (
        <>
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
            <GaugeIcon className="size-3.5 text-muted" />
            <span className="text-xs font-semibold tracking-tight text-primary">
              {usage.provider === "codex" ? "Codex" : "Claude"} usage
              {usage.planType && <span className="text-faint"> · {usage.planType}</span>}
            </span>
          </div>

          <div className="divide-y divide-line-soft">
            <WindowRow label={usage.primaryLabel ?? "5-hour session"} win={usage.fiveHour} now={now} />
            <WindowRow label={usage.secondaryLabel ?? "Weekly"} win={usage.sevenDay} now={now} />
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-1.5">
            <span className="text-2xs text-faint">
              {usage.error === "rate_limited"
                ? "rate-limited · showing last"
                : usage.error === "unauthenticated"
                  ? "sign-in needed"
                  : `updated ${relTime(usage.fetchedAt, now)}`}
            </span>
            <button
              onClick={() => void refresh()}
              disabled={refreshing}
              className="inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-2xs text-secondary transition-colors hover:bg-active hover:text-primary disabled:opacity-50 [&_svg]:size-3"
            >
              <RotateCw className={cn(refreshing && "cm-anim-spin")} />
              Refresh
            </button>
          </div>
        </>
      )}
    >
      <Gauge label={primaryLabel} value={`${Math.round(primary.percent)}%`} tone={t.text}>
        <SplitBar size="xs" className="w-7" usedPct={primary.percent} tone={t.bar} />
      </Gauge>
    </HoverCard>
  );
}
