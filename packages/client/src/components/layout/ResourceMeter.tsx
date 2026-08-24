/**
 * Header resource meter: a compact CPU/memory pill, with a dropdown breaking
 * out how much of the machine is Dispatch's doing.
 *
 * WHY IT IS IN THE HEADER. The failure this exists for is the box going
 * unresponsive mid-turn, and by the time that happens it is too late to go
 * looking. A number that is always on screen turns "why is everything slow"
 * into a glance.
 *
 * WHAT IT COSTS. The pill runs entirely on `/api/resources/system` — `os.cpus()`
 * and `os.freemem()`, ~0.2 ms server-side with no subprocess — which is what
 * lets it tick every couple of seconds without being part of the problem. The
 * DROPDOWN wants Dispatch's own share, and that needs the OS process table at
 * ~800 ms a scan, so it is fetched when the dropdown OPENS and not before. Open
 * it and the first reading is a moment behind; that is the honest trade, and it
 * beats scanning the process table forever on the chance somebody hovers.
 *
 * TONE IS DRIVEN BY MEMORY, NOT CPU. Pegged CPU is what a working machine looks
 * like — agents compile things. Exhausted MEMORY is what makes it unusable, and
 * it is the one the reaper on the Resources page can actually do something
 * about, so it is the one that turns the pill amber.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cpu, MemoryStick, ExternalLink } from "lucide-react";
import { SHARED_PAGE_FACTOR } from "@dispatch/shared";
import { useResources, share, machinePct } from "../../stores/resources.js";
import { setView, useView } from "../../stores/view.js";
import { bytes, pct } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { LAYER } from "../../lib/layers.js";
import { Button } from "../ui/Button.js";

/** Escalating tone by utilization — matches `UsageMeter.tone`. */
function tone(p: number): { text: string; bar: string } {
  if (p >= 90) return { text: "text-danger", bar: "bg-danger" };
  if (p >= 75) return { text: "text-warn", bar: "bg-warn" };
  return { text: "text-accent-hi", bar: "bg-accent" };
}

/** One labelled bar in the dropdown. */
function Row({
  label,
  value,
  pctOf,
  hint,
  barClass,
}: {
  label: string;
  value: string;
  pctOf: number;
  hint?: string;
  barClass?: string;
}) {
  return (
    <div className="px-3 py-2">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-secondary">{label}</span>
        <span className="cm-mono text-xs font-semibold text-primary">{value}</span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-line">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", barClass ?? "bg-accent")}
          style={{ width: `${pctOf}%` }}
        />
      </div>
      {hint && <div className="mt-1 text-2xs text-faint">{hint}</div>}
    </div>
  );
}

export function ResourceMeter() {
  const system = useResources((s) => s.system);
  const snapshot = useResources((s) => s.snapshot);
  const refreshSnapshot = useResources((s) => s.refreshSnapshot);
  const view = useView((s) => s.view);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The expensive half, fetched on OPEN and then kept warm while it stays open.
  // Nothing scans the process table on this widget's behalf until someone
  // actually asks to see the breakdown.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    void refreshSnapshot();
    const tick = setInterval(() => void refreshSnapshot(), 5_000);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      clearInterval(tick);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, refreshSnapshot]);

  const openNow = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const closeSoon = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  };

  // Nothing at all until the first reading lands — a pill showing "—/—" for a
  // second on every load is worse than one that arrives a second late.
  if (!system) return null;

  const memPct = share(system.usedBytes, system.totalBytes);
  const t = tone(memPct);
  const dispatch = snapshot?.dispatch ?? null;

  return (
    <div className="relative inline-flex" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <button
        ref={btnRef}
        onClick={openNow}
        aria-label="System resources"
        className={cn(
          "flex items-center gap-1.5 rounded-md border border-line bg-panel-2/60 px-2 py-1",
          "transition-colors hover:border-line-strong",
        )}
      >
        <Cpu className="size-3 text-faint" />
        <span className="cm-mono text-xs font-semibold tabular-nums text-secondary">
          {pct(system.cpuPct)}
        </span>
        <span className="relative h-1 w-7 overflow-hidden rounded-full bg-line">
          <span
            className={cn("absolute inset-y-0 left-0 rounded-full", t.bar)}
            style={{ width: `${memPct}%` }}
          />
        </span>
        <span className={cn("text-xs font-semibold tabular-nums", t.text)}>
          {Math.round(memPct)}%
        </span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            onMouseEnter={openNow}
            onMouseLeave={closeSoon}
            style={{ zIndex: LAYER.popover, top: pos.top, right: pos.right }}
            className={cn(
              "fixed w-[280px] overflow-hidden rounded-md border border-line-strong",
              "bg-overlay/98 backdrop-blur-md shadow-[var(--shadow-pop)] cm-anim-rise",
            )}
          >
            <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
              <MemoryStick className="size-3.5 text-muted" />
              <span className="text-xs font-semibold tracking-tight text-primary">
                This machine
                <span className="text-faint"> · {system.logicalCores} cores</span>
              </span>
            </div>

            <div className="divide-y divide-line-soft">
              <Row
                label="Memory"
                value={`${bytes(system.usedBytes)} / ${bytes(system.totalBytes)}`}
                pctOf={memPct}
                barClass={t.bar}
                hint={`${bytes(system.freeBytes)} free`}
              />
              <Row
                label="CPU"
                value={pct(system.cpuPct)}
                pctOf={system.cpuPct ?? 0}
                hint={
                  system.cpuPct === null ? "measuring…" : `across ${system.logicalCores} cores`
                }
              />
            </div>

            <div className="border-t border-line px-3 py-2">
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-primary">Dispatch's share</span>
                {dispatch && (
                  <span className="cm-mono text-2xs text-faint">{dispatch.procs} procs</span>
                )}
              </div>
              {dispatch ? (
                <>
                  <Row
                    label="Memory"
                    // Corrected for shared pages: the raw sum counts a shared
                    // runtime image once per process and runs ~1.9x high, which
                    // next to a real system total would be nonsense (it can
                    // exceed installed RAM). See `SHARED_PAGE_FACTOR`.
                    value={`≈${bytes(dispatch.rssBytes / SHARED_PAGE_FACTOR)}`}
                    pctOf={share(dispatch.rssBytes / SHARED_PAGE_FACTOR, system.totalBytes)}
                    hint={`≈${Math.round(
                      share(dispatch.rssBytes / SHARED_PAGE_FACTOR, system.totalBytes),
                    )}% of this machine · estimate`}
                  />
                  <Row
                    label="CPU"
                    // Machine-relative, like the row above it. The server
                    // reports a share of ONE core; showing that raw next to a
                    // whole-machine figure put two numbers 16x apart under the
                    // same label. See `machinePct`.
                    value={pct(machinePct(dispatch.cpuPct, system.logicalCores))}
                    pctOf={share(dispatch.cpuPct ?? 0, 100 * system.logicalCores)}
                    hint={`server itself ${bytes(dispatch.serverRssBytes)}`}
                  />
                </>
              ) : (
                <div className="px-0 py-1 text-2xs text-faint">measuring…</div>
              )}
            </div>

            <Button
              variant="ghost"
              size="sm"
              rightIcon={<ExternalLink className="size-3" />}
              onClick={() => {
                setOpen(false);
                setView("metrics");
                useView.getState().setMetricsSection("resources");
              }}
              className={cn(
                "w-full justify-between rounded-none border-t border-line px-3",
                view === "metrics" && "text-primary",
              )}
            >
              Break down by chat
            </Button>
          </div>,
          document.body,
        )}
    </div>
  );
}
