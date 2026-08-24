import { describe, it, expect } from "vitest";
import {
  matchSlashCommands,
  toAuthoredName,
  isWritableScope,
  AUTHORED_SCOPES,
  type SlashCommandInfo,
} from "./authoring.js";

const cmd = (
  name: string,
  description?: string,
  aliases: string[] = [],
): SlashCommandInfo => ({ name, description, source: "builtin", aliases });

describe("matchSlashCommands", () => {
  const commands = [
    cmd("usage", "token usage", ["cost", "stats"]),
    cmd("skill-check", "verify a skill"),
    cmd("compact", "shrink the context"),
    cmd("review", "review the diff"),
  ];

  it("returns everything for an empty query, in the given order", () => {
    expect(matchSlashCommands(commands, "").map((c) => c.name)).toEqual([
      "usage",
      "skill-check",
      "compact",
      "review",
    ]);
  });

  it("ranks a name prefix above an alias, and an alias above an interior hit", () => {
    // "c" prefixes `compact`, is the head of `usage`'s `cost` alias, and sits
    // inside `skill-check`. `review` has no "c" anywhere and must not appear.
    expect(matchSlashCommands(commands, "c").map((c) => c.name)).toEqual([
      "compact",
      "usage",
      "skill-check",
    ]);
  });

  it("ranks a name hit above a description hit", () => {
    // "review" prefixes the command; `skill-check`'s description says "verify a
    // skill" — so a query of "skill" must lead with the NAME match.
    expect(matchSlashCommands(commands, "skill").map((c) => c.name)).toEqual(["skill-check"]);
  });

  it("matches a description when nothing matches the name", () => {
    expect(matchSlashCommands(commands, "diff").map((c) => c.name)).toEqual(["review"]);
  });

  it("is case-insensitive and trims", () => {
    expect(matchSlashCommands(commands, "  REV  ").map((c) => c.name)).toEqual(["review"]);
  });

  it("returns nothing rather than everything for a query nothing matches", () => {
    expect(matchSlashCommands(commands, "zzz")).toEqual([]);
  });

  it("breaks ties alphabetically so the order is stable between renders", () => {
    // All three contain "a"; only the first two are PREFIX matches, so `beta`
    // (an interior hit) sorts after them regardless of the alphabet.
    const ties = [cmd("beta"), cmd("apex"), cmd("alpha")];
    expect(matchSlashCommands(ties, "a").map((c) => c.name)).toEqual(["alpha", "apex", "beta"]);
  });
});

describe("toAuthoredName", () => {
  it("slugifies a human title into something usable as a path and a /command", () => {
    expect(toAuthoredName("Release Checklist")).toBe("release-checklist");
    expect(toAuthoredName("  How to: ship it!  ")).toBe("how-to-ship-it");
  });

  it("returns null when nothing legal survives, rather than an empty name", () => {
    expect(toAuthoredName("!!!")).toBeNull();
    expect(toAuthoredName("   ")).toBeNull();
  });

  it("stays fast on a long run of separators (no quadratic dash trim)", () => {
    // The `/^-+|-+$/g` this replaced was O(n^2) here — CodeQL js/polynomial-redos.
    // 200k separators is well under a millisecond with index arithmetic and
    // seconds with the regex, so the bound is generous and still catches a
    // regression that reintroduces backtracking.
    const started = performance.now();
    expect(toAuthoredName("-".repeat(200_000))).toBeNull();
    expect(toAuthoredName(`${"!".repeat(200_000)}ok`)).toBe("ok");
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("never leaves a trailing dash after the length clamp", () => {
    const long = toAuthoredName(`${"a".repeat(63)} b`);
    expect(long).toBe("a".repeat(63));
  });
});

describe("scopes", () => {
  it("orders broadest-first, which is the injection + materialization order", () => {
    expect(AUTHORED_SCOPES).toEqual(["shipped", "global", "project"]);
  });

  it("refuses `shipped` as a write target — an upgrade would overwrite it", () => {
    expect(isWritableScope("project")).toBe(true);
    expect(isWritableScope("global")).toBe(true);
    expect(isWritableScope("shipped")).toBe(false);
  });
});
