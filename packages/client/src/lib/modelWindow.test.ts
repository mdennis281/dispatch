import { describe, expect, it } from "vitest";
import { modelContextWindow } from "./modelWindow.js";

describe("modelContextWindow", () => {
  it("gives Claude 200k, and 1M when the alias or the resolved id carries [1m]", () => {
    expect(modelContextWindow("claude", { value: "sonnet" })).toBe(200_000);
    expect(modelContextWindow("claude", { value: "opus[1m]" })).toBe(1_000_000);
    expect(
      modelContextWindow("claude", { value: "opus-1m", resolvedModel: "claude-opus-5-5[1m]" }),
    ).toBe(1_000_000);
  });

  it("gives every Codex row the catalogue's 272k", () => {
    expect(modelContextWindow("codex", { value: "gpt-6-astra" })).toBe(272_000);
  });

  it("refuses to guess for a provider whose windows vary by model", () => {
    expect(modelContextWindow("goose", { value: "qwen3-coder:30b" })).toBeUndefined();
  });
});
