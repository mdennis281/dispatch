/**
 * The connection checks as a rail of stages — network → server → live →
 * protocol — rather than a table of four rows.
 *
 * A table read as four independent facts, and they are not: each link only
 * means anything once the one before it holds. The rail says that by shape.
 * Nothing past the first non-green stage is coloured (`pipeline()` owns that
 * rule), the lines between stages light up as the chain is walked, and when a
 * stage regresses they drain back towards it — so a server dropping mid-retry
 * is something you SEE happen rather than a word that changed in a column.
 *
 * Colour carries the state; motion only narrates the change, and is the first
 * thing to go under `prefers-reduced-motion`.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Check as CheckIcon, X } from "lucide-react";
import { cn } from "../../lib/cn.js";
import {
  pipeline,
  type Check,
  type Pipeline,
  type StageTone,
} from "../../lib/connectionDiagnosis.js";

/** One segment drawing in. Chained, so a walk of three links takes three of these. */
const DRAW_MS = 380;
/** One segment draining. Faster than drawing — bad news shouldn't dawdle. */
const DRAIN_MS = 220;

const TONE_VAR: Record<StageTone, string> = {
  ok: "var(--p-success)",
  active: "var(--p-info)",
  fail: "var(--p-danger)",
  idle: "var(--p-line-strong)",
};

/* Spelled out per tone: Tailwind only compiles class names it finds literally. */
const CAPTION_CLASS: Record<StageTone, string> = {
  ok: "border-success-line bg-success-ghost text-success-hi",
  active: "border-info-line bg-info-ghost text-info-hi",
  fail: "border-danger-line bg-danger-ghost text-danger-hi",
  idle: "border-line bg-inset text-muted",
};

const LABEL_CLASS: Record<StageTone, string> = {
  ok: "text-secondary",
  active: "text-primary",
  fail: "text-primary",
  idle: "text-faint",
};

interface Timing {
  /** Per segment, ms before its fill starts moving. */
  seg: number[];
  /** Per stage, ms before its dot takes its new colour. */
  dot: number[];
  /** When the whole sequence has played out; after that nothing is delayed. */
  until: number;
}

const still = (n: number): Timing => ({ seg: Array(n - 1).fill(0), dot: Array(n).fill(0), until: 0 });

/**
 * Stagger the change so it travels along the rail instead of happening
 * everywhere at once: forward, each line draws after the one before it lands
 * and each dot lights as its line arrives; backward, the rightmost line drains
 * first and each dot greys as the line leaves it.
 */
function plan(n: number, from: number, to: number): Timing {
  const t = still(n);
  if (to > from) {
    for (let i = from; i < to; i++) t.seg[i] = (i - from) * DRAW_MS;
    for (let j = from + 1; j <= to; j++) t.dot[j] = (j - from) * DRAW_MS - 80;
    t.until = Date.now() + (to - from) * DRAW_MS + 400;
  } else if (to < from) {
    for (let i = to; i < from; i++) t.seg[i] = (from - 1 - i) * DRAIN_MS;
    for (let j = to + 1; j <= from; j++) t.dot[j] = (from - j) * DRAIN_MS;
    // The stage the rail fell back to changes colour once the line reaches it.
    t.dot[to] = (from - to) * DRAIN_MS;
    t.until = Date.now() + (from - to) * DRAIN_MS + 400;
  }
  return t;
}

/**
 * The delays for the change that just happened. Recomputed only when `reach`
 * moves — the screen re-renders twice a second for its retry countdown, and
 * re-planning on every tick would zero the delays of a sequence mid-flight.
 */
function useTiming(n: number, reach: number): Timing {
  const ref = useRef<{ reach: number; timing: Timing }>({ reach: 0, timing: still(n) });
  if (ref.current.reach !== reach) {
    ref.current = { reach, timing: plan(n, ref.current.reach, reach) };
  }
  const { timing } = ref.current;
  return Date.now() < timing.until ? timing : still(n);
}

/**
 * Start dark and walk to the real state a frame later. CSS transitions don't
 * run on first paint, so without this the rail would simply appear — and the
 * first look at it is exactly when the walk explains what it's showing.
 */
function useEntered(): boolean {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return entered;
}

function dark(p: Pipeline): Pipeline {
  return {
    stages: p.stages.map((s) => ({ ...s, tone: "idle" as const, bypassed: false })),
    active: 0,
    reach: 0,
  };
}

const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function Dot({ tone, bypassed, delay }: { tone: StageTone; bypassed: boolean; delay: number }) {
  const shell = useRef<HTMLSpanElement>(null);
  const burst = useRef<HTMLSpanElement>(null);
  const prev = useRef(tone);

  // A one-shot accent on arrival, timed to land with the colour. Web Animations
  // rather than a keyed remount: remounting the shell would throw away the
  // colour transition it is in the middle of.
  useLayoutEffect(() => {
    if (prev.current === tone) return;
    prev.current = tone;
    if (reducedMotion() || !shell.current) return;
    if (tone === "ok") {
      shell.current.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.3)" }, { transform: "scale(1)" }],
        { duration: 420, delay, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
      );
    } else if (tone === "fail") {
      shell.current.animate(
        [0, -3, 3, -2, 2, 0].map((x) => ({ transform: `translateX(${x}px)` })),
        { duration: 380, delay, easing: "ease-out" },
      );
    }
    if ((tone === "ok" || tone === "fail") && burst.current) {
      burst.current.animate(
        [
          { transform: "scale(1)", opacity: 0.55 },
          { transform: "scale(2.6)", opacity: 0 },
        ],
        { duration: 650, delay, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "backwards" },
      );
    }
  }, [tone, delay]);

  const color = TONE_VAR[tone];
  const filled = tone === "ok" || tone === "fail";
  return (
    <span className="relative flex size-[18px] items-center justify-center">
      <span
        ref={burst}
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full opacity-0"
        style={{ background: color }}
      />
      {tone === "active" && (
        <>
          <span aria-hidden className="cm-pipe-ping" style={{ borderColor: color }} />
          <span aria-hidden className="cm-pipe-ping [animation-delay:0.8s]" style={{ borderColor: color }} />
        </>
      )}
      <span
        ref={shell}
        className={cn(
          "cm-pipe-dot relative flex size-full items-center justify-center rounded-full border-2",
          bypassed && "border-dashed",
        )}
        style={
          {
            borderColor: color,
            background: filled ? color : tone === "active"
                ? "color-mix(in srgb, var(--p-info) 16%, var(--p-app))"
                : "var(--p-app)",
            boxShadow: filled ? `0 0 0 4px color-mix(in srgb, ${color} 18%, transparent)` : "none",
            transitionDelay: `${delay}ms`,
          } as CSSProperties
        }
      >
        {/* Keyed so each new glyph pops in; the shell around it stays put. */}
        <span
          key={tone}
          className="cm-pipe-glyph flex text-app [&_svg]:size-[11px] [&_svg]:stroke-[3.5]"
          style={{ animationDelay: `${delay}ms` }}
        >
          {tone === "ok" && <CheckIcon />}
          {tone === "fail" && <X />}
          {tone === "active" && <span className="cm-anim-pulse size-1.5 rounded-full bg-info" />}
        </span>
      </span>
    </span>
  );
}

export function ConnectionPipeline({ checks }: { checks: Check[] }) {
  const entered = useEntered();
  const real = pipeline(checks);
  const shown = entered ? real : dark(real);
  const { stages, active, reach } = shown;
  const n = stages.length;
  const timing = useTiming(n, reach);

  const current = stages[active]!;
  const col = 100 / n;
  // Pinned to the active dot, but slid inwards at the ends so the caption never
  // hangs off the rail: at stage 0 its left edge sits on the rail's left edge,
  // at the last stage its right edge sits on the right, and between the two it
  // tracks proportionally — a translate of the same percentage it's placed at.
  const along = n > 1 ? (active / (n - 1)) * 100 : 50;
  const arrive: CSSProperties = { transitionDelay: `${timing.dot[active] ?? 0}ms` };

  return (
    <div className="w-full max-w-[380px] select-none">
      <div className="relative h-9" aria-live="polite">
        <div
          className={cn(
            "cm-pipe-caption absolute top-0 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium",
            CAPTION_CLASS[current.tone],
            !entered && "opacity-0",
          )}
          style={{ ...arrive, left: `${along}%`, transform: `translateX(-${along}%)` }}
        >
          <span key={`${current.id}:${current.value}`} className="cm-anim-rise inline-block">
            {current.value}
          </span>
        </div>
        <span
          aria-hidden
          className="cm-pipe-caption absolute bottom-1 size-0 border-x-[5px] border-t-[5px] border-x-transparent"
          style={{
            ...arrive,
            left: `${col * (active + 0.5)}%`,
            transform: "translateX(-50%)",
            borderTopColor: TONE_VAR[current.tone],
            opacity: entered ? 0.7 : 0,
          }}
        />
      </div>

      <div className="relative">
        <div
          aria-hidden
          className="absolute top-[9px] flex -translate-y-1/2"
          style={{ left: `${col / 2}%`, right: `${col / 2}%` }}
        >
          {stages.slice(0, -1).map((from, i) => {
            const to = stages[i + 1]!;
            const lit = i < reach;
            return (
              <span key={from.id} className="relative h-[3px] flex-1 overflow-hidden bg-line">
                <span
                  className="cm-pipe-fill absolute inset-0"
                  data-flow={lit && to.tone === "active" ? "" : undefined}
                  style={
                    {
                      transform: lit ? "scaleX(1)" : "scaleX(0)",
                      transitionDelay: `${timing.seg[i] ?? 0}ms`,
                      transitionDuration: lit ? `${DRAW_MS}ms` : `${DRAIN_MS}ms`,
                      "--cm-seg-from": from.bypassed ? TONE_VAR.idle : TONE_VAR.ok,
                      "--cm-seg-to": TONE_VAR[to.tone === "idle" ? "ok" : to.tone],
                    } as CSSProperties
                  }
                />
              </span>
            );
          })}
        </div>

        <ol className="relative grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
          {stages.map((stage, i) => (
            <li
              key={stage.id}
              aria-label={`${stage.label}: ${stage.value}`}
              aria-current={i === active ? "step" : undefined}
              className="flex flex-col items-center gap-2"
            >
              <Dot tone={stage.tone} bypassed={stage.bypassed} delay={timing.dot[i] ?? 0} />
              <span
                className={cn("cm-pipe-label text-xs", LABEL_CLASS[stage.tone], i === active && "font-medium")}
                style={{ transitionDelay: `${timing.dot[i] ?? 0}ms` }}
              >
                {stage.label}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
