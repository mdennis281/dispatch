import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerSwipePanel, beginPanelDrag } from "./swipeDrag.js";

/**
 * The client's vitest is node-environment, so this stands up the two things the
 * module actually touches: a `window` with timers, and something with a width
 * and a `style` bag. That is enough to test the part that is genuinely hard —
 * which GRAB owns the panel's inline styles, and therefore whose scheduled
 * cleanup is allowed to run.
 */
const W = 390;

function fakeEl() {
  return { offsetWidth: W, style: {} as Record<string, string> };
}

let timers: { id: number; fn: () => void; cancelled: boolean }[];
let nextId: number;

function runTimers() {
  for (const t of timers) if (!t.cancelled) t.fn();
  timers = [];
}

beforeEach(() => {
  timers = [];
  nextId = 1;
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void) => {
      const id = nextId++;
      timers.push({ id, fn, cancelled: false });
      return id;
    },
    clearTimeout: (id: number) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.cancelled = true;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const panel = fakeEl();
  const scrim = fakeEl();
  const off = registerSwipePanel("picker", {
    panel: panel as unknown as HTMLElement,
    scrim: () => scrim as unknown as HTMLElement,
    side: "left",
  });
  return { panel, scrim, off };
}

describe("beginPanelDrag", () => {
  it("suspends the class transition and parks the panel where it already is", () => {
    const { panel, scrim } = mount();
    beginPanelDrag("picker", true);
    expect(panel.style.transition).toBe("none");
    expect(scrim.style.transition).toBe("none");
    expect(panel.style.translate).toBe(`${-W}px`);
    expect(scrim.style.opacity).toBe("0");
  });

  it("writes `translate`, never `transform`", () => {
    // Tailwind v4 compiles -translate-x-full to the standalone property, so an
    // inline `transform` would sit beside the class and move nothing.
    const { panel } = mount();
    beginPanelDrag("picker", true)!.move(100);
    expect(panel.style.translate).toBe(`${-W + 100}px`);
    expect(panel.style.transform).toBeUndefined();
  });

  it("fades the scrim with the drag", () => {
    const { scrim } = mount();
    beginPanelDrag("picker", true)!.move(W / 2);
    expect(Number(scrim.style.opacity)).toBeCloseTo(0.5, 5);
  });

  it("hands the easing back and drives to the landing position on settle", () => {
    const { panel } = mount();
    const grip = beginPanelDrag("picker", true)!;
    grip.move(120);
    grip.settle(true);
    expect(panel.style.transition).toBe("");
    // Explicit, not cleared: React's re-render lands a tick later, and a cleared
    // inline value would let the old class position win for a frame.
    expect(panel.style.translate).toBe("0px");
  });

  it("reverts to where the drag began when it did not commit", () => {
    const { panel } = mount();
    const grip = beginPanelDrag("picker", true)!;
    grip.move(120);
    grip.settle(false);
    expect(panel.style.translate).toBe(`${-W}px`);
  });

  it("ignores a second settle, and any move after one", () => {
    const { panel } = mount();
    const grip = beginPanelDrag("picker", true)!;
    grip.settle(true);
    grip.move(200);
    grip.settle(false);
    expect(panel.style.translate).toBe("0px");
  });

  it("clears the inline values once the settle is over", () => {
    const { panel, scrim } = mount();
    beginPanelDrag("picker", true)!.settle(true);
    runTimers();
    expect(panel.style.translate).toBe("");
    expect(panel.style.willChange).toBe("");
    expect(scrim.style.opacity).toBe("");
  });

  it("does not let a finished gesture's cleanup wipe the NEXT one mid-drag", () => {
    // A swipe handed to a scroller settles and schedules its cleanup; the next
    // finger can easily be down again inside those 240ms. If that stale timer
    // runs, it clears the live drag's inline position while the transition is
    // suspended — the panel snapping to its class position for a frame.
    const { panel, scrim } = mount();
    beginPanelDrag("picker", true)!.settle(false);

    const second = beginPanelDrag("picker", true)!;
    second.move(150);
    const held = panel.style.translate;

    runTimers(); // whatever the first gesture left scheduled

    expect(panel.style.translate).toBe(held);
    expect(panel.style.translate).toBe(`${-W + 150}px`);
    expect(panel.style.willChange).toBe("translate");
    expect(scrim.style.opacity).not.toBe("");
  });

  it("drops a pending cleanup when the drawer unmounts under it", () => {
    const { off } = mount();
    beginPanelDrag("picker", true)!.settle(true);
    off();
    expect(timers.every((t) => t.cancelled)).toBe(true);
    // And the panel is gone, so there is nothing to grab.
    expect(beginPanelDrag("picker", true)).toBeNull();
  });

  it("refuses a panel that is not mounted, or has no width yet", () => {
    expect(beginPanelDrag("pane", false)).toBeNull();
    const panel = { offsetWidth: 0, style: {} as Record<string, string> };
    registerSwipePanel("pane", {
      panel: panel as unknown as HTMLElement,
      scrim: () => null,
      side: "right",
    });
    expect(beginPanelDrag("pane", false)).toBeNull();
  });

  it("parks a right-hand panel on the positive side", () => {
    const panel = fakeEl();
    registerSwipePanel("pane", {
      panel: panel as unknown as HTMLElement,
      scrim: () => null,
      side: "right",
    });
    beginPanelDrag("pane", false)!.move(-50);
    // Closing a right panel from open: it travels toward +W, so a leftward
    // finger is pulling it the wrong way and rubber-bands.
    const at = Number((panel.style.translate ?? "").replace("px", ""));
    expect(at).toBeLessThan(0);
    expect(at).toBeGreaterThan(-50);
  });
});
