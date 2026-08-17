import { describe, it, expect } from "vitest";
import {
  applyRegistryQuery,
  matchesScope,
  matchesText,
  parseRegistryQuery,
  RegistryQuerySchema,
} from "./registry.js";

describe("parseRegistryQuery", () => {
  it("infers the narrowest scope from the ids present", () => {
    expect(parseRegistryQuery({ chatId: "c1" }).scope).toBe("chat");
    expect(parseRegistryQuery({ projectId: "p1" }).scope).toBe("project");
    expect(parseRegistryQuery({}).scope).toBe("all");
    // chatId is narrower than projectId, so it wins the inference.
    expect(parseRegistryQuery({ chatId: "c1", projectId: "p1" }).scope).toBe("chat");
  });

  it("lets an explicit scope widen past the ids it was given", () => {
    const q = parseRegistryQuery({ scope: "all", chatId: "c1" });
    expect(q.scope).toBe("all");
    expect(q.chatId).toBe("c1");
  });

  it("treats an empty string as absent, not as a filter for ''", () => {
    const q = parseRegistryQuery({ q: "  ", chatId: "", projectId: "p1" });
    expect(q.q).toBeUndefined();
    expect(q.chatId).toBeUndefined();
    expect(q.scope).toBe("project");
  });

  it("coerces numbers and drops unparseable ones", () => {
    expect(parseRegistryQuery({ limit: "10", since: "1700" })).toMatchObject({
      limit: 10,
      since: 1700,
    });
    expect(parseRegistryQuery({ limit: "abc" }).limit).toBeUndefined();
  });

  it("reads a URLSearchParams the same way", () => {
    const q = parseRegistryQuery(new URLSearchParams("scope=project&projectId=p1&q=feat"));
    expect(q).toMatchObject({ scope: "project", projectId: "p1", q: "feat" });
  });
});

describe("matchesScope", () => {
  const rec = { projectId: "p1", chatId: "c1" };

  it("matches within scope", () => {
    expect(matchesScope(rec, RegistryQuerySchema.parse({ scope: "chat", chatId: "c1" }))).toBe(true);
    expect(
      matchesScope(rec, RegistryQuerySchema.parse({ scope: "project", projectId: "p1" })),
    ).toBe(true);
    expect(matchesScope(rec, RegistryQuerySchema.parse({ scope: "all" }))).toBe(true);
  });

  it("returns NOTHING for a narrow scope with no id — never silently widens", () => {
    expect(matchesScope(rec, RegistryQuerySchema.parse({ scope: "chat" }))).toBe(false);
    expect(matchesScope(rec, RegistryQuerySchema.parse({ scope: "project" }))).toBe(false);
  });

  it("excludes an unattributed record from a chat scope", () => {
    expect(
      matchesScope({ projectId: "p1" }, RegistryQuerySchema.parse({ scope: "chat", chatId: "c1" })),
    ).toBe(false);
  });
});

describe("matchesText", () => {
  it("matches case-insensitively on any field", () => {
    expect(matchesText(["/wt/Feat-X", "feat/x"], "FEAT-x")).toBe(true);
    expect(matchesText(["/wt/feat-x"], "nope")).toBe(false);
  });

  it("matches everything when the needle is empty or absent", () => {
    expect(matchesText(["anything"], undefined)).toBe(true);
    expect(matchesText(["anything"], "   ")).toBe(true);
    expect(matchesText([undefined], undefined)).toBe(true);
  });
});

describe("applyRegistryQuery", () => {
  const items = [
    { projectId: "p1", chatId: "c1", name: "build", at: 100 },
    { projectId: "p1", chatId: "c2", name: "test", at: 200 },
    { projectId: "p2", name: "orphan", at: 300 },
  ];
  const opts = {
    text: (i: (typeof items)[number]) => [i.name],
    touchedAt: (i: (typeof items)[number]) => i.at,
  };

  it("combines scope, text, since and limit", () => {
    expect(
      applyRegistryQuery(items, RegistryQuerySchema.parse({ scope: "project", projectId: "p1" }), opts),
    ).toHaveLength(2);
    expect(
      applyRegistryQuery(items, RegistryQuerySchema.parse({ scope: "all", q: "orph" }), opts),
    ).toHaveLength(1);
    expect(
      applyRegistryQuery(items, RegistryQuerySchema.parse({ scope: "all", since: 200 }), opts),
    ).toHaveLength(2);
    expect(
      applyRegistryQuery(items, RegistryQuerySchema.parse({ scope: "all", limit: 1 }), opts),
    ).toHaveLength(1);
  });

  it("drops a record with no recency stamp when `since` is asked for", () => {
    const out = applyRegistryQuery(items, RegistryQuerySchema.parse({ scope: "all", since: 1 }), {
      touchedAt: () => undefined,
    });
    expect(out).toEqual([]);
  });
});
