import { useEffect, useMemo, useState } from "react";
import { RotateCw, Gauge as GaugeIcon } from "lucide-react";
import type { HarnessKind, UsageSnapshot, UsageWindow } from "@dispatch/shared";
import { hasWindows, useUsage } from "../../stores/usage.js";
import { useChats } from "../../stores/chats.js";
import { useHarnesses } from "../../stores/harnesses.js";
import { harnessLabel } from "../../lib/harness.js";
import { untilShort, relTime } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { HoverCard } from "../ui/HoverCard.js";
import { SegmentedControl } from "../ui/SegmentedControl.js";
import { Spinner } from "../ui/Spinner.js";
import { SplitBar } from "../ui/SplitBar.js";
import { windowTag } from "../../lib/usageWindow.js";
import { BAR_W, GAUGE_LINE_TRIGGER, GAUGE_TRIGGER, Gauge, type GaugeLayout } from "./Gauge.js";

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

/** One window as a gauge: tag, bar, percent. */
function WindowGauge({
  tag,
  win,
  layout,
  className,
}: {
  tag: string;
  win: UsageWindow;
  layout: GaugeLayout;
  className?: string;
}) {
  const t = tone(win.percent);
  return (
    <Gauge
      label={tag}
      value={`${Math.round(win.percent)}%`}
      tone={t.text}
      layout={layout}
      className={className}
    >
      <SplitBar
        size={layout === "stacked" ? "md" : "xs"}
        className={BAR_W[layout]}
        usedPct={win.percent}
        tone={t.bar}
      />
    </Gauge>
  );
}

function statusLine(usage: UsageSnapshot | undefined, now: number): string {
  if (!usage) return "loading…";
  if (usage.error === "rate_limited") return "rate-limited · showing last";
  if (usage.error === "unauthenticated") return "sign-in needed";
  if (usage.error === "unavailable") return hasWindows(usage) ? "unavailable · showing last" : "unavailable";
  return `updated ${relTime(usage.fetchedAt, now)}`;
}

/**
 * Header usage meter: the provider's primary window as a gauge in the top bar;
 * on hover a panel with every window it reports, reset countdowns, and a refresh.
 * Claude's numbers are polled once server-side (every 5 min) and pushed over the
 * bus; other providers are read when asked for.
 *
 * The TRIGGER shows ONE window, in both layouts. A second, weekly bar was tried
 * on the title bar's second line and taken out: providers do not share a pair
 * of windows — Claude has a 5-hour session and a week, Codex reports whatever
 * lengths its rate limits carry, and a provider may have only one — so a
 * permanent "WK" row is a slot shaped like one provider's plan. The card lists
 * every window the provider actually has, under its own name.
 *
 * The gauge follows the provider you are working in (the active chat's, else
 * the app default), but the card can show EVERY installed provider: running a
 * Codex chat does not stop you caring whether Claude's week is nearly spent.
 * The switcher is a segmented strip rather than a `Select` because a `Select`
 * opens a portalled `Popover`, and clicking into a second portal blurs this
 * card's panel — the exact dismissal `blurLeavesCard` exists to prevent.
 */
export function UsageMeter({ layout }: { layout: GaugeLayout }) {
  const harness = useUsage((s) => s.harness);
  const byProvider = useUsage((s) => s.byProvider);
  const refreshing = useUsage((s) => s.refreshing);
  const load = useUsage((s) => s.load);
  const loadProvider = useUsage((s) => s.loadProvider);
  const refresh = useUsage((s) => s.refresh);
  const harnesses = useHarnesses((s) => s.harnesses);
  const activeHarness = useChats((s) =>
    s.activeChatId ? s.byId[s.activeChatId]?.harness : undefined,
  );

  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** The provider the card is showing; null = whichever the gauge reads. */
  const [picked, setPicked] = useState<HarnessKind | null>(null);
  const viewing = picked ?? harness;

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

  // Re-read a provider the moment it is picked. Nothing pushes Codex's windows,
  // so the copy in the store is only as fresh as the last time someone looked.
  useEffect(() => {
    if (picked) void loadProvider(picked);
  }, [picked, loadProvider]);

  // Installed providers, in the server's order. The gauge's own provider is
  // always in the list, even before `/api/harnesses` has answered.
  const providers = useMemo(() => {
    const kinds = harnesses.filter((h) => h.runtime.available).map((h) => h.kind);
    return kinds.includes(harness) ? kinds : [harness, ...kinds];
  }, [harnesses, harness]);

  const usage = byProvider[harness];
  // Nothing to show for an API-key-only / offline account (no windows at all).
  if (!hasWindows(usage)) return null;

  // The gauge shows the 5-hour window (falls back to weekly if only that exists).
  const primary = usage.fiveHour ?? usage.sevenDay!;
  const primaryTag = usage.fiveHour
    ? windowTag(usage.primaryLabel, "primary")
    : windowTag(usage.secondaryLabel, "secondary");

  const shown = byProvider[viewing];
  const multi = providers.length > 1;

  return (
    <HoverCard
      label={`${harnessLabel(harness)} usage`}
      width={248}
      onOpenChange={(next) => {
        setOpen(next);
        // Every opening starts on the gauge's provider, so the card never
        // contradicts the number you just hovered.
        if (!next) setPicked(null);
      }}
      // Stale means the last refresh failed and these numbers are the previous
      // ones; the panel says so in words, and the whole gauge dims so you can
      // see it without opening anything.
      className={cn(
        layout === "stacked" ? GAUGE_LINE_TRIGGER : GAUGE_TRIGGER.inline,
        usage.stale && "opacity-70",
      )}
      card={() => (
        <>
          <div
            className={cn(
              "flex items-center gap-1.5 border-b border-line px-3",
              multi ? "py-1.5" : "py-2",
            )}
          >
            <GaugeIcon className="size-3.5 shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate text-xs font-semibold tracking-tight text-primary">
              {multi ? "Usage" : `${harnessLabel(viewing)} usage`}
              {shown?.planType && <span className="text-faint"> · {shown.planType}</span>}
            </span>
            {multi && (
              <SegmentedControl
                segments={providers.map((kind) => ({ value: kind, label: harnessLabel(kind) }))}
                value={viewing}
                onChange={(kind) => setPicked(kind)}
              />
            )}
          </div>

          {hasWindows(shown) ? (
            <div className="divide-y divide-line-soft">
              <WindowRow label={shown.primaryLabel ?? "5-hour session"} win={shown.fiveHour} now={now} />
              <WindowRow label={shown.secondaryLabel ?? "Weekly"} win={shown.sevenDay} now={now} />
            </div>
          ) : shown ? (
            <div className="px-3 py-3 text-xs text-muted">
              No usage reported for {harnessLabel(viewing)}.
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted">
              <Spinner size={12} />
              Loading {harnessLabel(viewing)} usage…
            </div>
          )}

          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-1.5">
            <span className="text-2xs text-faint">{statusLine(shown, now)}</span>
            <button
              onClick={() => void refresh(viewing)}
              disabled={!!refreshing[viewing]}
              className="inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-2xs text-secondary transition-colors hover:bg-active hover:text-primary disabled:opacity-50 [&_svg]:size-3"
            >
              <RotateCw className={cn(refreshing[viewing] && "cm-anim-spin")} />
              Refresh
            </button>
          </div>
        </>
      )}
    >
      <WindowGauge tag={primaryTag} win={primary} layout={layout} />
    </HoverCard>
  );
}
