import { LAYER } from "../../lib/layers.js";

/**
 * The title bar for every screen that isn't the shell.
 *
 * With the window controls overlay up the OS draws no title bar at all — the
 * page is expected to be one (`TitleBar` in TopBar). The shell is, but the
 * screens in front of it were not: connecting, updating, restarting, the login,
 * setup, the boot splash, a crash page. On those the minimise/maximise/close
 * buttons floated over a bare page, there was nothing to drag the window by,
 * and the band they sat in was whatever colour the screen happened to be.
 *
 * So this is one strip, mounted once at the root rather than taught to each
 * screen, so the next takeover anyone adds gets a header without knowing this
 * exists. It is in the header's colour (`bg-surface`, the same as `TitleBar`)
 * and is the window's drag handle (`.cm-titlebar`).
 *
 * WHETHER it shows is CSS, not React (`.cm-wco-strip` in index.css): only under
 * the overlay, and only when the shell's own bar is absent or something has
 * covered it — a `.cm-takeover` screen or `#boot-splash`, which index.html puts
 * in the DOM before this bundle has even loaded. The takeovers start below
 * `--dp-titlebar-h` so nothing of theirs is drawn under it.
 *
 * Its height is `--dp-titlebar-h` — exactly the OS band — and outside the
 * overlay that is 0, so it is inert even before the media query hides it.
 */
export function WindowStrip() {
  return (
    <div
      aria-hidden
      style={{ zIndex: LAYER.windowStrip }}
      className="cm-titlebar cm-wco-strip fixed inset-x-0 top-0 h-(--dp-titlebar-h) items-center border-b border-line bg-surface pl-[calc(var(--dp-titlebar-x)+0.75rem)] text-xs font-medium text-muted select-none"
    >
      Dispatch
    </div>
  );
}
