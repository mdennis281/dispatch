/**
 * The composer's placeholder — the one hint worth spending it on.
 *
 * A placeholder is read once and then ignored forever, so it gets exactly one
 * job: name the key that sends. Everything else the composer can do (paste an
 * image, drop a file for its path, shift-enter for a newline) is discoverable by
 * doing it, and listing all of it turned the empty composer into two lines of
 * grey prose you had to read past to start typing.
 *
 * The modifier is per-OS and only ONE is ever shown. Telling a Mac user about
 * Ctrl is noise at best and wrong at worst.
 *
 * On a coarse pointer there is no modifier key at all — an iPhone has a send
 * button and a Return key, so the hint would name a chord that cannot be typed.
 * There we drop it entirely and the placeholder is just the invitation.
 * `(pointer: coarse)` is the same signal `index.css` uses for its touch rules.
 */

/**
 * Exported for the composer's stand-down stub, which has to name the gesture
 * that hands the box back — a double TAP or a double CLICK. Same reading of the
 * pointer as the placeholder's, for the same reason: naming a gesture the
 * device does not have is worse than naming none.
 */
export function isTouchPrimary(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

/**
 * True on macOS and iPadOS. iPadOS reports a Mac platform, which is fine —
 * a coarse pointer has already excluded it before this is asked.
 *
 * Exported for `lib/sendMode`, which spells the same modifier in the send
 * dropup's key hints. One reading of the platform, or the placeholder and the
 * menu can name different keys on the same machine.
 */
export function isApple(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Placeholder for the message composer, resolved once per call site. It can't
 * change without the window moving to another machine, so there is no hook and
 * no listener here.
 */
export function composerPlaceholder(): string {
  if (isTouchPrimary()) return "Message agent";
  return `Message agent — ${isApple() ? "⌘↵" : "Ctrl↵"} to send`;
}
