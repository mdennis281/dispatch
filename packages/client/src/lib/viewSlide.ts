import { flushSync } from "react-dom";
import type { AppView } from "../stores/view.js";

/** Which way the shell travelled. Drives the CSS in index.css. */
export type NavDir = "forward" | "back";

/**
 * Where each surface sits on the shell's back stack.
 *
 * Not invented here — it is the order `components/layout/swipeNav.ts` already
 * walks: the homepage is the ROOT, the chat workspace sits on top of it, and
 * the project-setup form sits on top of THAT (back out of the form lands on the
 * chat, back out of the chat lands home). The edge swipe has expressed this
 * relationship on the phone for a while; this is the same stack, finally said
 * out loud for the pointer too.
 *
 * Everything else — memory, git, files, metrics, settings — is the chat
 * workspace with a different panel in it. Same rung, so moving between them is
 * not travel and gets no slide.
 */
function depth(view: AppView): number {
  if (view === "home") return 0;
  if (view === "new-project") return 2;
  return 1;
}

/** The two views that take the whole window under the top bar. */
function fullBleed(view: AppView): boolean {
  return view === "home" || view === "new-project";
}

/**
 * Which way a view change travels, or `null` for one that doesn't.
 *
 * Only crossings in or out of a full-bleed view count. Those are the ones that
 * replace the sidebar AND the entire main area in a single commit — every pixel
 * under the top bar at once, which is what reads as a glitch rather than as
 * navigation. Swapping one panel for another inside the shell never did.
 */
export function slideDirection(prev: AppView, next: AppView): NavDir | null {
  if (prev === next) return null;
  if (!fullBleed(prev) && !fullBleed(next)) return null;
  return depth(next) > depth(prev) ? "forward" : "back";
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (cb: () => void) => { finished: Promise<void> };
};

/**
 * Apply a view change as a slide.
 *
 * The View Transitions API, rather than animating the arriving surface
 * ourselves, because what was asked for is a slide IN AND OUT — and the
 * outgoing surface is gone the moment React commits. The platform snapshots it
 * for us, so both halves travel without keeping a second copy of a transcript
 * (or of several hundred chat rows) mounted to animate it off screen.
 *
 * `flushSync` is required: the snapshot of the NEW state is taken as soon as
 * the callback returns, so a React update still sitting in the queue would be
 * captured as "nothing changed" and nothing would move.
 *
 * No support (Firefox before 141, Safari before 18) and reduced-motion both
 * land on the same path — apply the change, skip the travel. Navigation still
 * works; it just doesn't move.
 */
export function runViewSlide(dir: NavDir, apply: () => void): void {
  const doc = typeof document === "undefined" ? undefined : (document as ViewTransitionDocument);
  const reduce =
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  if (!doc?.startViewTransition || reduce) {
    apply();
    return;
  }

  // Read by the `::view-transition-*` rules to pick which way the pair travels.
  // Cleared on `finished` rather than on a timer so a transition the browser
  // skipped (a second navigation on top of this one) still tidies up.
  doc.documentElement.dataset.cmNav = dir;
  const transition = doc.startViewTransition(() => flushSync(apply));
  void transition.finished.catch(() => {}).then(() => {
    if (doc.documentElement.dataset.cmNav === dir) delete doc.documentElement.dataset.cmNav;
  });
}
