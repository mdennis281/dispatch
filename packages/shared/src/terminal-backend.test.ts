import { describe, it, expect } from "vitest";
import { ChatSchema } from "./domain.js";
import { ManifestDefaultsSchema } from "./project-config.js";
import {
  TERMINAL_BACKEND_ID_PATTERN,
  TerminalBackendRefSchema,
  TerminalLocationsSchema,
  isReadableTerminalBackendId,
} from "./terminal-backend.js";

// `future:box` stands for an id format a NEWER version writes to the config
// this one shares. Before E12a, reading one failed the whole file.
describe("persisted terminal backend ids are read loosely (E12a)", () => {
  it("parses an id this version could never register, and reports it unreadable", () => {
    expect(TERMINAL_BACKEND_ID_PATTERN.test("future:box")).toBe(false);
    expect(TerminalLocationsSchema.parse(["local", "box", "future:box"])).toEqual(["local", "box", "future:box"]);
    expect(ManifestDefaultsSchema.parse({ terminalBackend: "future:box" }).terminalBackend).toBe("future:box");
    expect(ChatSchema.shape.terminalBackend.parse("future:box")).toBe("future:box");

    expect(isReadableTerminalBackendId("future:box")).toBe(false);
    expect(isReadableTerminalBackendId("box")).toBe(true);
    expect(isReadableTerminalBackendId("local")).toBe(true);
  });

  it("still refuses what cannot be an id: empty, whitespace, a backtick, overlong", () => {
    for (const bad of ["", "a b", "x`y", "line\nbreak", "x".repeat(129)]) {
      expect(TerminalBackendRefSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
