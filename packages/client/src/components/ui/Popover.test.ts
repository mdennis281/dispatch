import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fitsToRight, Popover } from "./Popover.js";

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
