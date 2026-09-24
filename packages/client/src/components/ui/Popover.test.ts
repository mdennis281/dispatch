import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fitsToRight, Popover, visibleBand } from "./Popover.js";

describe("Popover", () => {
  it("can render closed without browser globals", () => {
    expect(() =>
      renderToString(
        createElement(
          Popover,
          {
            trigger: ({ toggle }) => createElement("button", { onClick: toggle }, "Open"),
            children: "Menu",
          },
        ),
      ),
    ).not.toThrow();
  });
});

describe("fitsToRight", () => {
  it("includes the live boundary and menu widths in the flyout decision", () => {
    expect(fitsToRight(260, 232, 1024)).toBe(true);
    expect(fitsToRight(780, 232, 1024)).toBe(false);
  });

  it("falls back as soon as the viewport safe edge would be crossed", () => {
    // boundary + 6px gap + menu = viewport - 8px safe margin
    expect(fitsToRight(754, 232, 1_000)).toBe(true);
    expect(fitsToRight(755, 232, 1_000)).toBe(false);
  });

  it("re-evaluates each changed width rather than relying on a breakpoint", () => {
    expect(fitsToRight(260, 300, 600)).toBe(true);
    expect(fitsToRight(300, 300, 600)).toBe(false);
    expect(fitsToRight(300, 240, 600)).toBe(true);
  });
});

describe("visibleBand", () => {
  it("is the whole layout viewport when no keyboard is up", () => {
    expect(visibleBand(900, 0, 0)).toEqual({ top: 0, bottom: 900 });
  });

  it("stops at the top of an iOS keyboard the layout viewport ignores", () => {
    // iPhone: innerHeight stays 932, ~336px of it is covered by the keyboard.
    expect(visibleBand(932, 336, 0)).toEqual({ top: 0, bottom: 596 });
  });

  it("follows the visible band down when iOS scrolls it to chase the caret", () => {
    expect(visibleBand(932, 300, 36)).toEqual({ top: 36, bottom: 632 });
  });

  it("never reports a band shorter than a menu's floor", () => {
    expect(visibleBand(900, 880, 0)).toEqual({ top: 0, bottom: 96 });
  });
});
