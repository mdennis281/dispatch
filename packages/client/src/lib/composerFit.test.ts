import { describe, it, expect } from "vitest";
import { demote, promote, reconcile, widestSizes, evictedCount } from "./composerFit.js";
import { ALL_VISIBLE, COMPOSER_CONTROLS, type ComposerVisibility } from "./composerPrefs.js";

const none: ComposerVisibility = Object.fromEntries(
  COMPOSER_CONTROLS.map((c) => [c.id, false]),
) as ComposerVisibility;

/** Walk the row all the way down, collecting every state it passes through. */
function walkDown(visible: ComposerVisibility) {
  const states = [widestSizes(visible)];
  for (;;) {
    const next = demote(states[states.length - 1]!, visible);
    if (!next) return states;
    states.push(next);
    if (states.length > 64) throw new Error("demote did not terminate");
  }
}

describe("widestSizes", () => {
  it("starts every visible control at the top of its own ladder", () => {
    const s = widestSizes(ALL_VISIBLE);
    expect(s.mode).toBe("lg");
    expect(s.brain).toBe("lg");
    expect(s.effort).toBe("lg");
    // The controls with no wide form start where their ladder starts, not at `lg`.
    expect(s.context).toBe("md");
    expect(s.attach).toBe("sm");
    expect(s.dictate).toBe("sm");
  });

  it("leaves hidden controls off", () => {
    expect(widestSizes({ ...ALL_VISIBLE, brain: false }).brain).toBe("off");
  });
});

describe("demote", () => {
  it("levels the row down before dropping anything from it", () => {
    // The invariant that makes the layout feel considered rather than arbitrary:
    // no control is ever evicted while another still wears a label.
    for (const s of walkDown(ALL_VISIBLE)) {
      const anyEvicted = COMPOSER_CONTROLS.some((c) => s[c.id] === "off");
      const anyLarge = COMPOSER_CONTROLS.some((c) => s[c.id] === "lg" || s[c.id] === "md");
      expect(anyEvicted && anyLarge).toBe(false);
    }
  });

  it("shrinks the biggest control first", () => {
    const first = demote(widestSizes(ALL_VISIBLE), ALL_VISIBLE)!;
    // Everything at `lg` is tied for biggest, so priority breaks it: effort
    // (3) is the lowest-priority `lg` control, below brain (4) and mode (5).
    expect(first.effort).toBe("md");
    expect(first.brain).toBe("lg");
    expect(first.mode).toBe("lg");
    expect(first.context).toBe("md");
  });

  it("evicts by ascending priority once everything is an icon", () => {
    const states = walkDown(ALL_VISIBLE);
    const order: string[] = [];
    for (let i = 1; i < states.length; i++) {
      for (const c of COMPOSER_CONTROLS) {
        if (states[i]![c.id] === "off" && states[i - 1]![c.id] !== "off") order.push(c.id);
      }
    }
    // context(1) → attach(2) → effort(3) → brain(4) → mode(5) → dictate(6).
    expect(order).toEqual(["context", "attach", "effort", "brain", "mode", "dictate"]);
  });

  it("bottoms out with everything off rather than looping", () => {
    const states = walkDown(ALL_VISIBLE);
    const last = states[states.length - 1]!;
    expect(COMPOSER_CONTROLS.every((c) => last[c.id] === "off")).toBe(true);
    expect(demote(last, ALL_VISIBLE)).toBeNull();
  });

  it("never touches a hidden control", () => {
    const visible = { ...ALL_VISIBLE, brain: false };
    for (const s of walkDown(visible)) expect(s.brain).toBe("off");
  });

  it("has nothing to do when nothing is visible", () => {
    expect(demote(widestSizes(none), none)).toBeNull();
  });
});

describe("promote", () => {
  it("exactly reverses demote, so a widening window unwinds in order", () => {
    const states = walkDown(ALL_VISIBLE);
    for (let i = states.length - 1; i > 0; i--) {
      expect(promote(states[i]!, ALL_VISIBLE)).toEqual(states[i - 1]);
    }
  });

  it("stops at the widest layout", () => {
    expect(promote(widestSizes(ALL_VISIBLE), ALL_VISIBLE)).toBeNull();
  });

  it("brings an evicted control back at its smallest, not its widest", () => {
    const sizes = { ...widestSizes(ALL_VISIBLE), context: "off" as const };
    expect(promote(sizes, ALL_VISIBLE)!.context).toBe("sm");
  });
});

describe("reconcile", () => {
  it("switches a control off without disturbing its neighbours", () => {
    const sizes = { ...widestSizes(ALL_VISIBLE), effort: "sm" as const };
    const next = reconcile(sizes, { ...ALL_VISIBLE, brain: false });
    expect(next.brain).toBe("off");
    expect(next.effort).toBe("sm");
  });

  it("brings a re-enabled control back at its widest for the loop to shrink", () => {
    const off = widestSizes({ ...ALL_VISIBLE, brain: false });
    expect(reconcile(off, ALL_VISIBLE).brain).toBe("lg");
  });

  it("returns the same object when nothing changed, so setState can no-op", () => {
    const sizes = widestSizes(ALL_VISIBLE);
    expect(reconcile(sizes, ALL_VISIBLE)).toBe(sizes);
  });
});

describe("evictedCount", () => {
  it("counts only controls you asked for and did not get", () => {
    const sizes = { ...widestSizes(ALL_VISIBLE), context: "off" as const, brain: "off" as const };
    expect(evictedCount(sizes, ALL_VISIBLE)).toBe(2);
    // A control you switched off yourself is not an eviction — you have it
    // exactly as you asked, so the menu must not nag about it.
    expect(evictedCount(sizes, { ...ALL_VISIBLE, brain: false })).toBe(1);
  });
});
