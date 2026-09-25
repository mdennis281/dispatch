/**
 * The boot splash's mark, rendered from inside the app.
 *
 * The splash is a loading indicator that took a lot of tuning, and until now it
 * could only ever be seen for the three and a half seconds of a cold boot. The
 * two screens that are also "Dispatch is working on it, wait" — `ConnectingScreen`
 * and `UpdatingScreen` — had a pulsing lucide glyph instead. They get the real
 * thing now.
 *
 * ── WHAT IS AND IS NOT HERE ─────────────────────────────────────────────────
 *
 * No CSS, and no animation. Every rule that drives this lives in the `<style>`
 * in index.html's <head>, alongside the splash's own — which is why the loop
 * rules there are written as bare `.boot-splash__*` class selectors rather than
 * being scoped under `#boot-splash`. Two copies of those keyframes, one in the
 * bundle and one in the document, is the failure mode worth designing out: they
 * would drift, and the splash is the one surface where a drift is invisible
 * until somebody boots cold and watches carefully.
 *
 * It also means both marks run off the SAME document timeline. A `BootMark`
 * mounted forty minutes into a session is already mid-cycle, in phase with a
 * splash that is long gone, and that is correct — the loop has no beginning.
 *
 * The exit (`[data-done]`, the ball, the aperture) is scoped to `#boot-splash`
 * and deliberately not reachable from here. This mark does not resolve into
 * anything; it just keeps going until whatever it is reporting on is over.
 *
 * ── THE HOLD ────────────────────────────────────────────────────────────────
 *
 * The colour rotation is driven by the inline script in <head>, which stops
 * ticking once nothing is showing the mark — the splash releases its own hold
 * when it lifts. Without a hold of our own, a `BootMark` on a connecting screen
 * would render in whatever three colours happened to be set when the splash
 * went away, frozen, forever.
 *
 * Optional at runtime and typed as such: the script is inline in index.html and
 * so is always there in a real page, but a vitest render of a component that
 * happens to contain this has no <head> at all.
 */
import { useEffect } from "react";
import { BootMarkArt } from "./BootMarkArt.js";
// For the `Window.__dispatchBootMark` declaration, which lives with the module
// that owns the splash's lifetime.
import "../../lib/bootSplash.js";

/** Default box. Bigger than the 48px icon chips it replaces, because the mark is
 *  a strip that moves rather than a glyph that sits, and it needs the room. */
const DEFAULT_SIZE = 72;

export function BootMark({ size = DEFAULT_SIZE }: { size?: number }) {
  useEffect(() => window.__dispatchBootMark?.hold(), []);
  // `--boot-mark-size` is what `.boot-splash__mark` reads for its box; the
  // splash leaves it unset and gets the 116px default.
  return <BootMarkArt style={{ ["--boot-mark-size" as string]: `${size}px` }} />;
}
