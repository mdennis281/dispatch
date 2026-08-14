import { describe, expect, it } from "vitest";
import { presentationFilterCategory } from "./shellFilter.js";

describe("presentationFilterCategory", () => {
  it("keeps managed terminal output under the shell filter", () => {
    expect(presentationFilterCategory({
      kind: "dispatch",
      tool: "terminal_output",
      title: "Terminal output",
      activity: "Reading terminal",
      category: "terminal",
    })).toBe("shell");
  });
});
