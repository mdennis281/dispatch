/**
 * Does this browser actually perform scroll anchoring? Ask it, don't ask
 * `@supports`.
 *
 * `.cm-row-cv` (index.css) gives transcript rows `content-visibility: auto`, so
 * a row nobody has looked at yet is a `contain-intrinsic-size` placeholder that
 * becomes its real height as you scroll up into it — ABOVE what you're reading.
 * Scroll anchoring is what absorbs that. Without it, every row you scroll up
 * past shoves the transcript by the difference.
 *
 * That was known, and PR #218 tried to disable the optimization where anchoring
 * is missing with `@supports not (overflow-anchor: auto)`. **It never fired on
 * the devices it was written for.** `@supports` asks whether a declaration
 * PARSES, not whether it BEHAVES, and WebKit parses `overflow-anchor` — a real
 * WebKit reports `CSS.supports("overflow-anchor", "auto") === true` and a
 * computed value of `auto`. So the override was skipped on iOS and the rows
 * kept shoving.
 *
 * Measured on Michael's iPhone (iOS 18.7, installed PWA) with the interaction
 * tracer, 2026-09-22: in 42s of ordinary scrolling, **97 of 98 row resizes came
 * from exactly 90px** — the placeholder — and 63 of them happened while the row
 * was ABOVE the reader, for 5,796px of uncompensated shift. Ordinary rows
 * collapse 90 → 26/32/66; a media or code row explodes 90 → 305/352/618, which
 * is why it is worst with media on screen.
 *
 * So this probes the BEHAVIOUR: build a scroller off to the side, scroll it so
 * a known element is the anchor, grow content strictly ABOVE that element, and
 * see whether the engine compensated `scrollTop`. Synchronous — two forced
 * layouts, no frame wait — so it can run before first paint and the answer is
 * in place before a single row renders.
 *
 * The geometry matters and is easy to get wrong: the growing element must NOT
 * be the anchor. An earlier version resized the same element the viewport was
 * sitting in, and every engine reported "no anchoring" — a false negative that
 * would have quietly disabled the optimization everywhere.
 *
 * Verified against real engines by `e2e/scroll-anchoring.spec.ts`, which runs
 * THIS function in Chromium and WebKit — asserting it answers true where the
 * engine anchors, and false when anchoring is suppressed. iOS 18.7, which does
 * not anchor, is the case this exists to catch and is covered by the trace
 * evidence above.
 */

/**
 * True when the engine compensated for content growing above the reader.
 *
 * Any failure answers `false`, which is the SAFE direction: the caller then
 * leaves `content-visibility` off, costing an optimization rather than
 * reintroducing the shove.
 *
 * SELF-CONTAINED on purpose — every constant is declared inside the body and it
 * closes over nothing. That is what lets `e2e/scroll-anchoring.spec.ts` hand
 * this exact function to `page.evaluate` in Chromium and WebKit and assert on
 * what it really answers, rather than testing a copy of it that can drift.
 */
/** What the last probe actually saw — recorded into traces so a wrong answer explains itself. */
export interface ProbeReading {
  anchored: boolean;
  /** `scrollTop` after the setup scroll. Must equal the offset we asked for. */
  before: number;
  /** `scrollTop` after growing the content above the anchor. */
  after: number;
  /** `after - before`. A real compensation is the growth, to the pixel. */
  delta: number;
  /** Why it answered the way it did. */
  why: string;
}

let lastReading: ProbeReading | null = null;

/** The last probe's raw numbers, for `interactionTrace`'s meta. */
export function lastProbeReading(): ProbeReading | null {
  return lastReading;
}

export function probeScrollAnchoring(): boolean {
  /** Viewport of the probe scroller. */
  const VIEW = 100;
  /** Content above the anchor, and how much it grows by. */
  const ABOVE = 300;
  const GROWTH = 100;
  /** The anchor element: taller than the viewport so it alone fills it. */
  const ANCHOR = 600;
  /** Scroll offset that puts the viewport wholly inside the anchor. */
  const OFFSET = 400;

  if (typeof document === "undefined" || !document.body) return false;
  const host = document.createElement("div");
  // Rendered but invisible and inert. NOT `position: absolute; top: -10000px`
  // and NOT `contain: strict` — containment suppresses anchor selection, and a
  // scroller parked far off-screen is a candidate for engines to skip work on.
  host.style.cssText =
    "position:fixed;top:0;left:0;width:200px;height:" +
    VIEW +
    "px;overflow:auto;opacity:0;z-index:-1;pointer-events:none";
  host.setAttribute("aria-hidden", "true");

  const above = document.createElement("div");
  above.style.height = `${ABOVE}px`;
  // Text content, not an empty box: anchor selection wants something to anchor
  // TO, and an empty div is not a candidate in every engine.
  above.textContent = "above";

  const anchor = document.createElement("div");
  anchor.style.height = `${ANCHOR}px`;
  anchor.textContent = "anchor";

  host.append(above, anchor);
  document.body.appendChild(host);
  try {
    host.scrollTop = OFFSET;
    // Flush the scroll, then force a layout so the engine picks its anchor.
    void host.scrollTop;
    void host.offsetHeight;
    const before = host.scrollTop;
    // Grow content STRICTLY ABOVE the anchor. If the engine anchors, it adds
    // the same amount to scrollTop so the anchor stays put on screen.
    above.style.height = `${ABOVE + GROWTH}px`;
    void host.offsetHeight;
    const after = host.scrollTop;
    const delta = after - before;

    // TWO checks, both strict, because the loose version of this shipped a
    // false positive. On Michael's iPhone (iOS 18.7) it answered TRUE while
    // per-frame sampling of the real transcript showed scrollTop not moving by
    // so much as a pixel when a row above the reader changed height.
    //
    // 1. The SETUP must have taken. `before` has to be the offset we asked for;
    //    if the engine reports something else, the scroll has not been applied
    //    yet and every number after it describes a different moment. A stale
    //    `before` of 0 followed by an `after` that picks up the requested 400
    //    reads as a 400px "compensation" that never happened — and `>= 50`
    //    waved it straight through.
    // 2. The delta must be the growth we CAUSED, to within a rounding pixel —
    //    not merely "big enough". A real adjustment is exactly GROWTH; anything
    //    else is some other movement being counted as one.
    //
    // Either way out answers false, which only costs the optimization.
    if (before !== OFFSET) {
      lastReading = { anchored: false, before, after, delta, why: `setup scroll did not take (${before} != ${OFFSET})` };
    } else if (Math.abs(delta - GROWTH) > 2) {
      lastReading = { anchored: false, before, after, delta, why: `delta ${delta} is not the ${GROWTH}px grown` };
    } else {
      lastReading = { anchored: true, before, after, delta, why: "compensated by exactly the growth" };
    }
    return lastReading.anchored;
  } catch (err) {
    lastReading = { anchored: false, before: -1, after: -1, delta: 0, why: `threw: ${String(err).slice(0, 60)}` };
    return false;
  } finally {
    host.remove();
  }
}

/**
 * Publish the answer as `data-cm-anchor="native"` on `<html>`, which is what
 * `.cm-row-cv` keys off.
 *
 * The attribute is only ever ADDED, never added-then-removed: the default state
 * of the stylesheet is the safe one (no `content-visibility`), so a browser that
 * cannot anchor simply never gets the attribute and never gets the shove. Run
 * this before the first render — turning the optimization on AFTER rows have
 * laid out at their real heights would itself collapse the off-screen ones to
 * the placeholder, which is the very jolt being prevented.
 */
/**
 * WebKit is excluded outright, on device evidence rather than on principle.
 *
 * The probe above answers TRUE on Michael's iPhone (iOS 18.7, installed PWA) —
 * recorded in the trace meta as `probe: true, attr: native, rowCv: auto` — while
 * per-frame sampling of the REAL transcript in that same session showed
 * `scrollTop` not moving by a single pixel as 55 rows changed height above the
 * reader, for 3,776px of uncompensated shift. Two rounds of feature detection
 * have now claimed this engine anchors when the transcript plainly shows it does
 * not, so the engine no longer gets a vote.
 *
 * This is the UA keying that the original `@supports` note refused on principle.
 * The principle cost three shipped attempts; a Safari that anchors correctly
 * loses an optimization, which is the cheap side of the trade. Re-including
 * WebKit needs DEVICE evidence — a trace whose row resizes no longer come from
 * the 90px placeholder — not a better synthetic probe.
 *
 * Chromium on macOS reports "Safari" in its UA too, hence the AppleWebKit test
 * with the Chrome/Chromium exclusions rather than a bare "Safari" match.
 */
export function isWebKitEngine(ua: string): boolean {
  // Every Chromium UA also says "AppleWebKit" and "Safari", so the exclusions
  // carry the whole test. Playwright's WebKit build on Windows reports a
  // Chrome UA outright, which is why this is unit-tested against real strings
  // rather than asserted in a browser.
  return /AppleWebKit/.test(ua) && !/(Chrome|Chromium|CriOS|Edg|OPR|Android)/.test(ua);
}

export function applyScrollAnchoring(): void {
  if (isWebKitEngine(navigator.userAgent)) return;
  if (probeScrollAnchoring()) {
    document.documentElement.dataset.cmAnchor = "native";
  }
}

