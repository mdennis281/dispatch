import { describe, it, expect } from "vitest";
import { keyboardInset, standaloneShellHeight } from "./viewport.js";

describe("standaloneShellHeight", () => {
  it("stays out of the way in a browser tab", () => {
    // A shrinking window there means the URL bar came back, which the shell
    // must follow. 0 tells the caller to leave it on `100dvh`.
    expect(standaloneShellHeight(false, 873, 932)).toBe(0);
  });

  it("stays out of the way until a shrink is actually observed", () => {
    expect(standaloneShellHeight(true, 932, 932)).toBe(0);
  });

  it("pins to the pre-shrink height once the window drops", () => {
    // The iOS standalone bug: ~59px gone the first time the keyboard opens,
    // never returned. This is the whole fix — 932, not the reported 873.
    expect(standaloneShellHeight(true, 873, 932)).toBe(932);
  });

  it("ignores a rounding-sized wobble", () => {
    // Pinning the shell a pixel taller than the window would make the document
    // scrollable for no reason.
    expect(standaloneShellHeight(true, 929, 932)).toBe(0);
  });

  it("keeps the correction while the keyboard is up", () => {
    // `innerHeight` does not move with the keyboard, so the deficit — and the
    // correction — persist across the whole typing session.
    expect(standaloneShellHeight(true, 873, 932)).toBe(932);
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
