import { describe, it, expect } from "vitest";
import {
  applyRegistryQuery,
  matchesScope,
  matchesText,
  parseRegistryQuery,
  RegistryQueryError,
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

  it("rejects a malformed filter rather than coercing it", () => {
    // A scope we quietly "fixed" would answer a different question than the one
    // asked — for a scope, that means showing somebody else's rows. Routes turn
    // this into a 400.
    expect(() => parseRegistryQuery({ scope: "nope" })).toThrow(RegistryQueryError);
    expect(() => parseRegistryQuery({ since: "1.2" })).toThrow(RegistryQueryError);
    expect(() => parseRegistryQuery({ limit: "-4" })).toThrow(RegistryQueryError);
    expect(() => parseRegistryQuery({ limit: "99999" })).toThrow(RegistryQueryError);
    expect(() => parseRegistryQuery({ sort: "oldest" })).toThrow(RegistryQueryError);
    expect(() => parseRegistryQuery({ order: "up" })).toThrow(RegistryQueryError);
  });

  it("reads the facet flags, and rejects anything it can't read", () => {
    expect(parseRegistryQuery({ active: "1", archived: "false" })).toMatchObject({
      active: true,
      archived: false,
    });
    expect(parseRegistryQuery({ unmerged: "TRUE", unattributed: "0" })).toMatchObject({
      unmerged: true,
      unattributed: false,
    });
    expect(parseRegistryQuery({}).active).toBeUndefined();
    // `Boolean("no")` is `true` — which is exactly why this is a 400 instead.
    expect(() => parseRegistryQuery({ active: "no" })).toThrow(RegistryQueryError);
    expect(() => parseRegistryQuery({ unmerged: "yes" })).toThrow(RegistryQueryError);
  });

  it("takes real booleans from a programmatic caller unchanged", () => {
    expect(parseRegistryQuery({ active: true, archived: false })).toMatchObject({
      active: true,
      archived: false,
    });
  });

  it("leaves sort unset rather than defaulting it into the parsed query", () => {
    // The default is resolved where it's used, so a hand-built query never has
    // to restate a sort it doesn't care about.
    expect(parseRegistryQuery({}).sort).toBeUndefined();
    expect(parseRegistryQuery({ sort: "name", order: "desc" })).toMatchObject({
      sort: "name",
      order: "desc",
    });
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

  const names = (out: Array<{ name: string }>) => out.map((i) => i.name);

  it("sorts newest-first by default, and honours the other keys", () => {
    const sorted = { ...opts, createdAt: (i: (typeof items)[number]) => i.at, name: (i: (typeof items)[number]) => i.name };
    expect(names(applyRegistryQuery(items, RegistryQuerySchema.parse({}), sorted))).toEqual([
      "orphan",
      "test",
      "build",
    ]);
    expect(
      names(applyRegistryQuery(items, RegistryQuerySchema.parse({ sort: "recent", order: "asc" }), sorted)),
    ).toEqual(["build", "test", "orphan"]);
    // `name` reverses its default: A→Z is what a human means by "by name".
    expect(names(applyRegistryQuery(items, RegistryQuerySchema.parse({ sort: "name" }), sorted))).toEqual([
      "build",
      "orphan",
      "test",
    ]);
  });

  it("sorts BEFORE limiting, so `limit` means the newest N", () => {
    const out = applyRegistryQuery(items, RegistryQuerySchema.parse({ limit: 2 }), opts);
    expect(names(out)).toEqual(["orphan", "test"]);
  });

  it("sorts a record with no stamp last, whichever direction is asked", () => {
    const mixed = [{ name: "dated", at: 5 }, { name: "undated" }] as Array<{
      name: string;
      at?: number;
    }>;
    const o = { touchedAt: (i: (typeof mixed)[number]) => i.at };
    expect(names(applyRegistryQuery(mixed, RegistryQuerySchema.parse({}), o))).toEqual([
      "dated",
      "undated",
    ]);
    expect(
      names(applyRegistryQuery(mixed, RegistryQuerySchema.parse({ order: "asc" }), o)),
    ).toEqual(["dated", "undated"]);
  });

  it("leaves the order alone when the catalog can't supply the sort key", () => {
    const out = applyRegistryQuery(items, RegistryQuerySchema.parse({ sort: "created" }), opts);
    expect(names(out)).toEqual(["build", "test", "orphan"]);
  });

  it("applies a facet through the catalog's own accessor", () => {
    const withFacets = {
      ...opts,
      facets: { active: (i: (typeof items)[number]) => i.at >= 200 },
    };
    expect(
      names(applyRegistryQuery(items, RegistryQuerySchema.parse({ active: true }), withFacets)),
    ).toEqual(["orphan", "test"]);
    // `false` is a filter in its own right, not "unset".
    expect(
      names(applyRegistryQuery(items, RegistryQuerySchema.parse({ active: false }), withFacets)),
    ).toEqual(["build"]);
  });

  it("returns NOTHING for a facet the catalog can't answer — never silently drops it", () => {
    // Same class of mistake as a narrow scope with no id: answering an
    // unfiltered list would present it as a filtered one.
    expect(applyRegistryQuery(items, RegistryQuerySchema.parse({ unmerged: true }), opts)).toEqual([]);
    expect(applyRegistryQuery(items, RegistryQuerySchema.parse({ origin: "ui" }), opts)).toEqual([]);
  });

  it("matches `origin` exactly, through its accessor", () => {
    const withOrigin = { ...opts, origin: (i: (typeof items)[number]) => (i.at > 100 ? "ui" : "agent") };
    expect(
      names(applyRegistryQuery(items, RegistryQuerySchema.parse({ origin: "agent" }), withOrigin)),
    ).toEqual(["build"]);
  });
});
