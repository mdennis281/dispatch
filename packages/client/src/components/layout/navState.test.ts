/**
 * The bar's two rules: exactly one slot is lit, and it is the right one.
 *
 * These are the cases the old inline ternaries got wrong — a Chat slot that
 * stayed lit over the Memory view, a More slot that never lit at all — plus the
 * three-step Chats press, which is a state machine and therefore the one part of
 * the nav that can regress silently.
 */
import { describe, it, expect } from "vitest";
import { currentSlot, chatsAction, type NavPlace } from "./navState.js";

/** The phone, on the transcript, nothing else open. */
const AT_CHAT: NavPlace = {
  mode: "sm",
  view: "chat",
  pane: "chat",
  leftOpen: false,
  moreOpen: false,
};

const at = (over: Partial<NavPlace>): NavPlace => ({ ...AT_CHAT, ...over });

describe("currentSlot", () => {
  it("lights Chats on the bare transcript", () => {
    expect(currentSlot(AT_CHAT)).toBe("chats");
  });

  it("lights the pane slots when a panel has taken the main area", () => {
    expect(currentSlot(at({ pane: "ship" }))).toBe("ship");
    expect(currentSlot(at({ pane: "run" }))).toBe("run");
  });

  it("lights More while its sheet is up", () => {
    expect(currentSlot(at({ moreOpen: true }))).toBe("more");
  });

  it("keeps More lit on the destinations that sheet opens", () => {
    for (const view of ["memory", "git", "files", "metrics", "project-settings", "app-settings"] as const) {
      expect(currentSlot(at({ view }))).toBe("more");
    }
  });

  it("stops lighting Chats once a view has replaced the transcript", () => {
    // The bug this whole module exists for: `pane` is still "chat" here, and the
    // transcript is nowhere on screen.
    expect(currentSlot(at({ view: "memory", pane: "chat" }))).not.toBe("chats");
  });

  it("lights Chats while the picker is over the transcript", () => {
    expect(currentSlot(at({ leftOpen: true }))).toBe("chats");
  });

  it("prefers the sheet to the picker when both are somehow open", () => {
    // The sheet is the thing in front of you, so it's the thing the bar names.
    expect(currentSlot(at({ leftOpen: true, moreOpen: true }))).toBe("more");
  });

  it("lights nothing on project setup, which no slot stands for", () => {
    expect(currentSlot(at({ view: "new-project" }))).toBeNull();
  });

  it("resolves view-vs-pane rather than letting both answer", () => {
    // Representable and meaningless — only the view is on screen.
    expect(currentSlot(at({ view: "git", pane: "run" }))).toBe("more");
  });
});

describe("chatsAction", () => {
  it("opens the picker from the bare transcript", () => {
    expect(chatsAction(AT_CHAT)).toBe("open-picker");
  });

  it("closes it again on the next press", () => {
    expect(chatsAction(at({ leftOpen: true }))).toBe("close-picker");
  });

  it("returns to the transcript first from anywhere else", () => {
    expect(chatsAction(at({ view: "memory" }))).toBe("go-chat");
    expect(chatsAction(at({ pane: "run" }))).toBe("go-chat");
    expect(chatsAction(at({ moreOpen: true }))).toBe("go-chat");
  });

  it("runs the full three-press cycle from a non-chat screen", () => {
    // Press 1 from Memory: back to the transcript, no picker.
    let place = at({ view: "memory" });
    expect(chatsAction(place)).toBe("go-chat");
    place = at({ view: "chat", pane: "chat" });
    // Press 2: the picker.
    expect(chatsAction(place)).toBe("open-picker");
    place = at({ leftOpen: true });
    // Press 3: back to where you started.
    expect(chatsAction(place)).toBe("close-picker");
  });

  it("is a plain destination above sm, where the sidebar is an inline column", () => {
    for (const mode of ["md", "lg"] as const) {
      expect(chatsAction(at({ mode }))).toBe("go-chat");
      // Even carrying a stale flag from a narrower visit — there is no drawer
      // up there to toggle.
      expect(chatsAction(at({ mode, leftOpen: true }))).toBe("go-chat");
    }
  });
});
