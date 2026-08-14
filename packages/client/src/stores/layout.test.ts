/**
 * The two breakpoint transitions that are wrong by default.
 *
 * Both are the same class of bug — state that was correct for the mode you were
 * in and is nonsense in the mode you land in — and both are the reason the rules
 * live inside `setMode` rather than in a component effect. An effect fires once
 * per subscribed component, so these invariants would be re-applied N times per
 * resize and would fight anything that legitimately changed them in between.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useLayout, PANEL_GROUP } from "./layout.js";

function reset(): void {
  useLayout.setState({ mode: "lg", leftOpen: false, pane: "chat", panelTab: "worktrees" });
}

describe("layout store", () => {
  beforeEach(reset);

  it("closes the left drawer when an inline sidebar becomes one (md -> sm)", () => {
    useLayout.setState({ mode: "md", leftOpen: true });
    useLayout.getState().setMode("sm");
    expect(useLayout.getState().leftOpen).toBe(false);
  });

  it("closes the left drawer on any other crossing too, so a stale flag can't survive one", () => {
    useLayout.setState({ mode: "sm", leftOpen: true });
    useLayout.getState().setMode("lg");
    useLayout.getState().setMode("sm");
    expect(useLayout.getState().leftOpen).toBe(false);
  });

  it("returns to the transcript when the panels become inline (sm -> lg)", () => {
    useLayout.setState({ mode: "sm" });
    useLayout.getState().setPane("run");
    expect(useLayout.getState().pane).toBe("run");
    useLayout.getState().setMode("lg");
    // A stranded "run" pane at lg would hide the transcript behind a panel that
    // is already sitting beside it.
    expect(useLayout.getState().pane).toBe("chat");
  });

  it("keeps the pane below lg, where it is still the thing on screen", () => {
    useLayout.setState({ mode: "sm" });
    useLayout.getState().setPane("ship");
    useLayout.getState().setMode("md");
    expect(useLayout.getState().pane).toBe("ship");
  });

  it("is a no-op when the mode has not actually changed", () => {
    useLayout.setState({ mode: "sm", leftOpen: true });
    useLayout.getState().setMode("sm");
    expect(useLayout.getState().leftOpen).toBe(true);
  });

  it("derives the pane from the selected tab, so a deep link can't land on a hidden one", () => {
    useLayout.setState({ mode: "sm" });
    useLayout.getState().setPanelTab("terminals");
    expect(PANEL_GROUP.terminals).toBe("run");
    expect(useLayout.getState().pane).toBe("run");
  });

  it("leaves the pane alone at lg, where the panel is inline and the pane isn't in play", () => {
    useLayout.getState().setPanelTab("terminals");
    expect(useLayout.getState().panelTab).toBe("terminals");
    expect(useLayout.getState().pane).toBe("chat");
  });

  it("moves the tab into the group when a pane is chosen from the nav", () => {
    useLayout.setState({ mode: "sm", panelTab: "terminals" });
    useLayout.getState().setPane("ship");
    expect(useLayout.getState().panelTab).toBe("worktrees");
  });

  it("keeps the tab when the chosen pane is already its group", () => {
    useLayout.setState({ mode: "sm", panelTab: "terminals" });
    useLayout.getState().setPane("run");
    expect(useLayout.getState().panelTab).toBe("terminals");
  });
});
