/**
 * Hold the page at 1:1.
 *
 * The viewport meta in `index.html` already says `user-scalable=no`, and the
 * INSTALLED iOS app obeys it. A Safari tab does not — WebKit has ignored that
 * key in the browser since iOS 10 (an accessibility decision about documents),
 * so a two-finger pinch there magnifies the app shell: the top bar slides off
 * the top of the glass and, because the document itself never scrolls
 * (`overflow: hidden` on html/body), nothing can bring it back short of a
 * reload.
 *
 * The one lever WebKit still respects is the non-standard `gesture*` events it
 * fires for a pinch. Cancelling `gesturestart` cancels the zoom, and that is
 * all this does.
 *
 * It costs nothing elsewhere: no other engine fires these events. And it does
 * not touch the two places a pinch DOES mean something — the image viewer and
 * the annotator run their own zoom off pointer events, which are a separate
 * pipeline WebKit keeps delivering.
 *
 * Double-tap-to-zoom is handled in CSS instead (`touch-action: manipulation`
 * in index.css), since that one has no event to cancel.
 */
export function lockPageZoom(): void {
  // `passive: false` is mandatory — a passive listener's preventDefault is a
  // no-op, which would make this look wired up and do nothing.
  const block = (e: Event): void => e.preventDefault();
  document.addEventListener("gesturestart", block, { passive: false });
  document.addEventListener("gesturechange", block, { passive: false });
  document.addEventListener("gestureend", block, { passive: false });
}
