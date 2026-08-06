import { describe, it, expect } from "vitest";
import { findModel, type ModelOption } from "./common.js";

/** A live-shaped list: aliases up front, several resolving to the same wire id. */
const MODELS: ModelOption[] = [
  { value: "default", label: "Default (recommended)", resolvedModel: "claude-opus-4-8[1m]" },
  { value: "opus[1m]", label: "Opus", resolvedModel: "claude-opus-4-8[1m]" },
  { value: "claude-fable-5[1m]", label: "Fable", resolvedModel: "claude-fable-5" },
  { value: "sonnet", label: "Sonnet", resolvedModel: "claude-sonnet-5" },
];

describe("findModel", () => {
  it("matches an exact alias", () => {
    expect(findModel(MODELS, "sonnet")?.label).toBe("Sonnet");
  });

  it("ignores a context-window suffix on either side", () => {
    expect(findModel(MODELS, "claude-fable-5")?.label).toBe("Fable");
    expect(findModel(MODELS, "opus")?.label).toBe("Opus");
  });

  it("resolves a persisted wire id through resolvedModel", () => {
    // What a chat pinned before the picker served aliases.
    expect(findModel(MODELS, "claude-sonnet-5")?.label).toBe("Sonnet");
  });

  it("prefers an exact alias hit over a resolvedModel hit", () => {
    // "default" is itself a row; it must not be shadowed by the Opus row that
    // resolves to the same wire id.
    expect(findModel(MODELS, "default")?.value).toBe("default");
  });

  it("returns a single row when several resolve to the same wire id", () => {
    // Both "default" and "opus[1m]" are claude-opus-4-8[1m]; first wins, so the
    // picker never marks two rows selected.
    expect(findModel(MODELS, "claude-opus-4-8")?.value).toBe("default");
  });

  it("returns undefined for a model the list doesn't cover", () => {
    expect(findModel(MODELS, "gpt-nonsense")).toBeUndefined();
  });
});
