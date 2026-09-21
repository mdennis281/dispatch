/**
 * TraceViewer — an interaction trace as a timeline, at `/?trace`.
 *
 * `main.tsx` mounts this INSTEAD of the app when the URL carries `?trace`, the
 * same way `?logs=` mounts the log window: same bundle, one job. The
 * recordings come from the phone — `lib/interactionTrace.ts`, run by the
 * viewport readout — either saved to the server ("send") and picked from the
 * list here, or copied to the clipboard and pasted into the box.
 *
 * What it draws. Time runs left to right. The transcript's `scrollTop` is the
 * main line (down the page is down the chart, so a jolt that throws the
 * reader back toward the bottom is a visible step DOWN); the finger's `y` is
 * the fuchsia line, with the span of each touch shaded. Everything that can
 * cause a step is a tick above: a programmatic `set` (red — our code did it,
 * and the label says who), a row growing (`size`, orange — WebKit will shove
 * the transcript by exactly that when the row is above the reader), an image
 * decoding (blue, and `ABOVE` when it decoded above the viewport), a
 * keyboard/viewport change (green). A scroll step with no tick over it is the
 * browser's own doing. Click a table row and a cursor marks its moment.
 *
 * Deliberately plain SVG: this is an instrument, and a 20KB chart library for
 * a debug page every user downloads is the wrong trade.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api.js";
import { useAuth } from "../../stores/auth.js";
import { Button } from "../ui/Button.js";
import { formatEntry, type TraceEntry, type TraceKind, type TraceSnapshot } from "../../lib/interactionTrace.js";

type Saved = TraceSnapshot & { sha?: string | null; savedAt?: string };

const KINDS: TraceKind[] = ["touch", "pcancel", "scroll", "set", "size", "img", "focus", "blur", "vv", "shift", "note"];

const W = 1200;
const H = 360;
const PAD = { l: 48, r: 48, t: 56, b: 24 };

export function TraceViewer() {
  const [files, setFiles] = useState<Array<{ name: string; size: number; savedAt: string }>>([]);
  const [selected, setSelected] = useState<string>(
    () => new URLSearchParams(location.search).get("trace") ?? "",
  );
  const [trace, setTrace] = useState<Saved | null>(null);
  const [error, setError] = useState("");
  const [pasted, setPasted] = useState("");
  const [shown, setShown] = useState<Set<TraceKind>>(
    () => new Set(KINDS.filter((k) => k !== "touch")),
  );
  const [cursor, setCursor] = useState<number | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);

  // `main.tsx` runs `initializeAuth` for this page too, but this mounts before
  // it resolves; listing before the session token exists is a 401 on an
  // auth-enabled install. Wait for the store to say it has looked.
  const authReady = useAuth((s) => s.ready);
  useEffect(() => {
    if (!authReady) return;
    api.debugTrace
      .list()
      .then((list) => {
        setFiles(list);
        if (!selected && list[0]) setSelected(list[0].name);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    // Once auth is ready — `selected` is seeded from the URL and then user-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady]);

  useEffect(() => {
    if (!selected || !authReady) return;
    setError("");
    api.debugTrace
      .get(selected)
      .then((t) => {
        setTrace(t as Saved);
        setRange(null);
        setCursor(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [selected, authReady]);

  const loadPasted = () => {
    try {
      const t = JSON.parse(pasted) as Saved;
      if (!Array.isArray(t.entries)) throw new Error("no entries[]");
      setTrace(t);
      setSelected("");
      setRange(null);
      setCursor(null);
      setError("");
    } catch (e) {
      setError(`paste: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const entries = trace?.entries ?? [];
  const tMax = entries.length ? entries[entries.length - 1]!.t : 1;
  const [from, to] = range ?? [0, tMax];
  const visible = useMemo(
    () => entries.filter((e) => e.t >= from && e.t <= to && shown.has(e.k)),
    [entries, from, to, shown],
  );

  return (
    <div className="flex h-dvh flex-col bg-app text-primary">
      <header className="flex items-center gap-3 border-b border-line px-3 py-2 text-sm">
        <span className="font-medium">Interaction trace</span>
        <select
          className="rounded border border-line bg-panel px-2 py-1 text-xs"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">— pasted —</option>
          {files.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name.replace(".json", "")} · {(f.size / 1024).toFixed(0)}KB
            </option>
          ))}
        </select>
        {trace && (
          <span className="truncate text-xs text-secondary">
            {trace.meta.standalone ? "standalone" : "browser"} · {trace.meta.screen.w}×{trace.meta.screen.h} · inner{" "}
            {trace.meta.inner.w}×{trace.meta.inner.h} · {entries.length} entries · {(tMax / 1000).toFixed(1)}s
            {trace.sha ? ` · ${trace.sha.slice(0, 8)}` : ""}
            {trace.meta.scroller ? ` · watching ${trace.meta.scroller}` : ""}
          </span>
        )}
        {error && <span className="text-xs text-danger">{error}</span>}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col gap-2 border-r border-line p-2 text-xs">
          <div className="text-faint">Show</div>
          {KINDS.map((k) => (
            <label key={k} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={shown.has(k)}
                onChange={(e) => {
                  const next = new Set(shown);
                  if (e.target.checked) next.add(k);
                  else next.delete(k);
                  setShown(next);
                }}
              />
              <span className="inline-block size-2 rounded-sm" style={{ background: colour(k) }} />
              {k}
            </label>
          ))}
          <div className="mt-2 text-faint">Window (s)</div>
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.1"
              className="w-20 rounded border border-line bg-panel px-1 py-0.5"
              value={(from / 1000).toFixed(1)}
              onChange={(e) => setRange([Number(e.target.value) * 1000, to])}
            />
            <span>→</span>
            <input
              type="number"
              step="0.1"
              className="w-20 rounded border border-line bg-panel px-1 py-0.5"
              value={(to / 1000).toFixed(1)}
              onChange={(e) => setRange([from, Number(e.target.value) * 1000])}
            />
            <Button onClick={() => setRange(null)}>all</Button>
          </div>
          <div className="mt-2 text-faint">Paste a copied trace</div>
          <textarea
            className="h-24 w-full rounded border border-line bg-panel p-1 font-mono text-2xs"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder='{"meta":…,"entries":[…]}'
          />
          <Button onClick={loadPasted}>load</Button>
          <div className="mt-2 text-faint">Reading it</div>
          <ul className="space-y-1 text-secondary">
            <li>A step in the white line with nothing above it: the browser moved the reader on its own.</li>
            <li>An orange tick before the step, with a row above the viewport: WebKit's missing scroll anchoring.</li>
            <li>A red tick: our code set the scroll — the label says which frame.</li>
            <li>Blue ABOVE: an image decoded above the reader.</li>
          </ul>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {trace ? (
            <>
              <Timeline
                entries={entries}
                from={from}
                to={to}
                shown={shown}
                cursor={cursor}
                innerH={trace.meta.inner.h}
                scroller={trace.meta.scroller}
                onPick={(t) => setCursor(t)}
                onZoom={(a, b) => setRange([a, b])}
              />
              <div className="min-h-0 flex-1 overflow-auto border-t border-line font-mono text-2xs">
                {visible.map((e, i) => (
                  <div
                    key={`${e.t}-${i}`}
                    onClick={() => setCursor(e.t)}
                    className={`cursor-pointer whitespace-pre px-2 py-px hover:bg-panel ${cursor === e.t ? "bg-panel-2" : ""}`}
                    style={{ color: colour(e.k) }}
                  >
                    {formatEntry(e)}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="p-6 text-sm text-secondary">
              {files.length || error
                ? "Pick a trace, or paste one."
                : "No traces yet. On the phone: More → Viewport readout → send."}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function colour(k: TraceKind): string {
  switch (k) {
    case "touch":
      return "#e879f9";
    case "pcancel":
      return "#f0abfc";
    case "scroll":
      return "#e5e7eb";
    case "set":
      return "#f87171";
    case "size":
      return "#fb923c";
    case "img":
      return "#60a5fa";
    case "vv":
      return "#4ade80";
    case "focus":
    case "blur":
      return "#a3e635";
    case "shift":
      return "#facc15";
    default:
      return "#9ca3af";
  }
}

interface TimelineProps {
  entries: TraceEntry[];
  from: number;
  to: number;
  shown: Set<TraceKind>;
  cursor: number | null;
  innerH: number;
  scroller?: string;
  onPick: (t: number) => void;
  onZoom: (from: number, to: number) => void;
}

function Timeline({ entries, from, to, shown, cursor, innerH, scroller, onPick, onZoom }: TimelineProps) {
  const span = Math.max(to - from, 1);
  const x = (t: number) => PAD.l + ((t - from) / span) * (W - PAD.l - PAD.r);
  const plotH = H - PAD.t - PAD.b;

  // The scroller whose line to draw: the one the recorder watched, else the
  // element with the most scroll events.
  const scrolls = useMemo(() => {
    const byEl = new Map<string, TraceEntry[]>();
    for (const e of entries) {
      if (e.k !== "scroll" || !e.el) continue;
      const list = byEl.get(e.el) ?? [];
      list.push(e);
      byEl.set(e.el, list);
    }
    const chosen: TraceEntry[] =
      (scroller ? byEl.get(scroller) : undefined) ??
      [...byEl.values()].sort((a, b) => b.length - a.length)[0] ??
      [];
    return chosen;
  }, [entries, scroller]);

  const inWindow = scrolls.filter((e) => e.t >= from && e.t <= to);
  const tops = inWindow.map((e) => e.top as number);
  const minTop = tops.length ? Math.min(...tops) : 0;
  const maxTop = tops.length ? Math.max(...tops) : 1;
  const yScroll = (top: number) => PAD.t + ((top - minTop) / Math.max(maxTop - minTop, 1)) * plotH;
  const yFinger = (py: number) => PAD.t + (py / Math.max(innerH, 1)) * plotH;

  const touches = entries.filter((e) => e.k === "touch" && e.t >= from && e.t <= to);
  // Touch spans: start → end/cancel.
  const spans: Array<[number, number, string]> = [];
  let open: number | null = null;
  for (const e of entries) {
    if (e.k !== "touch") continue;
    if (e.p === "start") open = e.t;
    else if ((e.p === "end" || e.p === "cancel") && open !== null) {
      spans.push([open, e.t, e.p as string]);
      open = null;
    }
  }
  if (open !== null) spans.push([open, to, "open"]);

  const ticks = entries.filter(
    (e) => e.t >= from && e.t <= to && shown.has(e.k) && !["touch", "scroll"].includes(e.k),
  );

  // Drag on the chart to zoom.
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const tAt = (clientX: number, svg: SVGSVGElement) => {
    const r = svg.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    return from + ((px - PAD.l) / (W - PAD.l - PAD.r)) * span;
  };

  const pathScroll = inWindow
    .map((e, i) => `${i ? "L" : "M"}${x(e.t).toFixed(1)},${yScroll(e.top as number).toFixed(1)}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full shrink-0 select-none bg-surface"
      style={{ height: H * 0.75 }}
      onMouseDown={(e) => setDrag([tAt(e.clientX, e.currentTarget), tAt(e.clientX, e.currentTarget)])}
      onMouseMove={(e) => drag && setDrag([drag[0], tAt(e.clientX, e.currentTarget)])}
      onMouseUp={(e) => {
        if (!drag) return;
        const [a, b] = [Math.min(drag[0], drag[1]), Math.max(drag[0], drag[1])];
        if (b - a > 20) onZoom(Math.max(0, a), b);
        else onPick(tAt(e.clientX, e.currentTarget));
        setDrag(null);
      }}
      onMouseLeave={() => setDrag(null)}
    >
      {/* touch spans — always drawn; the `touch` filter is for the table,
          where 60Hz of moves would bury everything else */}
      {spans
          .filter(([a, b]) => b >= from && a <= to)
          .map(([a, b, p], i) => (
            <rect
              key={i}
              x={x(Math.max(a, from))}
              y={PAD.t}
              width={Math.max(x(Math.min(b, to)) - x(Math.max(a, from)), 1)}
              height={plotH}
              fill={p === "cancel" ? "#fbbf24" : "#e879f9"}
              opacity={0.08}
            />
          ))}

      {/* axes */}
      <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t} y2={PAD.t} stroke="#374151" />
      <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="#374151" />
      <text x={4} y={PAD.t + 10} fill="#9ca3af" fontSize={10}>
        top {minTop}
      </text>
      <text x={4} y={H - PAD.b} fill="#9ca3af" fontSize={10}>
        top {maxTop}
      </text>
      <text x={W - PAD.r + 4} y={PAD.t + 10} fill="#e879f9" fontSize={10}>
        y 0
      </text>
      <text x={W - PAD.r + 4} y={H - PAD.b} fill="#e879f9" fontSize={10}>
        y {innerH}
      </text>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <text key={f} x={x(from + span * f)} y={H - 6} fill="#6b7280" fontSize={10} textAnchor="middle">
          {((from + span * f) / 1000).toFixed(2)}s
        </text>
      ))}

      {/* scrollTop line, with the reason for each sample coloured */}
      {shown.has("scroll") && (
        <>
          <path d={pathScroll} fill="none" stroke="#e5e7eb" strokeWidth={1.5} />
          {inWindow.map((e, i) =>
            e.prog || Math.abs((e.dy as number) ?? 0) > 60 ? (
              <circle
                key={i}
                cx={x(e.t)}
                cy={yScroll(e.top as number)}
                r={e.prog ? 3.5 : 2.5}
                fill={e.prog ? "#f87171" : "#facc15"}
              >
                <title>{formatEntry(e)}</title>
              </circle>
            ) : null,
          )}
        </>
      )}

      {/* finger */}
      {touches.map((e, i) => (
          <circle
            key={i}
            cx={x(e.t)}
            cy={yFinger(e.y as number)}
            r={e.p === "move" ? 1.5 : 3}
            fill={e.p === "cancel" ? "#fbbf24" : e.p === "end" ? "#f87171" : "#e879f9"}
          >
            <title>{formatEntry(e)}</title>
          </circle>
        ))}

      {/* event ticks, staggered so neighbours don't overprint */}
      {ticks.map((e, i) => {
        const hot = e.k === "set" || e.k === "size" || (e.k === "img" && e.above);
        const row = i % 4;
        return (
          <g key={i} onClick={() => onPick(e.t)} className="cursor-pointer">
            <line x1={x(e.t)} x2={x(e.t)} y1={PAD.t - 4} y2={H - PAD.b} stroke={colour(e.k)} strokeWidth={hot ? 1.5 : 1} opacity={hot ? 0.9 : 0.35} strokeDasharray={hot ? undefined : "2 3"} />
            <text x={x(e.t) + 2} y={12 + row * 11} fill={colour(e.k)} fontSize={9}>
              {tickLabel(e)}
            </text>
            <title>{formatEntry(e)}</title>
          </g>
        );
      })}

      {cursor !== null && cursor >= from && cursor <= to && (
        <line x1={x(cursor)} x2={x(cursor)} y1={0} y2={H} stroke="#fff" strokeWidth={1} opacity={0.7} />
      )}
      {drag && (
        <rect
          x={x(Math.min(drag[0], drag[1]))}
          y={0}
          width={Math.abs(x(drag[1]) - x(drag[0]))}
          height={H}
          fill="#fff"
          opacity={0.1}
        />
      )}
    </svg>
  );
}

function tickLabel(e: TraceEntry): string {
  switch (e.k) {
    case "set":
      return `${e.how} ${e.v}`;
    case "size":
      return `${(e.dh as number) > 0 ? "+" : ""}${e.dh} ${e.el}`;
    case "img":
      return `img${e.above ? " ABOVE" : ""} ${e.rh}`;
    case "vv":
      return `kb ${e.kb}`;
    case "note":
      return String(e.text);
    default:
      return e.k;
  }
}
