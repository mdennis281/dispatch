import { describe, it, expect } from "vitest";
import {
  INTEGRATION_FIXED_SCOPES,
  INTEGRATION_SCOPES,
  OFFERABLE_INTEGRATION_SCOPES,
  OFFERABLE_TOOL_CATEGORIES,
  OFFERABLE_TOOL_SCOPES,
  isIntegrationScope,
  isOfferableIntegrationScope,
  parseIntegrationScopes,
  toolScope,
} from "./integration.js";
import { MANAGER_CATEGORIES, MANAGER_TOOL_EXTERNAL, managerToolsInCategory } from "./manager-tools.js";

describe("offerable tool scopes", () => {
  it("are exactly the categories with at least one external tool", () => {
    const expected = MANAGER_CATEGORIES.filter((c) =>
      managerToolsInCategory(c).some((tool) => MANAGER_TOOL_EXTERNAL[tool]),
    );
    expect([...OFFERABLE_TOOL_CATEGORIES]).toEqual(expected);
    expect([...OFFERABLE_TOOL_SCOPES]).toEqual(expected.map(toolScope));
  });

  it("keep the registry's verdicts: chat is offered, session and workspace are not", () => {
    // `chat` is the point of an integration; `session` is the agent acting on
    // itself and `workspace` is its own shells — neither has a single external
    // tool, so a token scoped to them unlocks a 404.
    expect(OFFERABLE_TOOL_CATEGORIES).toContain("chat");
    expect(OFFERABLE_TOOL_CATEGORIES).not.toContain("session");
    expect(OFFERABLE_TOOL_CATEGORIES).not.toContain("workspace");
    expect(isOfferableIntegrationScope("tools:chat")).toBe(true);
    expect(isOfferableIntegrationScope("tools:session")).toBe(false);
  });

  it("are a strict subset of the valid scopes — a dead scope still parses", () => {
    // Validation stays wider than the offer on purpose: a token minted with
    // `tools:session` before the offer narrowed must still load and list.
    for (const scope of OFFERABLE_INTEGRATION_SCOPES) expect(isIntegrationScope(scope)).toBe(true);
    expect(OFFERABLE_INTEGRATION_SCOPES.length).toBeLessThan(INTEGRATION_SCOPES.length);
    expect(parseIntegrationScopes(["tools:session"])).toEqual({ ok: true, scopes: ["tools:session"] });
  });

  it("list the fixed scopes first, in the pane's order", () => {
    expect(OFFERABLE_INTEGRATION_SCOPES.slice(0, INTEGRATION_FIXED_SCOPES.length)).toEqual([
      ...INTEGRATION_FIXED_SCOPES,
    ]);
    for (const fixed of INTEGRATION_FIXED_SCOPES) expect(isOfferableIntegrationScope(fixed)).toBe(true);
  });
});
