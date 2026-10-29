import { describe, expect, it } from "vitest";

import {
  VERBATIM_FLOOR,
  boundedEditDistance,
  compileQuery,
  normalizeText,
  significantTokens,
  stem,
  tokenize,
} from "./text-match.js";

const ANOXIA = "Anoxia: Continue without reload — modular seed loading";

const score = (query: string, text: string, typos = false): number =>
  compileQuery(query, { typos }).score(text)?.score ?? 0;

describe("normalizeText", () => {
  it("treats every dash, colon, underscore and slash as a space", () => {
    expect(normalizeText(ANOXIA)).toBe("anoxia continue without reload modular seed loading");
    expect(normalizeText("continue-without_reload/modular–seed")).toBe("continue without reload modular seed");
  });

  it("folds accents and case", () => {
    expect(normalizeText("Café  NAÏVE")).toBe("cafe naive");
  });
});

describe("tokenize / significantTokens", () => {
  it("drops short tokens and stopwords, but never everything", () => {
    expect(tokenize("a PR #421 is up")).toEqual(["pr", "421", "is", "up"]);
    expect(significantTokens("why is the lobby desyncing")).toEqual(["lobby", "desyncing"]);
    expect(significantTokens("how to")).toEqual(["how", "to"]);
  });

  it("stems inflections onto one form", () => {
    expect(stem("desyncing")).toBe(stem("desync"));
    expect(stem("queries")).toBe("query");
  });
});

describe("boundedEditDistance", () => {
  it("counts edits and transpositions up to the bound", () => {
    expect(boundedEditDistance("continue", "contnue", 2)).toBe(1);
    expect(boundedEditDistance("reload", "relaod", 2)).toBe(1); // transposition
    expect(boundedEditDistance("modular", "modulra", 1)).toBe(1);
  });

  it("gives up past the bound instead of computing the full table", () => {
    expect(boundedEditDistance("continue", "reload", 2)).toBe(3);
    expect(boundedEditDistance("a", "abcdef", 1)).toBe(2);
  });
});

describe("compileQuery — before/after", () => {
  // Each of these returned NO match under the old lowercase-substring rule.
  const misses: [string, number][] = [
    ["reload modular seed", 0.95], // em dash inside the span
    ["continue-without-reload", 1], // hyphens for spaces
    ["seed loading continue", 0.85], // reordered
    ["modular seeds", 0.95], // inflection
  ];
  it.each(misses)("%s now finds the Anoxia title", (q, atLeast) => {
    expect(ANOXIA.toLowerCase().includes(q.toLowerCase())).toBe(false);
    expect(score(q, ANOXIA)).toBeGreaterThanOrEqual(atLeast);
  });

  it("never reads the edit-distance 'too far' sentinel as a typo", () => {
    // Budget 1 for a 7-letter word returns 2 for "too far" — which once
    // credited every short title word as a two-edit typo of every query word.
    expect(score("modular-seed-loading", "Modular Helm Display Redesign", true)).toBeLessThan(0.4);
    expect(score("loading", "helm", true)).toBe(0);
  });

  it("tolerates typos on short fields, only when asked", () => {
    expect(score("contnue without relaod", ANOXIA)).toBeLessThan(0.4); // "without" alone
    expect(score("contnue without relaod", ANOXIA, true)).toBeGreaterThanOrEqual(0.75);
  });

  it("pins a contiguous phrase at 1 and a still-typing last word just under", () => {
    expect(score("continue without reload", ANOXIA)).toBe(1);
    expect(score("continue without relo", ANOXIA)).toBe(0.97);
  });

  it("keeps 1.0 for the phrase itself — a near-phrase never ties it", () => {
    const q = "where the load time goes";
    expect(score(q, "Anoxia: where the load time goes")).toBe(1);
    expect(score(q, "Anoxia: where the remaining load time goes")).toBeLessThan(1);
  });

  it("ranks the real title over a near-miss that shares one word", () => {
    const q = "continue without reload";
    expect(score(q, ANOXIA)).toBeGreaterThan(score(q, "Anoxia: where the load time goes") + 0.5);
    expect(score(q, "Anoxia: more initial-load speedups")).toBe(0);
  });

  it("scores a sprawl of the right words below the tight phrase", () => {
    const tight = score("release workflow", "fix the release workflow");
    const loose = score("release workflow", "release notes, then later the CI workflow");
    expect(tight).toBe(1);
    expect(loose).toBeLessThan(tight);
    expect(loose).toBeGreaterThan(0.8);
  });

  it("never loses a verbatim match the old rule found", () => {
    // Mid-word substring — no token boundary — still clears the floor.
    expect(score("elease", "prerelease build")).toBeGreaterThanOrEqual(VERBATIM_FLOOR);
    // A query with no word in it at all falls back to plain substring.
    expect(score("—", ANOXIA)).toBe(VERBATIM_FLOOR);
    expect(score("—", "no dash here")).toBe(0);
  });

  it("discounts stopwords so they can't carry a match on their own", () => {
    expect(score("the lobby", "the release")).toBeLessThan(0.2);
  });
});

describe("compileQuery — prefilter", () => {
  it("passes a raw JSON line only when every significant word is in it", () => {
    const m = compileQuery("reload modular seed");
    expect(m.prefilter(JSON.stringify({ text: ANOXIA }))).toBe(true);
    expect(m.prefilter(JSON.stringify({ text: "reload the modular page" }))).toBe(false);
  });

  it("lets through every inflection the scorer would credit as a stem match", () => {
    const m = compileQuery("query");
    expect(m.prefilter('{"text":"two queries ran"}')).toBe(true);
    expect(m.score("two queries ran")?.score).toBeGreaterThanOrEqual(0.9);
  });

  it("passes any verbatim occurrence, whatever the tokens say", () => {
    expect(compileQuery("café").prefilter('{"text":"le café"}')).toBe(true);
  });
});
