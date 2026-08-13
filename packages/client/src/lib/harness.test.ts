import { describe, expect, it } from "vitest";
import { positiveTokenLimit } from "./harness.js";

describe("positiveTokenLimit", () => {
  it.each([
    [undefined, undefined],
    [0, undefined],
    [-1, undefined],
    [180_000, 180_000],
  ])("normalizes %s to %s", (input, expected) => {
    expect(positiveTokenLimit(input)).toBe(expected);
  });
});
