/**
 * What counts as focusable, in one place.
 *
 * Two very different surfaces need the same answer. `layout/Drawer` walks it to
 * TRAP focus inside an open sheet; `ui/HoverCard` asks only whether a card has
 * anything worth moving focus into at all. A near-miss between two copies of
 * this selector is the kind of bug that shows up as "Tab does nothing in that
 * one panel", so there is one copy.
 *
 * `:not([disabled])` on the form controls because a disabled control is not a
 * tab stop — the usage card's Refresh button disables itself mid-request, and a
 * trap that counted it would park focus on something inert.
 */
export const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
