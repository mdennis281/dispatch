/**
 * The one part of `HoverCard` a node-environment test can hold: which blurs
 * dismiss the card.
 *
 * It is also the part that was wrong. The panel is portalled to `document.body`,
 * so reaching into it genuinely blurs the trigger — and a plain
 * `onBlur={closeSoon}` therefore closed the card exactly when someone clicked
 * something in it. The usage card's Refresh button started its request and then
 * the panel vanished ~140ms later, spinner and all.
 *
 * Pure over `contains` rather than rendered: the client's vitest runs in a
 * `node` environment (see vitest.config.ts), so there is no DOM to fire a real
 * `focusout` in. Fakes are enough here, because the predicate's whole job is to
 * ask two nodes whether they own the thing focus went to.
 */
import { describe, expect, it } from "vitest";
import { blurLeavesCard } from "./HoverCard.js";

/** A node that claims the given descendants, like a real element would. */
function owner(...children: unknown[]): Node {
  return {
    contains: (n: unknown) => children.includes(n),
  } as unknown as Node;
}

const refreshButton = {};
const gaugeLabel = {};
const elsewhere = {};

const panel = owner(refreshButton);
const trigger = owner(gaugeLabel);

describe("blurLeavesCard", () => {
  it("keeps the card open when focus moves into the panel", () => {
    // The Refresh click, and "Break down by chat".
    expect(blurLeavesCard(refreshButton as EventTarget, trigger, panel)).toBe(false);
    expect(blurLeavesCard(panel as unknown as EventTarget, trigger, panel)).toBe(false);
  });

  it("keeps it open when focus returns to the trigger or something inside it", () => {
    expect(blurLeavesCard(trigger as unknown as EventTarget, trigger, panel)).toBe(false);
    expect(blurLeavesCard(gaugeLabel as EventTarget, trigger, panel)).toBe(false);
  });

  it("treats a blur to nothing focusable as staying", () => {
    // Clicking the panel's own text, or the window losing focus. The pointer is
    // still over the card and `mouseleave` is what should close it.
    expect(blurLeavesCard(null, trigger, panel)).toBe(false);
  });

  it("closes when focus genuinely lands somewhere else", () => {
    expect(blurLeavesCard(elsewhere as EventTarget, trigger, panel)).toBe(true);
  });

  it("closes when there is no panel mounted to move into", () => {
    expect(blurLeavesCard(elsewhere as EventTarget, trigger, null)).toBe(true);
  });
});
