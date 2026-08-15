import { useEffect } from "react";

/**
 * Publishes how much of the window the soft keyboard is covering, as
 * `--cm-kb` on `<html>`.
 *
 * On iOS — and on Android Chrome, whose `interactive-widget` default is
 * `resizes-visual` — raising the keyboard shrinks the VISUAL viewport and
 * leaves the layout viewport alone. `100dvh` is a layout-viewport unit, so the
 * app column stays full-window-height and its bottom row (the composer) sits
 * behind the keyboard. iOS papers over that by scrolling the page to reveal the
 * caret, which is why the shell used to end up with the composer stranded
 * mid-screen and a dead band between it and the keyboard.
 *
 * The fix is to tell the layout what the keyboard is taking, so the app column
 * can shrink to what's actually visible. `visualViewport.height` is the only
 * source for that number.
 *
 * `innerHeight`, not `documentElement.clientHeight`, as the reference: the
 * latter is the LARGE viewport, so it reads ~60px short of the visual viewport
 * whenever the URL bar is showing and we'd pad for a keyboard that isn't there.
 * `innerHeight` tracks the URL bar and ignores the keyboard, which is exactly
 * the difference we want.
 */
export function keyboardInset(innerHeight: number, vvHeight: number, vvOffsetTop: number): number {
  // What we want is the gap between the window's bottom and the bottom of the
  // band you can actually see — which is where the shell has to stop. When iOS
  // scrolls the page to reveal the caret it moves that band DOWN the window
  // (`offsetTop`), so the gap below it shrinks by exactly that much; the shell
  // is anchored to the window's top and has scrolled with it.
  return Math.max(0, Math.round(innerHeight - vvHeight - vvOffsetTop));
}

export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    let frame = 0;
    let last = -1;

    const apply = () => {
      frame = 0;
      const kb = keyboardInset(window.innerHeight, vv.height, vv.offsetTop);
      // Sub-pixel churn during the keyboard animation would otherwise write a
      // new value on every frame and, through the shell's height, feed the
      // Composer's ResizeObserver-driven toolbar compaction.
      if (Math.abs(kb - last) < 2) return;
      last = kb;
      document.documentElement.style.setProperty("--cm-kb", `${kb}px`);
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(apply);
    };

    apply();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    window.addEventListener("orientationchange", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      window.removeEventListener("orientationchange", schedule);
      document.documentElement.style.removeProperty("--cm-kb");
    };
  }, []);
}
