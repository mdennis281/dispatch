/**
 * The back stack, as a table.
 *
 * Every entry here is a surface that can be on screen at `sm` and the one thing
 * "back" should mean from it. The stack is only representable as state (four
 * flags across two stores, most combinations legal), so the ordering between
 * them — sheet over picker over pane over transcript, homepage at the bottom —
 * is a rule that can regress without anything failing to compile.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { swipeMove, runSwipe } from "./swipeNav.js";
import type { NavPlace } from "./navState.js";
import { useLayout } from "../../stores/layout.js";
import { useView } from "../../stores/view.js";

/** The phone, on the transcript, nothing else open. */
const AT_CHAT: NavPlace = {
  mode: "sm",
  view: "chat",
  pane: "chat",
  leftOpen: false,
  moreOpen: false,
};

const at = (over: Partial<NavPlace>): NavPlace => ({ ...AT_CHAT, ...over });

describe("swipeMove — back", () => {
  it("opens the chat picker from the transcript", () => {
    expect(swipeMove(AT_CHAT, "back")).toBe("open-picker");
  });

  it("goes home from the chat picker", () => {
    expect(swipeMove(at({ leftOpen: true }), "back")).toBe("go-home");
  });

  it("stops at the homepage — it is the root, and does not wrap round", () => {
    expect(swipeMove(at({ view: "home" }), "back")).toBeNull();
  });

  it("closes a Ship/Run pane before it touches the picker", () => {
    expect(swipeMove(at({ pane: "run" }), "back")).toBe("close-pane");
    expect(swipeMove(at({ pane: "ship" }), "back")).toBe("close-pane");
  });

  it("unwinds the More sheet first — it is what's in front of you", () => {
    expect(swipeMove(at({ moreOpen: true, leftOpen: true }), "back")).toBe("close-more");
  });

  it("treats the sidebar's other destinations as children of the picker", () => {
    // Memory, Source Control, Files, the settings pages: all reached FROM the
    // list, so the list is where back goes.
    expect(swipeMove(at({ view: "memory" }), "back")).toBe("open-picker");
    expect(swipeMove(at({ view: "git" }), "back")).toBe("open-picker");
  });

  it("does not try to close a pane the homepage is covering", () => {
    // `goHome` deliberately leaves `pane` alone, so this combination is
    // reachable — and "close-pane" there would be a gesture that did nothing
    // visible at all.
    expect(swipeMove(at({ view: "home", pane: "run" }), "back")).toBeNull();
  });

  it("leaves the New Project form the way its own Back button does", () => {
    // `leftOpen` is deliberately still true here: "Add project" is reached FROM
    // the picker and doesn't dismiss it (Sidebar's `onAddProject`), so on this
    // full-bleed screen the flag describes a drawer `App` has unmounted. Reading
    // it before the view sent a back swipe to `goHome`, which unmounts the form
    // — and the form's name/path/workflow live in local state only.
    expect(swipeMove(at({ view: "new-project", leftOpen: true }), "back")).toBe(
      "leave-new-project",
    );
    expect(swipeMove(at({ view: "new-project" }), "back")).toBe("leave-new-project");
  });

  it("stands down above sm, where none of these surfaces are off-canvas", () => {
    expect(swipeMove(at({ mode: "md" }), "back")).toBeNull();
    expect(swipeMove(at({ mode: "lg" }), "back")).toBeNull();
  });
});

describe("swipeMove — forward", () => {
  it("re-enters the picker from the homepage, and the chat from the picker", () => {
    expect(swipeMove(at({ view: "home" }), "forward")).toBe("leave-home");
    expect(swipeMove(at({ leftOpen: true }), "forward")).toBe("close-picker");
  });

  it("does nothing from the transcript — the bottom of the stack", () => {
    expect(swipeMove(AT_CHAT, "forward")).toBeNull();
  });

  it("refuses to navigate out from under the More sheet", () => {
    expect(swipeMove(at({ moreOpen: true, view: "home" }), "forward")).toBeNull();
  });

  it("does nothing on the New Project form, stale picker flag and all", () => {
    // Otherwise this would "close" a picker that isn't on screen — a gesture
    // with no visible effect that leaves the list shut for when you come back.
    expect(swipeMove(at({ view: "new-project", leftOpen: true }), "forward")).toBeNull();
  });
});

describe("runSwipe", () => {
  beforeEach(() => {
    useLayout.setState({ mode: "sm", leftOpen: false, moreOpen: false, pane: "chat" });
    useView.setState({ view: "chat" });
  });

  it("opens and closes the picker", () => {
    runSwipe("open-picker");
    expect(useLayout.getState().leftOpen).toBe(true);
    runSwipe("close-picker");
    expect(useLayout.getState().leftOpen).toBe(false);
  });

  it("returns the New Project form to the chat surface, picker flag untouched", () => {
    useView.setState({ view: "new-project" });
    useLayout.setState({ leftOpen: true });
    runSwipe("leave-new-project");
    expect(useView.getState().view).toBe("chat");
    // Left as it was, so the form reached from the picker lands back on it.
    expect(useLayout.getState().leftOpen).toBe(true);
  });

  it("closes the More sheet and a pane", () => {
    useLayout.setState({ moreOpen: true, pane: "run" });
    runSwipe("close-more");
    expect(useLayout.getState().moreOpen).toBe(false);
    runSwipe("close-pane");
    expect(useLayout.getState().pane).toBe("chat");
  });

  it("takes the picker down with it on the way home", () => {
    // Otherwise the full-bleed homepage renders with `leftOpen` still set, and
    // the first Chats tap on the way back spends itself clearing an invisible
    // flag — the bug `goHome`'s own docblock describes.
    useLayout.setState({ leftOpen: true });
    runSwipe("go-home");
    expect(useView.getState().view).toBe("home");
    expect(useLayout.getState().leftOpen).toBe(false);
  });

  it("leaves the homepage for the chat list, which is the rung below it", () => {
    useView.setState({ view: "home" });
    runSwipe("leave-home");
    expect(useView.getState().view).toBe("chat");
    // The picker, not the bare transcript — forward walks the same rungs back
    // that back walked down, so the NEXT forward swipe is what opens the chat.
    expect(useLayout.getState().leftOpen).toBe(true);
    expect(swipeMove({ ...AT_CHAT, leftOpen: true }, "forward")).toBe("close-picker");
  });
});
