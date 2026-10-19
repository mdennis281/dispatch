import { describe, it, expect, afterEach } from "vitest";
import { runViewSlide, slideDirection } from "./viewSlide.js";

/**
 * The travel itself needs a DOM (and a browser with View Transitions) and this
 * suite is node-environment by design, so what is asserted here is the stack
 * order the slide reads its direction from. The motion is verified by eye — see
 * the clip on the PR.
 */
describe("slideDirection", () => {
  it("goes BACK to the homepage and FORWARD out of it", () => {
    expect(slideDirection("chat", "home")).toBe("back");
    expect(slideDirection("home", "chat")).toBe("forward");
  });

  it("treats the setup form as a rung ABOVE the chat, which is above home", () => {
    // Same order swipeNav walks: back out of the form lands on the chat, back
    // out of the chat lands home.
    expect(slideDirection("chat", "new-project")).toBe("forward");
    expect(slideDirection("new-project", "chat")).toBe("back");
    expect(slideDirection("home", "new-project")).toBe("forward");
    expect(slideDirection("new-project", "home")).toBe("back");
  });

  it("leaves home for any shell view the same way it leaves for the chat", () => {
    // The palette can land you on Metrics from the homepage; that is the same
    // journey as landing on the transcript, and must not travel the other way.
    for (const v of ["memory", "git", "ci", "files", "metrics", "app-settings"] as const) {
      expect(slideDirection("home", v)).toBe("forward");
      expect(slideDirection(v, "home")).toBe("back");
    }
  });

  it("does not travel between views inside the shell", () => {
    // These swap one panel, not the whole window — they never read as a cut.
    expect(slideDirection("git", "files")).toBeNull();
    expect(slideDirection("chat", "metrics")).toBeNull();
    expect(slideDirection("project-settings", "app-settings")).toBeNull();
  });

  it("does not travel when the view did not change", () => {
    expect(slideDirection("home", "home")).toBeNull();
    expect(slideDirection("chat", "chat")).toBeNull();
  });
});

describe("runViewSlide", () => {
  const realDocument = globalThis.document;
  afterEach(() => {
    (globalThis as { document?: unknown }).document = realDocument;
  });

  it("leaves the direction set while a LATER same-way slide is still pending", async () => {
    // `data-cm-nav` is what names the travelling surface, so clearing it early
    // turns the next slide into a hard cut. A skipped transition resolves
    // `finished` before its successor snapshots, and both say "forward" — so
    // a direction match is not enough to know the attribute is still ours.
    const finishers: Array<() => void> = [];
    const dataset: Record<string, string> = {};
    (globalThis as { document?: unknown }).document = {
      documentElement: { dataset },
      startViewTransition: (cb: () => void) => {
        cb();
        return { finished: new Promise<void>((r) => finishers.push(r)) };
      },
    };

    runViewSlide("forward", () => {});
    runViewSlide("forward", () => {});
    finishers[0]!(); // the first one is skipped
    await Promise.resolve();
    await Promise.resolve();
    expect(dataset.cmNav).toBe("forward");

    finishers[1]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(dataset.cmNav).toBeUndefined();
  });
});
