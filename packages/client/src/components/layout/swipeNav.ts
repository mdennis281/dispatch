/**
 * Where an edge swipe takes you — the shell's back stack, as one pure function.
 *
 * The phone has four surfaces stacked over each other and no persistent way
 * back out of any of them: the More sheet over the chat picker over a Ship/Run
 * pane over the transcript, with the homepage underneath the lot. The bottom nav
 * can reach them, but only by naming each one — "back" is the relationship
 * BETWEEN them, and nothing in the app expressed it until this file.
 *
 * It lives beside `navState.ts` and reuses its `NavPlace` deliberately. That
 * module already answers "where am I" from exactly these bits for the nav strip;
 * a swipe that derived "where am I" from its own reading of the same state is
 * how a gesture and a highlighted nav slot come to disagree about which surface
 * you are on. One description of the place, two questions asked of it.
 *
 * Pure, and tested, for the reason `navState` gives: the client's vitest renders
 * no JSX, so a rule expressed as a ternary inside a touch handler can only be
 * checked on a phone, and a rule expressed here is checked by calling it.
 */
import { goHome, leaveHome } from "../../stores/navigation.js";
import { useLayout } from "../../stores/layout.js";
import { useView } from "../../stores/view.js";
import type { SwipeDir } from "../../lib/edgeSwipe.js";
import type { NavPlace } from "./navState.js";

/** What a committed swipe does. One move per swipe — never two surfaces at once. */
export type SwipeMove =
  | "close-more"
  | "leave-new-project"
  | "close-pane"
  | "open-picker"
  | "close-picker"
  | "go-home"
  | "leave-home";

/**
 * The move a swipe in `dir` means right now, or `null` for "nothing to do".
 *
 * BACK unwinds the stack from the top down, and the order of these four tests IS
 * the stack: transient chrome first (the More sheet is what is in front of you
 * while it is open), then the chat picker, then a pane that replaced the
 * transcript, and finally the transcript itself — whose parent is the picker,
 * which is what "swipe from a chat and land on the list of chats" means.
 *
 * The homepage is the ROOT and returns null rather than wrapping around. It is
 * tested before `pane` because `goHome` deliberately doesn't reset the pane
 * (see stores/navigation) — so at home there can be a stale `pane: "run"` that
 * nothing is rendering, and a back swipe that "closed" it would be a gesture
 * that visibly did nothing.
 *
 * FORWARD is the STRICT mirror — homepage → picker → transcript — and walks the
 * same rungs in the same order rather than short-cutting to the chat. There is
 * already a control that jumps straight back to the transcript (the brand
 * lockup's toggle, see `leaveHome`), and a gesture whose forward path skips the
 * rung its back path stopped on is a gesture you can't predict from one use. It
 * also matters more than it looks: a FULL-SCREEN chat picker has no scrim left
 * to tap, so swiping out of it is the only dismissal that isn't the bottom nav.
 *
 * Above `sm` every surface here is either inline or absent — the sidebar is a
 * column, there is no picker to open — so the whole gesture stands down, the
 * same guard `chatsAction` carries.
 */
export function swipeMove(place: NavPlace, dir: SwipeDir): SwipeMove | null {
  const { mode, view, pane, leftOpen, moreOpen } = place;
  if (mode !== "sm") return null;

  if (dir === "back") {
    if (moreOpen) return "close-more";
    // BOTH full-bleed views are resolved before `leftOpen` is consulted, and
    // that order is the fix for a real sequence rather than tidiness: tapping
    // "Add project" in the picker sets the view and does NOT dismiss the drawer
    // (`Sidebar`'s `onAddProject`, unlike the Memory/Files buttons under it), so
    // on the New Project form `leftOpen` is still true while `App` has unmounted
    // the drawer it describes. Reading it there sent a back swipe to `goHome`,
    // which unmounts the form — and the form holds the name, path and workflow
    // in local state, so a gesture that means "back one step" everywhere else
    // silently threw the whole thing away.
    if (view === "new-project") return "leave-new-project";
    if (view === "home") return null;
    if (leftOpen) return "go-home";
    if (pane !== "chat") return "close-pane";
    return "open-picker";
  }

  // The More sheet is modal chrome: forward out of it would leave it stranded
  // over a surface it was opened from somewhere else entirely. Back closes it.
  if (moreOpen) return null;
  // The form is not a rung on the stack — there is nothing to re-enter it FROM,
  // and the same stale `leftOpen` would otherwise make a forward swipe quietly
  // close a picker that is not on screen.
  if (view === "new-project") return null;
  if (view === "home") return "leave-home";
  if (leftOpen) return "close-picker";
  return null;
}

/**
 * Carry out a move.
 *
 * Routed through `goHome`/`leaveHome` rather than setting `view` here, because
 * those two are not setters — one snapshots the return address the homepage
 * toggle needs, the other resolves it through three fallbacks and resets the
 * pane. A swipe that set `view: "home"` itself would be the fourth caller to
 * get that wrong (see the docblock on `lastPlace`).
 */
export function runSwipe(move: SwipeMove): void {
  const layout = useLayout.getState();
  switch (move) {
    case "close-more":
      layout.setMoreOpen(false);
      return;
    case "leave-new-project":
      // Exactly what the form's OWN Back button does (`NewProjectView` falls
      // back to `setView("chat")`), and deliberately not `goHome`: a swipe that
      // disagreed with the visible control beside it is worse than no swipe.
      // `leftOpen` is left alone — when the form was reached from the picker it
      // is still set, so this lands back on the list it was opened from.
      useView.getState().setView("chat");
      return;
    case "close-pane":
      layout.setPane("chat");
      return;
    case "open-picker":
      layout.setLeftOpen(true);
      return;
    case "close-picker":
      layout.setLeftOpen(false);
      return;
    case "go-home":
      // `goHome` closes the picker itself, and snapshots the chat you were in as
      // the return address — so a forward swipe off the homepage lands back in
      // that chat rather than on the list.
      goHome();
      return;
    case "leave-home":
      // `leaveHome` resolves the return address and resets the pane, then the
      // picker goes back up OVER it: the homepage's rung below is the chat list,
      // not the transcript (see `swipeMove`). Opening it second rather than
      // instead is what makes the next forward swipe — "close-picker" — land on
      // the chat `leaveHome` just selected.
      leaveHome();
      useLayout.getState().setLeftOpen(true);
      return;
  }
}
