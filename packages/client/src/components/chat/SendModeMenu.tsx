/**
 * The dropup beside Send, shown only while a turn is running.
 *
 * Two jobs, and keeping them on ONE row each is the whole design:
 *
 *   - the row itself SENDS with that mode, right now. Not "arm the button and
 *     press it again" — the reason you opened the menu is that this one message
 *     wants different treatment from your usual, and making that two clicks and
 *     a state change you then have to undo is worse than the keyboard chord it
 *     is standing in for.
 *   - the pin on its right makes that mode the app-wide default, which is what
 *     Ctrl/⌘↵ and the button itself then do.
 *
 * The pin is a SIBLING of the row, never nested inside it: a button inside a
 * button is invalid markup and the inner click never reliably arrives.
 *
 * Every row names its chord, so the menu is also how the shortcuts are
 * discovered — the composer placeholder only has room for one of them.
 */
import { Check, Pin, Navigation, Clock, Zap, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";
import { Popover, MenuItem } from "../ui/Popover.js";
import { IconButton } from "../ui/IconButton.js";
import { Kbd } from "../ui/Kbd.js";
import {
  SEND_MODES,
  SEND_MODE_BLURB,
  SEND_MODE_LABEL,
  sendModeKeyHint,
  type SendMode,
} from "../../lib/sendMode.js";

/** One glyph per mode, reused by the Send button so the two always agree. */
export const SEND_MODE_ICON: Record<SendMode, ReactNode> = {
  steer: <Navigation />,
  queue: <Clock />,
  interrupt: <Zap />,
};

export function SendModeMenu({
  appDefault,
  onSend,
  onPinDefault,
  phone,
}: {
  appDefault: SendMode;
  /** Send the box's contents with this mode, now. */
  onSend: (mode: SendMode) => void;
  /** Make this mode the app-wide default (Ctrl/⌘↵ and the button). */
  onPinDefault: (mode: SendMode) => void;
  phone: boolean;
}) {
  return (
    <Popover
      side="top"
      align="end"
      // Wide enough for the longest row — "Interrupt", `Ctrl⇧↵` and the pin — at
      // once. Narrower and the key hint, which is half the reason the menu
      // exists, is the thing that gets squeezed out.
      width={320}
      trigger={({ open, toggle }) => (
        <IconButton
          size="md"
          active={open}
          onClick={toggle}
          tip="Other send types"
          // Tucked against Send so the two read as one split control, and given
          // the same height so the row's baseline doesn't shift when it appears.
          className="-ml-1"
        >
          <ChevronUp />
        </IconButton>
      )}
    >
      {(close) => (
        <div className="p-1">
          <div className="px-2 pb-1 pt-0.5 text-2xs uppercase tracking-wide text-muted">
            While this turn is running
          </div>
          {SEND_MODES.map((mode) => (
            <div key={mode} className="flex items-center gap-0.5">
              <MenuItem
                className="min-w-0 flex-1"
                dense={!phone}
                icon={SEND_MODE_ICON[mode]}
                active={mode === appDefault}
                title={SEND_MODE_BLURB[mode]}
                hint={<Kbd>{sendModeKeyHint(mode)}</Kbd>}
                onClick={() => {
                  close();
                  onSend(mode);
                }}
              >
                {SEND_MODE_LABEL[mode]}
              </MenuItem>
              {/* The default wears a CHECK, not a dimmed pin. A greyed-out pin
                  says "you can't do this" where the thing being communicated is
                  "this one is already set" — and the column keeps its width
                  either way, so the rows don't shuffle between openings. */}
              <IconButton
                size="sm"
                active={mode === appDefault}
                disabled={mode === appDefault}
                tip={
                  mode === appDefault
                    ? `${SEND_MODE_LABEL[mode]} is the default`
                    : `Make ${SEND_MODE_LABEL[mode]} the default`
                }
                onClick={() => onPinDefault(mode)}
                className="shrink-0 disabled:opacity-100"
              >
                {mode === appDefault ? <Check /> : <Pin />}
              </IconButton>
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}
