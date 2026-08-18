/**
 * Which bottom-nav slot is lit, and what the Chats slot does when you press it.
 *
 * Both answers are derived from four bits of shell state that live in two
 * different stores, and both used to be inline expressions in the JSX — which is
 * how the bar ended up lying about where you were. `current={pane === "chat"}`
 * is true while the Memory VIEW fills the main area, so the nav claimed you were
 * in the transcript from a screen that isn't one; and nothing at all lit up for
 * the More sheet or for any of the destinations it opens.
 *
 * Pulled out here as pure functions because the client's vitest config is a
 * plain node runner with no DOM (see vitest.config.ts) — a rule expressed as a
 * ternary inside a component can only be checked by rendering it, and a rule
 * expressed here is checked by calling it. The nav's whole job is answering
 * "where am I", so that answer is worth a test.
 */
import type { LayoutMode, Pane } from "../../stores/layout.js";
import type { AppView } from "../../stores/view.js";

/** The four slots in the strip. */
export type NavSlot = "chats" | "ship" | "run" | "more";

/** Everything the nav needs to know about where the app currently is. */
export interface NavPlace {
  mode: LayoutMode;
  view: AppView;
  pane: Pane;
  /** The off-canvas chat picker. Only ever open at `sm`. */
  leftOpen: boolean;
  /** The More sheet. */
  moreOpen: boolean;
}

/**
 * The one slot that should read as selected, or `null` for the one destination
 * none of them represents.
 *
 * Exactly one, deliberately. Two lit slots is the same failure as none: a bar
 * that can't be glanced at. So the transient chrome wins over the surface
 * underneath it — the More sheet is what's in front of you while it's open, the
 * chat picker likewise — and below that the view outranks the pane, because
 * `view: "memory"` + `pane: "run"` is representable and only one of the two is
 * on screen.
 *
 * Overlays (Workspace, MCP tools) deliberately don't figure. They render at the
 * dialog layer, which is above the nav, so the strip isn't visible — let alone
 * pressable — while one is up, and a highlight nobody can see is a rule nobody
 * can maintain.
 */
export function currentSlot({ view, pane, leftOpen, moreOpen }: NavPlace): NavSlot | null {
  if (moreOpen) return "more";
  if (leftOpen) return "chats";
  // Project setup is full-bleed and isn't reachable FROM the bar — it's the one
  // place where "nothing here is where you are" is the honest answer.
  if (view === "new-project") return null;
  // Everything else that isn't the transcript is something the More sheet opens,
  // and More is the only slot that stands for any of it.
  if (view !== "chat") return "more";
  return pane === "chat" ? "chats" : pane;
}

/**
 * What pressing Chats means right now.
 *
 * One slot, three meanings, because the ☰ and Chat slots it replaces were two
 * controls answering one question — and the ☰ was the only way to reach the
 * picker, so it couldn't just be dropped. The order is "get me back, then show
 * me the list": from anywhere else the press is a return to the transcript you
 * were last reading, and only once you're already there does it start toggling
 * the picker over it. That way the first press is never a surprise and the
 * second one is always the same thing.
 */
export type ChatsAction = "go-chat" | "open-picker" | "close-picker";

export function chatsAction({ mode, view, pane, leftOpen, moreOpen }: NavPlace): ChatsAction {
  // Above `sm` the sidebar is an inline column, so there is no picker to toggle
  // and the slot is a plain destination.
  if (mode !== "sm") return "go-chat";
  if (leftOpen) return "close-picker";
  if (moreOpen || view !== "chat" || pane !== "chat") return "go-chat";
  return "open-picker";
}
