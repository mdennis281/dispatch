import { describe, it, expect } from "vitest";
import { keyboardInset } from "./viewport.js";

// The shell IS the window — `height: 100dvh`, no correction. There used to be a
// `standaloneShellHeight` that pinned it to the tallest window ever seen and
// added the status bar back on top; both are gone. See
// docs/ios-pwa-viewport-findings.md for why neither could work.
const plain = (windowHeight: number, vvHeight: number, vvOffsetTop: number) =>
  keyboardInset(windowHeight, vvHeight, vvOffsetTop);

describe("keyboardInset", () => {
  it("is zero with no keyboard up", () => {
    expect(plain(932, 932, 0)).toBe(0);
  });

  it("is zero while the URL bar is showing", () => {
    // `innerHeight` tracks the URL bar, so both sides shrink together. This is
    // the case that ruled out `documentElement.clientHeight` as the reference:
    // that one stays at the large viewport and would report a ~60px keyboard.
    expect(plain(872, 872, 0)).toBe(0);
  });

  it("reports the keyboard's height", () => {
    expect(plain(932, 596, 0)).toBe(336);
  });

  it("measures to the visible band's bottom edge, not the keyboard's height", () => {
    // Same keyboard, but iOS scrolled the page 40px to reveal the caret, so the
    // visible band starts 40px down the window and ends 40px higher above the
    // window's bottom than the keyboard alone accounts for. What the shell has
    // to clear is that bottom edge — it is anchored to the window's top, which
    // has moved off screen with everything else.
    expect(plain(932, 596, 40)).toBe(296);
  });

  it("measures the keyboard against the window, not a remembered height", () => {
    // The iOS standalone shrink has taken the window to 873 and the keyboard
    // leaves 519 of it visible. That is the whole inset: the shell is 873 too,
    // so there is no band below it for the keyboard to also be covering. The
    // old code added the difference between a 932 pinned shell and this window
    // and returned 413, which padded a status bar's worth of nothing off the
    // bottom of a shell that was already wrong.
    expect(plain(873, 519, 0)).toBe(354);
  });

  it("is zero at rest after the standalone shrink", () => {
    // `visualViewport` is capped at the layout viewport, so with the shell
    // pinned taller than the window this used to read the difference as
    // permanently covered — a phantom keyboard, which reads downstream as
    // "typing" and took the bottom nav off screen for good.
    expect(plain(873, 873, 0)).toBe(0);
  });

  it("does not amplify a rounding wobble into a keyboard", () => {
    expect(plain(873, 872, 0)).toBe(0);
  });

  it("never goes negative", () => {
    // Pinch-zoom makes the visual viewport taller than the window.
    expect(plain(932, 1400, 0)).toBe(0);
  });

  it("rounds to whole pixels", () => {
    expect(plain(932.4, 596.1, 0)).toBe(336);
  });

  it("reports nothing when the whole window shrank with the keyboard", () => {
    // The standalone-PWA failure mode: `innerHeight` shrinks too, so there is
    // no difference left to measure and the shell must NOT pad. Whether that
    // is correct depends on whether `100dvh` shrank with it — which is why the
    // debug overlay reports `dvh` and `inner` side by side.
    expect(plain(596, 596, 0)).toBe(0);
  });
});
