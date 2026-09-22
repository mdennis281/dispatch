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
    // Half the growth is a wide margin either way: a real adjustment is the
    // full 100px, and an engine that does nothing leaves it at 0.
    return host.scrollTop - before >= GROWTH / 2;
  } catch {
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
export function applyScrollAnchoring(): void {
  if (probeScrollAnchoring()) {
    document.documentElement.dataset.cmAnchor = "native";
  }
}
