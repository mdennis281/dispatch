import { describe, it, expect } from "vitest";
import { keyboardInset, standaloneShellHeight } from "./viewport.js";

// A device whose UA has already taken the status bar out of the viewport: no
// top inset to add back, so only the shrink correction can fire.
const noTopInset = (standalone: boolean, inner: number, max: number) =>
  standaloneShellHeight(standalone, inner, max, 0, 932);

describe("standaloneShellHeight", () => {
  it("stays out of the way in a browser tab", () => {
    // A shrinking window there means the URL bar came back, which the shell
    // must follow. 0 tells the caller to leave it on `100dvh`.
    expect(noTopInset(false, 873, 932)).toBe(0);
  });

  it("stays out of the way until a shrink is actually observed", () => {
    expect(noTopInset(true, 932, 932)).toBe(0);
  });

  it("pins to the pre-shrink height once the window drops", () => {
    // The iOS standalone bug: ~59px gone the first time the keyboard opens,
    // never returned. This is the whole fix — 932, not the reported 873.
    expect(noTopInset(true, 873, 932)).toBe(932);
  });

  it("ignores a rounding-sized wobble", () => {
    // Pinning the shell a pixel taller than the window would make the document
    // scrollable for no reason.
    expect(noTopInset(true, 929, 932)).toBe(0);
  });

  it("keeps the correction while the keyboard is up", () => {
    // `innerHeight` does not move with the keyboard, so the deficit — and the
    // correction — persist across the whole typing session.
    expect(noTopInset(true, 873, 932)).toBe(932);
  });

  it("adds the status bar back when we are being charged for it twice", () => {
    // The measured iPhone: 873 of window inside a 932 screen, with a 59 top
    // inset to pad around. Both numbers describe the SAME band, so the shell
    // has to span the whole screen or that band is dead space at the bottom.
    expect(standaloneShellHeight(true, 873, 873, 59, 932)).toBe(932);
  });

  it("adds it back on top of the shrink correction, not instead of it", () => {
    // First keyboard open has taken another 59 off the window. The pre-shrink
    // maximum is still short of the screen by the status bar.
    expect(standaloneShellHeight(true, 814, 873, 59, 932)).toBe(932);
  });

  it("declines when the band it would add isn't there", () => {
    // A UA that reports a top inset but has NOT taken it out of the window:
    // adding it would pin the shell past the bottom of the screen and hand
    // back the overflow the fixed shell exists to remove.
    expect(standaloneShellHeight(true, 932, 932, 59, 932)).toBe(0);
  });

  it("does not touch a browser tab that has a top inset", () => {
    // Landscape Safari on a notched phone: the URL bar owns the bottom edge
    // and the shell must keep following `dvh`.
    expect(standaloneShellHeight(false, 873, 932, 59, 932)).toBe(0);
  });
});

describe("keyboardInset", () => {
  it("is zero with no keyboard up", () => {
    expect(keyboardInset(932, 932, 0)).toBe(0);
  });

  it("is zero while the URL bar is showing", () => {
    // `innerHeight` tracks the URL bar, so both sides shrink together. This is
    // the case that ruled out `documentElement.clientHeight` as the reference:
    // that one stays at the large viewport and would report a ~60px keyboard.
    expect(keyboardInset(872, 872, 0)).toBe(0);
  });

  it("reports the keyboard's height", () => {
    expect(keyboardInset(932, 596, 0)).toBe(336);
  });

  it("measures to the visible band's bottom edge, not the keyboard's height", () => {
    // Same keyboard, but iOS scrolled the page 40px to reveal the caret, so the
    // visible band starts 40px down the window and ends 40px higher above the
    // window's bottom than the keyboard alone accounts for. What the shell has
    // to clear is that bottom edge — it is anchored to the window's top, which
    // has moved off screen with everything else.
    expect(keyboardInset(932, 596, 40)).toBe(296);
  });

  it("measures against the shell, not the window it was corrected away from", () => {
    // Shell 932 because the status bar was added back; the window still says
    // 873 and the keyboard leaves 519 visible. Measured against the window this
    // is 354, and the composer floats a status bar's worth above the keys —
    // which is the gap that survived #59 and #60.
    expect(keyboardInset(932, 519, 0)).toBe(413);
  });

  it("never goes negative", () => {
    // Pinch-zoom makes the visual viewport taller than the window.
    expect(keyboardInset(932, 1400, 0)).toBe(0);
  });

  it("rounds to whole pixels", () => {
    expect(keyboardInset(932.4, 596.1, 0)).toBe(336);
  });

  it("reports nothing when the whole window shrank with the keyboard", () => {
    // The standalone-PWA failure mode: `innerHeight` shrinks too, so there is
    // no difference left to measure and the shell must NOT pad. Whether that
    // is correct depends on whether `100dvh` shrank with it — which is why the
    // debug overlay reports `dvh` and `inner` side by side.
    expect(keyboardInset(596, 596, 0)).toBe(0);
  });
});
