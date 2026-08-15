import { describe, it, expect } from "vitest";
import { keyboardInset } from "./useKeyboardInset.js";

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
});
