import { describe, expect, it } from "vitest";
import { clearFilterDim, toggleFilterValue } from "./metrics-filter.js";

type F = Partial<Record<"model" | "project", string[]>>;

describe("toggleFilterValue", () => {
  it("adds, then removes, a value without touching the input", () => {
    const start: F = { project: ["p"] };
    const added = toggleFilterValue(start, "model", "opus");
    expect(added).toEqual({ project: ["p"], model: ["opus"] });
    expect(start).toEqual({ project: ["p"] });
    expect(toggleFilterValue(added, "model", "sonnet")).toEqual({ project: ["p"], model: ["opus", "sonnet"] });
  });

  it("DELETES a dimension whose list empties — [] would mean match nothing", () => {
    const out = toggleFilterValue<"model" | "project">({ model: ["opus"] }, "model", "opus");
    expect(out).toEqual({});
    expect("model" in out).toBe(false);
  });
});

describe("clearFilterDim", () => {
  it("drops one dimension, or all of them", () => {
    const f: F = { model: ["opus"], project: ["p"] };
    expect(clearFilterDim(f, "model")).toEqual({ project: ["p"] });
    expect(clearFilterDim(f)).toEqual({});
    expect(f).toEqual({ model: ["opus"], project: ["p"] });
  });
});
