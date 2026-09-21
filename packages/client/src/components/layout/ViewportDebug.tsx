import { useEffect } from "react";
import { useViewport } from "../../stores/viewport.js";
import { LAYER } from "../../lib/layers.js";
import { api } from "../../lib/api.js";
import { Button } from "../ui/Button.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import {
  clearTrace,
  formatEntry,
  setTraceStatus,
  snapshot,
  startInteractionTrace,
  useTrace,
} from "../../lib/interactionTrace.js";

/**
 * Every viewport number the browser will admit to, on screen, live.
 *
 * This exists because an iPhone cannot be inspected remotely from Windows, and
 * the bugs it is for only happen in the installed standalone PWA — the one
 * context with no console, no inspector and no URL bar to add a query flag to.
 * Two attempts at fixing the bottom of the mobile shell were built on inferred
 * numbers and both missed, so this reads them out instead.
 *
 * Toggled from the More sheet, off by default, never persisted.
 *
 * What to look for:
 *  - `inner` dropping below `max` and staying there is the WebKit standalone
 *    bug: the viewport shrinks on first keyboard open and never recovers.
 *  - `dvh` ≠ `inner` means `100dvh` — which sizes the whole shell — disagrees
 *    with the window, so no amount of correct layout maths can help.
 *  - `off` non-zero with the keyboard DOWN is the iOS 26 offsetTop regression,
 *    and it skews `kb` directly.
 *  - `kb` staying 0 while the keyboard is visibly up means the shell is never
 *    being told to shrink at all.
 *  - `over` MUST be 0. Non-zero means the shell is asking for more room than
 *    the layout viewport has, and everything past that edge is never painted —
 *    which looks like the bottom of the app being cut off. This is the one that
 *    matters; it is what four PRs shipped against a `dead` of 0 while missing.
 *  - `dead` is how much of the screen the shell does NOT cover. In a browser
 *    tab it is the URL bar. In the installed iOS app it is the status bar —
 *    ~59 on a Face ID phone — and that is CORRECT: without `viewport-fit=cover`
 *    the window starts below the status bar, and `fixed-top` at the top of
 *    the ruler should sit just under the clock. `safe-t` must be 0 there and
 *    `safe-b` should be 34 (the home-indicator fallback), not `env()`'s 0.
 *  - `safe-t` non-zero means the status bar is ours to pad around. It describes
 *    the SCREEN, not the layout viewport, so `safe-b` can be reserving space
 *    for a home indicator that is below the viewport entirely — compare
 *    `screen` with `client` to tell. See docs/ios-pwa-viewport-findings.md.
 */
export function ViewportDebug() {
  // Subscribes to `debug` ALONE. The tracker writes the store every frame for
  // 600ms after each focus change, and this component is mounted for everyone —
  // subscribing to the whole store would re-render the app's last child on
  // every one of those frames to render null.
  const debug = useViewport((s) => s.debug);
  return debug ? (
    <>
      <ViewportReadout />
      <PaintRuler />
      <InteractionTrace />
    </>
  ) : null;
}

/**
 * The flight recorder, and the two ways to get a recording off the phone.
 *
 * The readout above is a snapshot; a scroll glitch is a sequence. While this
 * is mounted — i.e. while the readout is on — `lib/interactionTrace` logs
 * every touch, scroll, programmatic scroll, content resize, image load and
 * viewport change with a timestamp. The tail is drawn here so the person
 * holding the phone can see it is recording and what it last saw; the whole
 * buffer goes out via `copy` (clipboard, to paste into a chat) or `send`
 * (POST to the server, where `?trace` on a desktop renders it as a timeline
 * and an agent can read the file). The finger trail is the other half of the
 * picture: a screenshot with the trail on it shows WHERE the gesture was when
 * the log says the transcript moved.
 */
function InteractionTrace() {
  useEffect(() => startInteractionTrace(), []);
  const count = useTrace((s) => s.count);
  const tail = useTrace((s) => s.tail);
  const trail = useTrace((s) => s.trail);
  const status = useTrace((s) => s.status);

  const copy = async () => {
    const ok = await copyToClipboard(JSON.stringify(snapshot()));
    setTraceStatus(ok ? "copied" : "copy failed");
  };
  const send = async () => {
    try {
      const { name } = await api.debugTrace.save(snapshot());
      setTraceStatus(`sent ${name.slice(11, 19).replace(/-/g, ":")}`);
    } catch (err) {
      setTraceStatus(`send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <>
      {/* Finger trail. Newest point is brightest; a start is a ring, an end a
          filled dot, a cancel amber — so a gesture iOS abandoned mid-way reads
          differently from one that finished. */}
      <div
        style={{ zIndex: LAYER.shutdown + 1 }}
        className="pointer-events-none fixed inset-0"
        aria-hidden
      >
        {trail.map((pt, i) => {
          const age = 1 - i / Math.max(trail.length, 1);
          const ring = pt.p === "start";
          const colour = pt.p === "cancel" ? "border-amber-300 bg-amber-300" : pt.p === "end" ? "border-red-400 bg-red-400" : "border-fuchsia-400 bg-fuchsia-400";
          return (
            <span
              key={`${pt.t}-${i}`}
              className={`absolute size-2.5 rounded-full border ${colour} ${ring ? "!bg-transparent" : ""}`}
              style={{ left: pt.x - 5, top: pt.y - 5, opacity: 0.25 + 0.75 * (1 - age) }}
            />
          );
        })}
      </div>
      <div
        style={{ zIndex: LAYER.shutdown + 1 }}
        // Bottom-left, above the nav; the readout has the top-left. `fixed` to
        // the layout viewport like the readout, and the log itself lets touches
        // through so the transcript under it stays scrollable — only the
        // button row takes taps.
        className="pointer-events-none fixed inset-x-1 bottom-[calc(var(--cm-safe-bottom,0px)+3.5rem+var(--cm-kb,0px))] max-w-[min(100vw-0.5rem,520px)] rounded border border-line-strong bg-black/80 px-1.5 py-1 font-mono text-2xs leading-tight text-white backdrop-blur-sm"
      >
        <div className="flex items-center gap-1.5">
          <span className="text-white/45">trace</span>
          <span className="text-white/90">{count}</span>
          {status && <span className="truncate text-amber-300">{status}</span>}
          <span className="flex-1" />
          <TraceButton onClick={() => void copy()}>copy</TraceButton>
          <TraceButton onClick={() => void send()}>send</TraceButton>
          <TraceButton onClick={clearTrace}>clear</TraceButton>
        </div>
        <div className="mt-0.5 space-y-px">
          {tail.map((e, i) => (
            <div
              key={`${e.t}-${i}`}
              className={`truncate ${e.k === "set" || e.k === "size" || (e.k === "img" && e.above) ? "text-amber-300" : "text-white/80"}`}
            >
              {formatEntry(e)}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function TraceButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      // Inverted on purpose: the panel is black glass over whatever theme is
      // on, and the ghost variant's theme text would vanish against it.
      className="pointer-events-auto !h-5 border border-white/30 !px-1.5 font-mono !text-2xs !text-white/90"
    >
      {children}
    </Button>
  );
}

/**
 * Where does painting actually STOP?
 *
 * Every number the page can read is a LAYOUT number, and layout happily hands a
 * fixed box the 932px it asked for on a device whose layout viewport is 873 —
 * `getBoundingClientRect()` will report a bottom edge of 932 either way. So no
 * amount of measurement distinguishes "the shell reaches the glass" from "the
 * shell overshoots and the last 59px are never painted". The only instrument
 * that can tell them apart is paint itself.
 *
 * So: draw labelled hairlines at known absolute offsets straddling the layout
 * viewport's bottom edge, and look at a screenshot. The lowest line you can see
 * IS the paintable edge, in the units to fix it with — which settles whether
 * the bar has to be clamped to `clientHeight` or the shell is right and the
 * clipping is somewhere else entirely.
 *
 * `fixed` to the layout viewport, like the readout, so it does not move with
 * the thing it is measuring. Diagnostic only — it renders solely while the
 * readout is toggled on, which is never by default and never persisted.
 */
function PaintRuler() {
  const client = useViewport((s) => s.clientHeight);
  const screen = useViewport((s) => s.screenHeight);
  const safeTop = useViewport((s) => s.safeTop);
  if (!client || !screen) return null;

  // Straddle the edge: a couple above (which MUST be visible, proving the ruler
  // itself paints) and the rest marching past it to the bottom of the glass.
  const marks = [client - 40, client - 20, client, client + 20, client + 40, screen - 2]
    // A device where the two agree would otherwise draw the same line 3 times.
    .filter((y, i, all) => y > 0 && y < screen && all.indexOf(y) === i);

  // The SAME question at the other end, which the bottom ruler cannot answer:
  // where does `top: 0` of a fixed box actually land on the glass?
  //
  // A modal is `fixed inset-0` and pads itself by the top inset, which should
  // put its first row of controls at `safeTop`. It didn't — the buttons stayed
  // under the clock through a shipped fix — and layout numbers cannot tell
  // "the padding never applied" apart from "the box starts higher up the screen
  // than 0". Two marks settle it by eye against the status bar: `0` and the
  // inset. If `0` is visible ABOVE the clock, the fixed origin is the glass and
  // the padding is the suspect; if `0` is level with the clock and `safe`
  // is below it, the geometry is right and something ate the padding.
  const top = [0, safeTop].filter((y, i, all) => y >= 0 && all.indexOf(y) === i);

  return (
    <div
      style={{ zIndex: LAYER.shutdown + 1 }}
      className="pointer-events-none fixed inset-x-0 top-0"
      aria-hidden
    >
      {marks.map((y) => (
        <div key={y} className="absolute inset-x-0 flex items-center" style={{ top: `${y}px` }}>
          <div className="h-px flex-1 bg-fuchsia-500" />
          <span className="bg-black/80 px-1 font-mono text-2xs leading-none text-fuchsia-300">
            {y}
            {y === client ? " client" : ""}
          </span>
        </div>
      ))}
      {/* Right-aligned and cyan so they can't be confused with the bottom ruler
          in a screenshot, and clear of the readout box on the left. */}
      {top.map((y) => (
        <div key={`t${y}`} className="absolute inset-x-0 flex items-center" style={{ top: `${y}px` }}>
          <div className="h-px flex-1 bg-cyan-400" />
          <span className="bg-black/80 px-1 font-mono text-2xs leading-none text-cyan-300">
            {y === 0 ? "0 fixed-top" : `${y} safe`}
          </span>
        </div>
      ))}
    </div>
  );
}

function viewportFit(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const match = meta?.content.match(/viewport-fit\s*=\s*(\w+)/);
  return match?.[1] ?? "auto";
}

function ViewportReadout() {
  const m = useViewport();

  const shrunk = m.maxInnerHeight - m.innerHeight;
  // How much of the screen nothing is drawn on. The shell starts at the top of
  // the screen — the status bar is padding INSIDE it, not an offset above it —
  // so the status bar must not be subtracted here as well.
  //
  // MEASURED, from the shell's own rect. It used to be `screenHeight - shell`,
  // and `shell` is the expression that SETS the height: the check could only
  // ever report that the formula had run, so it read 0 both for a shell that
  // reaches the glass and for one that overshoots it by 59px. Four PRs shipped
  // against that 0. Falls back to the arithmetic only before the first frame,
  // when there is no element to read.
  //
  // On iOS this is EXPECTED to be ~59 now, and that is not a bug to fix: the
  // shell follows the layout viewport, and the band below it is not paintable
  // by anything. `over` is the number that means something.
  const dead = m.screenHeight - (m.shellBottom || m.shell);
  // The overshoot the old `dead` was blind to: layout gave the box its full
  // height, but everything past the layout viewport is off the paintable area,
  // so the bar's bottom is cut rather than merely low. This must be 0.
  const over = (m.shellBottom || m.shell) - m.clientHeight;
  const rows: Array<[string, string, boolean]> = [
    // `m.shell`, not `m.dvh`: the store already resolves the fallback
    // (`dvh || innerHeight`), and that is the same number `over` is computed
    // from. Reading the raw probe here would report `shell 0` on any frame the
    // probe hasn't measured yet, against an `over` derived from the fallback —
    // a readout disagreeing with itself, which is the failure mode this whole
    // overlay exists to end.
    ["shell", `${m.shell} (dvh)`, false],
    ["dead", `${dead}`, false],
    // Non-zero means the shell is asking for more room than the layout viewport
    // has. That is the bottom nav being CLIPPED, not sitting short.
    ["over", `${over}`, over > 2],
    ["kb", `${m.inset}`, m.inset > 0],
    ["inner", `${m.innerHeight}${shrunk > 2 ? ` (-${shrunk} of ${m.maxInnerHeight})` : ""}`, shrunk > 2],
    ["vv", `${m.vvHeight}`, false],
    ["off", `${m.vvOffsetTop}`, m.vvOffsetTop !== 0],
    ["dvh", `${m.dvh}`, Math.abs(m.dvh - m.innerHeight) > 2],
    ["client", `${m.clientHeight}`, false],
    // `safe-t` non-zero alongside a short `inner` IS the status-bar double
    // charge — the two numbers only mean something next to each other.
    ["safe-t", `${m.safeTop}`, false],
    ["safe-b", `${m.safeBottom}`, false],
    ["screen", `${m.screenHeight}`, false],
    ["scale", m.vvScale.toFixed(2), Math.abs(m.vvScale - 1) > 0.01],
    // Read off the meta itself so a build that somehow ships `cover` again is
    // visible on the device that cares.
    ["fit", viewportFit(), viewportFit() !== "auto"],
  ];

  return (
    <div
      // `fixed` to the LAYOUT viewport on purpose: this readout must not move
      // with the thing it is measuring, or it can't be trusted to report it.
      // Above `shutdown`, the current ceiling: a diagnostic you can't read
      // because the thing you're diagnosing is covering it is no diagnostic.
      style={{ zIndex: LAYER.shutdown + 1 }}
      className="pointer-events-none fixed left-1 top-[max(var(--cm-safe-top),0.25rem)] rounded border border-line-strong bg-black/80 px-1.5 py-1 font-mono text-2xs leading-tight text-white backdrop-blur-sm"
    >
      {rows.map(([k, v, warn]) => (
        <div key={k} className="flex gap-1.5">
          <span className="w-11 shrink-0 text-white/45">{k}</span>
          <span className={warn ? "text-amber-300" : "text-white/90"}>{v}</span>
        </div>
      ))}
    </div>
  );
}
