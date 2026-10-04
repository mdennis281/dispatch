import { describe, it, expect } from "vitest";
import { slideDirection } from "./viewSlide.js";

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
    for (const v of ["memory", "git", "files", "metrics", "app-settings"] as const) {
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
