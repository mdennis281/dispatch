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
 * ── THE PILL DRAWS TWO BARS AND NO SPLIT ─────────────────────────────────────
 *
 * It shipped with ONE bar between two numbers, and the bar was memory while the
 * icon in front of it was a CPU chip — so the widget read left to right as
 * "CPU 37%, [bar], 74%" and the bar belonged to neither number it sat between.
 * Two metrics get two bars, each under its own icon and in front of its own
 * figure.
 *
 * Neither carries Dispatch's share, unlike every other bar in this feature.
 * That is the polling split above showing through: the pill has only the free
 * reading, and the alternative — painting whatever share the last opened
 * dropdown happened to leave in the store — is a figure that silently ages for
 * as long as the tab stays open. A bar with no breakdown is drawn at full
 * strength precisely so it cannot be mistaken for one whose Dispatch slice is
 * merely small. See `SplitBar`'s `sharePct: null`.
 *
 * TONE IS DRIVEN BY MEMORY, NOT CPU. Pegged CPU is what a working machine looks
 * like — agents compile things. Exhausted MEMORY is what makes it unusable, and
 * it is the one the reaper on the Resources page can actually do something
 * about, so it is the one that turns the pill amber.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cpu, MemoryStick, ExternalLink, Server } from "lucide-react";
import {
  useResources,
  share,
  memorySplit,
  cpuSplit,
  freshDispatch,
  type ResourceSplit,
} from "../../stores/resources.js";
import { setView, useView } from "../../stores/view.js";
import { bytes, pct } from "../../lib/format.js";
import { cn } from "../../lib/cn.js";
import { CPU_BAR, machineTone } from "../../lib/resourceTone.js";
import { LAYER } from "../../lib/layers.js";
import { Button } from "../ui/Button.js";
import { SplitBar, SplitDot } from "../ui/SplitBar.js";

/** One legend entry — swatch, what it is, how much of it. */
function Leg({
  layer,
  barTone,
  label,
  value,
}: {
  layer: "share" | "other" | "free";
  barTone: string;
  label: string;
  value: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <SplitDot layer={layer} tone={barTone} />
      <span className="text-faint">{label}</span>
      <span
        className={cn("cm-mono tabular-nums", layer === "share" ? "text-secondary" : "text-muted")}
      >
        {value}
      </span>
    </span>
  );
}

/** One metric in the dropdown: headline figure, split bar, inline legend. */
function Meter({
  label,
  headline,
  split,
  barTone,
  fmt,
  approx,
  freeWord,
}: {
  label: string;
  headline: string;
  split: ResourceSplit;
  barTone: string;
  fmt: (n: number) => string;
  /** Mark Dispatch's figure `≈` — true for memory, which is an estimate. */
  approx?: boolean;
  freeWord: string;
}) {
  const measuring = split.dispatch === null;
  return (
    <div className="px-3 py-2">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-secondary">{label}</span>
        <span className="cm-mono text-xs font-semibold tabular-nums text-primary">{headline}</span>
      </div>
      <SplitBar
        usedPct={split.usedPct}
        sharePct={measuring ? null : split.dispatchPct}
        tone={barTone}
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs">
        {!split.measured ? (
          <span className="text-faint">needs a second sample</span>
        ) : (
          <>
            <Leg
              layer="share"
              barTone={barTone}
              label="Dispatch"
              value={measuring ? "…" : `${approx ? "≈" : ""}${fmt(split.dispatch!)}`}
            />
            {/* "other" is a CLAIM — that this part is not Dispatch's — and
                before the first process-table scan there is nothing behind it.
                Until then the same quantity is only "in use". */}
            <Leg
              layer="other"
              barTone={barTone}
              label={measuring ? "in use" : "other"}
              value={fmt(split.other)}
            />
            <Leg layer="free" barTone={barTone} label={freeWord} value={fmt(split.free)} />
          </>
        )}
      </div>
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
  const t = machineTone(memPct);
  // The dropdown's half. Null until the first scan lands — AND null again once
  // the store's copy has aged out, because the panel nests it inside a machine
  // total that is two seconds old and a stale part inside a live whole is wrong
  // about the whole. See `freshDispatch`. Either way the splits carry it
  // through as "measuring" rather than as zero.
  const dispatch = freshDispatch(snapshot);
  const mem = memorySplit(system, dispatch);
  const cpu = cpuSplit(system, dispatch);

  return (
    <div className="relative inline-flex" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <button
        ref={btnRef}
        onClick={openNow}
        aria-label={`System resources: CPU ${pct(system.cpuPct)}, memory ${Math.round(memPct)}%`}
        className={cn(
          "flex items-center gap-1.5 rounded-md border border-line bg-panel-2/60 px-2 py-1",
          "transition-colors hover:border-line-strong",
        )}
      >
        <Cpu className="size-3 shrink-0 text-faint" />
        <SplitBar size="xs" className="w-6" usedPct={system.cpuPct ?? 0} tone={CPU_BAR} />
        <span className="cm-mono text-xs font-semibold tabular-nums text-secondary">
          {pct(system.cpuPct)}
        </span>
        <span className="mx-0.5 h-3 w-px shrink-0 bg-line" />
        <MemoryStick className="size-3 shrink-0 text-faint" />
        <SplitBar size="xs" className="w-6" usedPct={memPct} tone={t.bar} />
        <span className={cn("cm-mono text-xs font-semibold tabular-nums", t.text)}>
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
              "fixed w-[304px] overflow-hidden rounded-md border border-line-strong",
              "bg-overlay/98 backdrop-blur-md shadow-[var(--shadow-pop)] cm-anim-rise",
            )}
          >
            <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
              <Server className="size-3.5 shrink-0 text-muted" />
              <span className="text-xs font-semibold tracking-tight text-primary">
                This machine
              </span>
              <div className="flex-1" />
              <span className="cm-mono text-2xs tabular-nums text-faint">
                {system.logicalCores} cores
                {dispatch && ` · ${dispatch.procs} procs`}
              </span>
            </div>

            <div className="divide-y divide-line-soft">
              <Meter
                label="Memory"
                headline={`${bytes(system.usedBytes)} / ${bytes(system.totalBytes)}`}
                split={mem}
                barTone={t.bar}
                fmt={bytes}
                // Marked because the tree sum counts shared pages once per
                // process; corrected by SHARED_PAGE_FACTOR, never exact.
                approx
                freeWord="free"
              />
              <Meter
                label="CPU"
                headline={pct(system.cpuPct)}
                split={cpu}
                barTone={CPU_BAR}
                // Machine-relative on both layers. The server reports process
                // CPU as a share of ONE core, and printing that raw beside a
                // whole-machine figure put two numbers 16x apart under the same
                // label. See `machinePct`.
                fmt={(n) => pct(n)}
                freeWord="idle"
              />
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
