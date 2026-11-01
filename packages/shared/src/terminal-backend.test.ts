import { describe, it, expect } from "vitest";
import { ChatSchema } from "./domain.js";
import { ManifestDefaultsSchema } from "./project-config.js";
import {
  TERMINAL_BACKEND_ID_PATTERN,
  TerminalBackendRefSchema,
  TerminalLocationsSchema,
  isReadableTerminalBackendId,
  terminalBackendPluginOf,
} from "./terminal-backend.js";

describe("qualified terminal backend ids (E12)", () => {
  it("accept `<pluginId>/<name>` beside bare ids, and name the plugin", () => {
    for (const ok of ["proxmox", "remote-host/cvx-mac", "a/b", `${"p".repeat(40)}/${"n".repeat(48)}`]) {
      expect(TERMINAL_BACKEND_ID_PATTERN.test(ok), ok).toBe(true);
      expect(isReadableTerminalBackendId(ok), ok).toBe(true);
    }
    for (const bad of ["/x", "x/", "a/b/c", "Remote/x", "remote host/x", `${"p".repeat(41)}/x`]) {
      expect(TERMINAL_BACKEND_ID_PATTERN.test(bad), bad).toBe(false);
    }
    expect(terminalBackendPluginOf("remote-host/cvx-mac")).toBe("remote-host");
    expect(terminalBackendPluginOf("proxmox")).toBeUndefined();
  });
});

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
