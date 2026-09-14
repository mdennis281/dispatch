import { useEffect, useState } from "react";
import { RotateCw, Gauge as GaugeIcon } from "lucide-react";
import {
  DEFAULT_HARNESS,
  chatAccountOf,
  providerFor,
  type SubscriptionUsage,
  type TitledUsageWindow,
  type UsageWindow,
} from "@dispatch/shared";
import { hasWindows, usageKey, useUsage } from "../../stores/usage.js";
import { useSubscriptions } from "../../stores/subscriptions.js";
import { useChats } from "../../stores/chats.js";
import { untilShort, relTime } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { HoverCard } from "../ui/HoverCard.js";
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

/**
 * One window as ONE line: title, bar, percent, reset. The old row was three
 * lines (label + percent, bar, "resets in") — fine for one account's two
 * windows, but stacked across every account it made the card taller than the
 * screen it hangs from.
 */
function WindowLine({ win, now }: { win: TitledUsageWindow; now: number }) {
  const t = tone(win.percent);
  return (
    <div className="grid grid-cols-[6.5rem_1fr_2.5rem_2.75rem] items-center gap-2 py-[3px]">
      <span className="truncate text-2xs text-secondary" title={win.title}>
        {win.title}
      </span>
      <span className="relative h-1 overflow-hidden rounded-full bg-line">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full transition-[width]", t.bar)}
          style={{ width: `${clampPct(win.percent)}%` }}
        />
      </span>
      <span className={cn("cm-mono text-right text-2xs font-semibold", t.text)}>
        {Math.round(win.percent)}%
      </span>
      <span className="cm-mono text-right text-2xs text-faint" title="resets in">
        {win.resetsAt !== null ? untilShort(win.resetsAt, now) : ""}
      </span>
    </div>
  );
}

/** Why a row has no fresh numbers, in a few words. */
function rowProblem(row: SubscriptionUsage): string | null {
  if (row.error === "rate_limited") return "rate-limited";
  if (row.error === "unauthenticated") return "sign-in needed";
  if (row.error) return "unavailable";
  return null;
}

/** One account: a tight header, then a line per window. */
function AccountBlock({
  row,
  current,
  now,
}: {
  row: SubscriptionUsage;
  current: boolean;
  now: number;
}) {
  const problem = rowProblem(row);
  return (
    <div className={cn("px-3 py-1.5", row.stale && "opacity-70")}>
      <div className="flex items-baseline gap-1.5">
        {/* The account the gauge is reading carries the accent, so the card
            still answers "which of these is the number I hovered". */}
        <span
          className={cn(
            "size-1.5 shrink-0 self-center rounded-full",
            current ? "bg-accent" : "bg-transparent",
          )}
        />
        <span className="truncate text-xs font-semibold text-primary">{row.name}</span>
        <span className="truncate text-2xs text-faint">
          {providerFor(row.provider).shortLabel}
          {row.planType && ` · ${row.planType}`}
        </span>
        {problem && <span className="ml-auto shrink-0 text-2xs text-warn">{problem}</span>}
      </div>
      {row.windows.length ? (
        row.windows.map((win) => <WindowLine key={win.title} win={win} now={now} />)
      ) : (
        <div className="py-[3px] text-2xs text-faint">No usage reported.</div>
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
  /** Null when the gauge's account has no reading right now (rate-limited, say). */
  win: UsageWindow | null;
  layout: GaugeLayout;
  className?: string;
}) {
  const t = win ? tone(win.percent) : { text: "text-faint", bar: "bg-line" };
  return (
    <Gauge
      label={tag}
      value={win ? `${Math.round(win.percent)}%` : "—"}
      tone={t.text}
      layout={layout}
      className={className}
    >
      <SplitBar
        size={layout === "stacked" ? "md" : "xs"}
        className={BAR_W[layout]}
        usedPct={win?.percent ?? 0}
        tone={t.bar}
      />
    </Gauge>
  );
}

/**
 * Header usage meter: the active account's primary window as a gauge in the top
 * bar; on hover, EVERY logged-in account stacked — each with every window its
 * provider reports — and one refresh for the lot.
 *
 * The TRIGGER shows ONE window, in both layouts. A second, weekly bar was tried
 * on the title bar's second line and taken out: providers do not share a pair
 * of windows — Claude has a 5-hour session and a week, Codex reports whatever
 * lengths its rate limits carry, and a provider may have only one — so a
 * permanent "WK" row is a slot shaped like one provider's plan. The card lists
 * every window each account actually has, under its own name.
 *
 * The card stacks accounts rather than switching between them. It had tabs, and
 * they could not be used: the card is a hover card, and moving the pointer
 * toward a tab at the far end of the strip crossed the gap that closes it.
 * Stacked, there is nothing to reach for — which also means the card needs every
 * account's numbers up front, hence one overview read on open.
 */
export function UsageMeter({ layout }: { layout: GaugeLayout }) {
  const target = useUsage((s) => s.target);
  const bySubscription = useUsage((s) => s.bySubscription);
  const load = useUsage((s) => s.load);
  const overview = useUsage((s) => s.overview);
  const overviewLoading = useUsage((s) => s.overviewLoading);
  const loadOverview = useUsage((s) => s.loadOverview);
  const accounts = useSubscriptions((s) => s.list);
  const activeChat = useChats((s) => (s.activeChatId ? s.byId[s.activeChatId] : undefined));
  // The ACCOUNT the active chat runs under, not just its provider: two Claude
  // logins have two unrelated 5-hour windows, and the gauge beside a chat has
  // to be the one that chat is spending.
  const activeHarness = activeChat?.harness ?? (activeChat ? DEFAULT_HARNESS : undefined);
  const activeAccount = activeChat
    ? chatAccountOf(accounts, activeChat, activeHarness!)?.id
    : undefined;

  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Lazy initial load; live `usage-update` events keep it fresh thereafter.
  useEffect(() => {
    void load(activeHarness ? { harness: activeHarness, subscriptionId: activeAccount } : undefined);
  }, [load, activeHarness, activeAccount]);

  // The gauge's own account came back with no reading (rate-limited, say): read
  // the rest ONCE, so the meter can still appear for the accounts that do have
  // numbers. Only after that first read has landed empty — never on first paint.
  const targetUsage = bySubscription[usageKey(target)];
  useEffect(() => {
    if (targetUsage && !hasWindows(targetUsage) && !overview && !overviewLoading) {
      void loadOverview();
    }
  }, [targetUsage, overview, overviewLoading, loadOverview]);

  // Countdowns tick only while the panel is open, and every opening re-reads the
  // list — nothing pushes Codex's windows, so the copy is only as fresh as the
  // last time someone looked.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    void loadOverview();
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, [open, loadOverview]);

  const usage = bySubscription[usageKey(target)];
  // Hidden only when NO account has a reading. An account that is merely
  // rate-limited used to hide the whole meter — and with it the card holding
  // every OTHER account's good numbers. "Some account has windows" is the test,
  // not "some account is logged in": a Codex API-key login writes the same
  // auth file and reports no windows at all, and a `—` gauge over a card of
  // "No usage reported" is worse than no gauge.
  const anyReading =
    Object.values(bySubscription).some(hasWindows) ||
    Boolean(overview?.subscriptions.some((row) => row.windows.length));
  if (!anyReading) return null;

  // The gauge shows the 5-hour window (falls back to weekly if only that exists).
  const primary = hasWindows(usage) ? (usage.fiveHour ?? usage.sevenDay!) : null;
  const primaryTag =
    usage && !usage.fiveHour && usage.sevenDay
      ? windowTag(usage.secondaryLabel, "secondary")
      : windowTag(usage?.primaryLabel, "primary");
  const currentId = usage?.subscriptionId ?? target.subscriptionId;
  const rows = overview?.subscriptions ?? [];
  // The oldest row's read is the honest "updated": a shared line naming the
  // newest would claim freshness for a row that is minutes behind it.
  const oldest = rows.length ? Math.min(...rows.map((r) => r.fetchedAt)) : undefined;

  return (
    <HoverCard
      label="Usage"
      width={300}
      onOpenChange={setOpen}
      // Stale means the last refresh failed and these numbers are the previous
      // ones; the panel says so in words, and the whole gauge dims so you can
      // see it without opening anything.
      className={cn(
        layout === "stacked" ? GAUGE_LINE_TRIGGER : GAUGE_TRIGGER.inline,
        (!usage || usage.stale) && "opacity-70",
      )}
      card={() => (
        <>
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-1.5">
            <GaugeIcon className="size-3.5 shrink-0 text-muted" />
            <span className="text-xs font-semibold tracking-tight text-primary">Usage</span>
          </div>

          {rows.length ? (
            <div className="max-h-[60vh] divide-y divide-line-soft overflow-y-auto">
              {rows.map((row) => (
                <AccountBlock
                  key={row.subscriptionId}
                  row={row}
                  current={row.subscriptionId === currentId}
                  now={now}
                />
              ))}
            </div>
          ) : overview ? (
            <div className="px-3 py-3 text-xs text-muted">No logged-in accounts report usage.</div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted">
              <Spinner size={12} />
              Loading usage…
            </div>
          )}

          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-1">
            <span className="text-2xs text-faint">
              {oldest !== undefined ? `updated ${relTime(oldest, now)}` : "loading…"}
            </span>
            <button
              onClick={() => void loadOverview(true)}
              disabled={!!overviewLoading}
              className="inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-2xs text-secondary transition-colors hover:bg-active hover:text-primary disabled:opacity-50 [&_svg]:size-3"
            >
              <RotateCw className={cn(overviewLoading === "refresh" && "cm-anim-spin")} />
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
