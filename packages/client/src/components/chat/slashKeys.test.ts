/**
 * Which keystrokes an open `/` menu claims.
 *
 * Worth its own file because the menu's handler runs BEFORE the composer's own
 * key handling, so anything it claims by mistake is a shortcut that silently
 * stops working — and one already did: `Ctrl+Enter`, the composer's only send
 * path, was swallowed by an Enter guard that only excluded Shift.
 */
import { describe, it, expect } from "vitest";
import { slashKeyAction } from "./useSlashCommands.js";

describe("slashKeyAction", () => {
  it("commits on a bare Enter and on Tab", () => {
    expect(slashKeyAction({ key: "Enter" })).toBe("commit");
    expect(slashKeyAction({ key: "Tab" })).toBe("commit");
  });

  it("lets the SEND shortcut through — it is the only way to send here", () => {
    // Plain Enter inserts a newline in this composer, so Ctrl/Cmd+Enter is the
    // send path. Claiming it made a fully-typed `/review` re-insert instead.
    expect(slashKeyAction({ key: "Enter", ctrlKey: true })).toBeNull();
    expect(slashKeyAction({ key: "Enter", metaKey: true })).toBeNull();
  });

  it("lets Shift+Enter and Alt+Enter through too", () => {
    expect(slashKeyAction({ key: "Enter", shiftKey: true })).toBeNull();
    expect(slashKeyAction({ key: "Enter", altKey: true })).toBeNull();
  });

  it("leaves Shift+Tab alone so reverse focus traversal still works", () => {
    expect(slashKeyAction({ key: "Tab", shiftKey: true })).toBeNull();
  });

  it("navigates and closes", () => {
    expect(slashKeyAction({ key: "ArrowDown" })).toBe("next");
    expect(slashKeyAction({ key: "ArrowUp" })).toBe("prev");
    expect(slashKeyAction({ key: "Escape" })).toBe("close");
  });

  it("claims nothing else — every other key is ordinary typing", () => {
    for (const key of ["a", "/", " ", "Backspace", "ArrowLeft", "Home", "PageDown"]) {
      expect(slashKeyAction({ key })).toBeNull();
    }
  });
});
