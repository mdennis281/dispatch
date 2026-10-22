/**
 * Scope chips hide a `tools:*` scope over a category with no external tool.
 * Static markup in the node environment, like the attribution tests.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OFFERABLE_TOOL_CATEGORIES } from "@dispatch/shared";
import { ScopeChips, renderableScopes } from "./ScopeChips.js";

describe("scope chips", () => {
  it("keep the fixed scopes and the live tools:* ones, in the given order", () => {
    expect(renderableScopes(["tools:chat", "chats:read"])).toEqual(["tools:chat", "chats:read"]);
  });

  it("drop a tools:* scope the registry says grants nothing", () => {
    // `session` and `workspace` have no external tool; a chip for them would
    // claim a power the mount answers 404 for.
    expect(OFFERABLE_TOOL_CATEGORIES).not.toContain("session");
    expect(renderableScopes(["chats:read", "tools:session", "tools:workspace"])).toEqual(["chats:read"]);
    const html = renderToStaticMarkup(<ScopeChips scopes={["chats:read", "tools:session", "tools:chat"]} />);
    expect(html).toContain("chats:read");
    expect(html).toContain("tools:chat");
    expect(html).not.toContain("tools:session");
  });
});
