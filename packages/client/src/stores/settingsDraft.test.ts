import { describe, expect, it } from "vitest";
import { chatDefaultsPatch, dirtyAppSections } from "./settingsDraft.js";
import type { AppSettings } from "../lib/api.js";

describe("chatDefaultsPatch — terminalLocations", () => {
  it("pins a list, pins [] (no choice here), and sends null to go back to inheriting", () => {
    expect(chatDefaultsPatch({}, { terminalLocations: ["local", "box"] })).toEqual({
      defaults: { terminalLocations: ["local", "box"] },
    });
    expect(chatDefaultsPatch({ terminalLocations: ["local", "box"] }, { terminalLocations: [] })).toEqual({
      defaults: { terminalLocations: [] },
    });
    // `undefined` would drop out of the JSON and the merging writer would keep
    // the old pin — the inherit choice would silently undo itself.
    expect(chatDefaultsPatch({ terminalLocations: ["box"] }, {})).toEqual({
      defaults: { terminalLocations: null },
    });
  });

  it("a rebuilt copy of the same list is not a change", () => {
    expect(chatDefaultsPatch({ terminalLocations: ["local", "box"] }, { terminalLocations: ["local", "box"] })).toEqual({});
  });
});

describe("dirtyAppSections — terminalLocations", () => {
  it("routes the app list to the Chat section's dot", () => {
    const saved = { theme: "dark" } as AppSettings;
    const draft = { theme: "dark", terminalLocations: ["local", "box"] } as AppSettings;
    expect([...dirtyAppSections({ saved, draft })]).toEqual(["chat"]);
  });
});
