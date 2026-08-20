/**
 * Who sits on top of whom.
 *
 * Every overlay in the app used to pick its own `z-[…]` in isolation, and the
 * numbers only agreed by luck: the code viewer opened BEHIND the project-config
 * dialog because one said 50 and the other said 100, and bumping the loser to
 * 110 fixed that one pairing while leaving the next one to be discovered the
 * same way. The rule that was missing is simple and it's about time, not
 * taxonomy: **a dialog opened from another dialog belongs above it**.
 *
 * So dialogs no longer carry a constant. They call {@link useDialogLayer}, which
 * hands out a z-index from how many dialogs are already open — the third dialog
 * lands above the second lands above the first, whatever they are, in whatever
 * order the app happens to mount them. Closing releases the slot.
 *
 * The bands around the dialog stack are fixed, because their ordering IS
 * taxonomy rather than history:
 *
 *   - `drawer` / `bottomNav` sit UNDER everything else, because they are the
 *     app's own chrome rather than something layered over it. A drawer is not a
 *     popover: `LAYER.popover` is 400 and sits above the whole dialog band, so
 *     an off-canvas sidebar borrowing that constant would cover the delete-chat
 *     dialog opened from a row inside itself. `bottomNav` is one step above
 *     `drawer` on purpose — its Chats and More slots are the toggles that DISMISS
 *     the chat picker and the More sheet, so being underneath the things it
 *     closes would strand you in both.
 *   - `toast` sits under dialogs: a notice must never cover a decision.
 *   - `palette` (command palette, file picker) sits above every dialog: it's
 *     summoned from anywhere and can't be underneath what summoned it.
 *   - `popover` and `tooltip` sit above everything a dialog can reach, because
 *     they're spawned BY controls inside these surfaces — a select menu inside
 *     the fourth-deep dialog still has to render over it.
 *   - `connecting` then `shutdown` are last because the server is gone and
 *     nothing else matters. They are mutually exclusive by their own guards;
 *     the ordering is belt-and-braces.
 *
 * The dialog band is capped below `palette`, so a pathological stack of dialogs
 * can never climb over the transient layers.
 */
import { useEffect, useState } from "react";

/** Fixed bands. Dialogs get their z from `useDialogLayer`, not from here. */
export const LAYER = {
  /** Dim behind an off-canvas drawer. */
  drawerScrim: 30,
  /** The off-canvas panel itself (mobile sidebar / right panel / More sheet). */
  drawer: 40,
  /** The mobile bottom nav — above the drawers it opens and closes. */
  bottomNav: 50,
  toast: 60,
  /** First dialog. Each nested one adds `DIALOG_STEP`, up to `DIALOG_MAX`. */
  dialog: 100,
  palette: 300,
  popover: 400,
  tooltip: 500,
  /**
   * The connection diagnosis. Above everything the app itself can raise, because
   * once the socket is down every control under it silently fails — but BELOW
   * `shutdown`, because a deliberate stop is a more specific answer than "can't
   * connect" and the two must never argue about which is on top.
   */
  connecting: 580,
  shutdown: 600,
} as const;

export const DIALOG_STEP = 10;
/** Ceiling for the dialog band — stays clear of `palette` and above. */
export const DIALOG_MAX = LAYER.palette - DIALOG_STEP;

/** How many dialogs are currently mounted-and-open. */
let openDialogs = 0;

function layerFor(depth: number): number {
  return Math.min(LAYER.dialog + depth * DIALOG_STEP, DIALOG_MAX);
}

/**
 * The z-index this dialog should render at, given what's already open.
 *
 * Call it unconditionally (hooks rules) and pass whether the dialog is actually
 * open — a mounted-but-closed dialog holds no slot. The value is captured when
 * the dialog opens and held until it closes, so a dialog never re-stacks under
 * something that opened later and then closed.
 */
export function useDialogLayer(open = true): number {
  // Seeded from the live count so a dialog that mounts already-open paints at
  // the right depth on its FIRST frame; the effect below fixes up the
  // mounted-closed-then-opened case.
  const [z, setZ] = useState(() => layerFor(openDialogs));

  useEffect(() => {
    if (!open) return;
    setZ(layerFor(openDialogs));
    openDialogs += 1;
    return () => {
      openDialogs -= 1;
    };
  }, [open]);

  return open ? z : LAYER.dialog;
}
