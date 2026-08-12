import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import type { WsServerEvent } from "@dispatch/shared";
import { MemoryService, clusterAreas, scoreCorpus } from "./memory.js";
import type { ProjectMemory } from "@dispatch/shared";

let dir: string;
let store: Store;
let bus: EventBus;
let events: WsServerEvent[];
let memory: MemoryService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-memory-"));
  store = new Store(dir);
  await store.init();
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  let clock = 1000;
  memory = new MemoryService({ store, bus, now: () => ++clock });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Read the generated MEMORY.md index for a project (or "" when absent). */
async function indexFile(projectId: string): Promise<string> {
  const path = join(store.projectMemoryDir(projectId), "MEMORY.md");
  return existsSync(path) ? readFile(path, "utf8") : "";
}

describe("MemoryService — create / read / list", () => {
  it("writes a memory file + index and reads it back with frontmatter intact", async () => {
    const saved = await memory.write("p1", {
      name: "deploy-runbook",
      description: "How we ship to prod",
      type: "project",
      body: "Run `pnpm ship`, wait for CI, the bot merges.",
    });
    expect(saved).toMatchObject({
      projectId: "p1",
      name: "deploy-runbook",
      type: "project",
      file: "deploy-runbook.md",
    });

    const list = await memory.list("p1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: "deploy-runbook",
      description: "How we ship to prod",
      body: "Run `pnpm ship`, wait for CI, the bot merges.",
    });

    const single = await memory.read("p1", "deploy-runbook");
    expect(single?.body).toContain("pnpm ship");

    // The generated index has one line for the memory.
    expect(await indexFile("p1")).toContain("- [deploy-runbook](deploy-runbook.md) — How we ship to prod");

    // A memory-update event fired.
    expect(events.some((e) => e.type === "memory-update" && e.memory.name === "deploy-runbook")).toBe(true);
  });

  it("slugifies a free-text name and dedupes by slug (update, not duplicate)", async () => {
    await memory.write("p1", { name: "My Cool Fact", description: "v1", type: "user", body: "first" });
    // A name that slugs to the SAME identity updates in place.
    await memory.write("p1", { name: "my cool fact", description: "v2", type: "feedback", body: "second" });

    const list = await memory.list("p1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      name: "my-cool-fact",
      description: "v2",
      type: "feedback",
      body: "second",
    });
  });

  it("rejects an empty / punctuation-only name", async () => {
    await expect(memory.write("p1", { name: "  ", description: "x", type: "project", body: "b" })).rejects.toBeTruthy();
    await expect(memory.write("p1", { name: "!!!", description: "x", type: "project", body: "b" })).rejects.toBeTruthy();
  });

  it("scopes memories per project", async () => {
    await memory.write("p1", { name: "a", description: "", type: "project", body: "in p1" });
    await memory.write("p2", { name: "b", description: "", type: "project", body: "in p2" });
    expect((await memory.list("p1")).map((m) => m.name)).toEqual(["a"]);
    expect((await memory.list("p2")).map((m) => m.name)).toEqual(["b"]);
  });
});

describe("MemoryService — delete + index regen", () => {
  it("deletes a memory, regenerates the index, and emits memory-deleted", async () => {
    await memory.write("p1", { name: "keep", description: "stays", type: "project", body: "1" });
    await memory.write("p1", { name: "drop", description: "goes", type: "project", body: "2" });

    // Index lists both, sorted by name.
    const before = await indexFile("p1");
    expect(before).toContain("[drop](drop.md)");
    expect(before).toContain("[keep](keep.md)");
    expect(before.indexOf("drop")).toBeLessThan(before.indexOf("keep"));

    const removed = await memory.delete("p1", "drop");
    expect(removed).toBe(true);

    const list = await memory.list("p1");
    expect(list.map((m) => m.name)).toEqual(["keep"]);
    // Index no longer lists the deleted memory.
    expect(await indexFile("p1")).not.toContain("drop.md");

    expect(events.some((e) => e.type === "memory-deleted" && e.name === "drop")).toBe(true);
  });

  it("delete of a missing memory returns false (no event)", async () => {
    expect(await memory.delete("p1", "ghost")).toBe(false);
    expect(events.some((e) => e.type === "memory-deleted")).toBe(false);
  });
});

describe("MemoryService — injection + recall", () => {
  it("buildInjection returns null for an empty project and the index+descriptions when populated", async () => {
    expect(await memory.buildInjection("p1")).toBeNull();

    await memory.write("p1", { name: "one", description: "first fact", type: "project", body: "body 1" });
    await memory.write("p1", { name: "two", description: "second fact", type: "reference", body: "body 2" });

    const injection = await memory.buildInjection("p1");
    expect(injection).toBeTruthy();
    expect(injection).toContain("Project memory");
    // Grouped by type, one-line per memory (name + description).
    expect(injection).toContain("`one` — first fact");
    expect(injection).toContain("`two` — second fact");
    // Bounded — the full body is NOT injected.
    expect(injection).not.toContain("body 1");
    expect(injection).toContain("mcp__manager__recall");
  });

  it("recall returns the index with no query and matching bodies with a query", async () => {
    await memory.write("p1", { name: "alpha", description: "about the build", type: "project", body: "BUILD DETAIL" });
    await memory.write("p1", { name: "beta", description: "about deploys", type: "project", body: "DEPLOY DETAIL" });

    const all = await memory.recall("p1");
    expect(all.matches).toHaveLength(0);
    expect(all.index).toContain("[alpha](alpha.md)");

    const hit = await memory.recall("p1", "deploy");
    expect(hit.matches.map((m) => m.name)).toEqual(["beta"]);
    expect(hit.matches[0]?.body).toBe("DEPLOY DETAIL");
  });

  it("ranks matches: a name hit outranks a body-only hit", async () => {
    await memory.write("p1", { name: "deploy-runbook", description: "shipping steps", type: "project", body: "steps" });
    await memory.write("p1", { name: "misc", description: "notes", type: "project", body: "mentions deploy once" });

    const ranked = await memory.search("p1", "deploy");
    expect(ranked.map((m) => m.name)).toEqual(["deploy-runbook", "misc"]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("expandLinks pulls in [[wikilink]] neighbours of a match (marked linked)", async () => {
    await memory.write("p1", { name: "auth-flow", description: "how auth works", type: "project", body: "see [[token-store]]" });
    await memory.write("p1", { name: "token-store", description: "where tokens live", type: "project", body: "redis" });

    const ranked = await memory.search("p1", "auth", { expandLinks: true });
    const byName = new Map(ranked.map((m) => [m.name, m]));
    expect(byName.has("auth-flow")).toBe(true);
    expect(byName.get("token-store")?.linked).toBe(true);
  });

  it("recall can restrict to one type", async () => {
    await memory.write("p1", { name: "pref-x", description: "wants tabs", type: "user", body: "tabs" });
    await memory.write("p1", { name: "fact-x", description: "uses tabs", type: "project", body: "tabs" });

    const hit = await memory.recall("p1", "tabs", { type: "user" });
    expect(hit.matches.map((m) => m.name)).toEqual(["pref-x"]);
  });

  it("surfaceFor returns a system-reminder block once per memory (respects exclude)", async () => {
    await memory.write("p1", { name: "deploy-runbook", description: "how we ship to prod", type: "project", body: "run the pipeline" });

    const first = await memory.surfaceFor("p1", "how do we deploy to prod?");
    expect(first).not.toBeNull();
    expect(first!.block).toContain("<system-reminder>");
    expect(first!.block).toContain("run the pipeline");
    expect(first!.names).toEqual(["deploy-runbook"]);

    // Already surfaced → excluded → nothing to push again.
    const again = await memory.surfaceFor("p1", "how do we deploy to prod?", {
      exclude: new Set(first!.names),
    });
    expect(again).toBeNull();
  });

  it("surfaceFor stays quiet for an irrelevant turn", async () => {
    await memory.write("p1", { name: "deploy-runbook", description: "how we ship to prod", type: "project", body: "pipeline" });
    expect(await memory.surfaceFor("p1", "what colour is the sky")).toBeNull();
  });

  it("persists updatedAt into the frontmatter and reads it back", async () => {
    const written = await memory.write("p1", { name: "stamped", description: "d", type: "project", body: "b" });
    expect(written.updatedAt).toBeTypeOf("number");
    const reread = await memory.read("p1", "stamped");
    expect(reread?.updatedAt).toBe(written.updatedAt);
  });
});

describe("MemoryService — tiered injection (rules vs facts)", () => {
  it("injects standing rules in full (user before feedback) and never a fact body", async () => {
    await memory.write("p1", { name: "always-watch-prs", description: "watch PRs to merge", type: "feedback", body: "FEEDBACK BODY: after shipping, watch it through." });
    await memory.write("p1", { name: "michael-iterates", description: "iterates and reverts", type: "user", body: "USER BODY: expect churn." });
    await memory.write("p1", { name: "steam-login", description: "how steam login works", type: "project", body: "FACT BODY should never inject" });

    const inj = (await memory.buildInjection("p1"))!;
    expect(inj).toContain("### Standing rules & preferences");
    // Rules carry their (clamped) bodies…
    expect(inj).toContain("**michael-iterates** — iterates and reverts");
    expect(inj).toContain("USER BODY: expect churn.");
    expect(inj).toContain("FEEDBACK BODY: after shipping");
    // …ordered user before feedback.
    expect(inj.indexOf("michael-iterates")).toBeLessThan(inj.indexOf("always-watch-prs"));
    // A lookup fact's BODY is never injected (only its name/description in the sample).
    expect(inj).not.toContain("FACT BODY should never inject");
  });

  it("caps the facts sample so a large catalogue can't flood; the topic map still counts all", async () => {
    // 8 facts written oldest→newest across 3 areas; sample caps at 6.
    for (const n of ["a-1", "a-2", "a-3", "b-1", "b-2", "c-1", "c-2", "c-3"]) {
      await memory.write("p1", { name: n, description: `d ${n}`, type: "project", body: "x" });
    }
    const inj = (await memory.buildInjection("p1"))!;
    expect(inj).toContain("8 recorded facts");
    expect(inj).toContain("Recently recorded:"); // nothing accessed yet
    // Newest 6 shown as one-liners; the two OLDEST are omitted from the sample…
    expect(inj).toContain("`c-3` — d c-3");
    expect(inj).not.toContain("`a-1` — d a-1");
    expect(inj).not.toContain("`a-2` — d a-2");
    // …but the area map counts every fact.
    expect(inj).toContain("a (3)");
    expect(inj).toContain("c (3)");
  });

  it("omits the rules section when there are none and the facts section when there are none", async () => {
    await memory.write("p1", { name: "only-fact", description: "a fact", type: "project", body: "b" });
    let inj = (await memory.buildInjection("p1"))!;
    expect(inj).not.toContain("Standing rules");
    expect(inj).toContain("Recorded facts");

    await memory.delete("p1", "only-fact");
    await memory.write("p1", { name: "only-rule", description: "a rule", type: "feedback", body: "b" });
    inj = (await memory.buildInjection("p1"))!;
    expect(inj).toContain("Standing rules");
    expect(inj).not.toContain("Recorded facts");
  });
});

describe("MemoryService — access telemetry (usefulness ranking)", () => {
  it("recall records a 'recalled' hit that flips the sample label + ordering", async () => {
    // 'often' written FIRST (older) so recency alone would rank 'seldom' ahead.
    await memory.write("p1", { name: "often", description: "always needed", type: "project", body: "often UNIQUEQ body" });
    await memory.write("p1", { name: "seldom", description: "rarely needed", type: "project", body: "seldom body" });

    const before = (await memory.buildInjection("p1"))!;
    expect(before).toContain("Recently recorded:");
    expect(before.indexOf("`seldom`")).toBeLessThan(before.indexOf("`often`"));

    const hit = await memory.recall("p1", "UNIQUEQ");
    expect(hit.matches.map((m) => m.name)).toEqual(["often"]);

    const after = (await memory.buildInjection("p1"))!;
    expect(after).toContain("Most-used lately:");
    expect(after.indexOf("`often`")).toBeLessThan(after.indexOf("`seldom`"));

    const stats = await memory.accessStats("p1");
    expect(stats["often"]?.recalled).toBe(1);
    expect(stats["seldom"]).toBeUndefined();
  });

  it("surfaceFor records a 'surfaced' hit", async () => {
    await memory.write("p1", { name: "deploy-runbook", description: "how we ship to prod", type: "project", body: "run the pipeline" });
    expect(await memory.surfaceFor("p1", "how do we deploy to prod?")).not.toBeNull();
    const stats = await memory.accessStats("p1");
    expect(stats["deploy-runbook"]?.surfaced).toBe(1);
  });

  it("usefulness breaks a score tie toward the recalled memory", async () => {
    // Identical-scoring bodies; one gets recalled and should then rank first.
    await memory.write("p1", { name: "tie-a", description: "shared word deploy", type: "project", body: "b" });
    await memory.write("p1", { name: "tie-b", description: "shared word deploy", type: "project", body: "b" });
    // Recall tie-b by name so only it earns a hit.
    await memory.recall("p1", "tie-b");
    const ranked = await memory.search("p1", "deploy");
    expect(ranked[0]?.name).toBe("tie-b");
  });

  it("pruneCandidates flags never-recalled memories; delete clears stats", async () => {
    await memory.write("p1", { name: "used", description: "d", type: "project", body: "UNIQ body" });
    await memory.write("p1", { name: "unused", description: "d", type: "project", body: "other" });
    await memory.recall("p1", "UNIQ");

    const cands = (await memory.pruneCandidates("p1")).map((m) => m.name);
    expect(cands).toContain("unused");
    expect(cands).not.toContain("used");

    await memory.delete("p1", "used");
    expect((await memory.accessStats("p1"))["used"]).toBeUndefined();
  });
});

describe("MemoryService — findSimilar (dedup nudge)", () => {
  it("flags a near-duplicate under a different name, excludes the same slug + distinct facts", async () => {
    await memory.write("p1", {
      name: "consumable-wheel-ui",
      description: "consumable wheel controls grenade heal tap hold scroll",
      type: "project",
      body: "wheel ctrl space",
    });
    await memory.write("p1", {
      name: "deploy-runbook",
      description: "how we ship to prod",
      type: "project",
      body: "pipeline",
    });

    // A reworded copy of the wheel fact under a new name → surfaced as similar.
    const hits = await memory.findSimilar("p1", {
      name: "consumable-wheel-controls",
      description: "consumable wheel controls grenade heal tap hold scroll",
      body: "wheel ctrl space",
    });
    expect(hits.map((h) => h.name)).toContain("consumable-wheel-ui");
    expect(hits.map((h) => h.name)).not.toContain("deploy-runbook"); // distinct fact
    expect(hits[0]?.similarity).toBeGreaterThanOrEqual(0.35);

    // Reusing the SAME name is a legitimate update, never "similar to itself".
    const self = await memory.findSimilar("p1", {
      name: "consumable-wheel-ui",
      description: "consumable wheel controls grenade heal tap hold scroll",
      body: "wheel ctrl space",
    });
    expect(self.map((h) => h.name)).not.toContain("consumable-wheel-ui");
  });

  it("returns nothing for the first memory of its kind (nothing to duplicate)", async () => {
    await memory.write("p1", { name: "lonely-fact", description: "a unique thing", type: "project", body: "x" });
    expect(await memory.findSimilar("p1", { name: "another-fact", description: "wholly unrelated", body: "y" })).toEqual([]);
  });
});

describe("scoreCorpus — normalized relevance", () => {
  const mem = (name: string, description: string, body: string): ProjectMemory => ({
    projectId: "p1",
    name,
    description,
    type: "project",
    body,
    file: `${name}.md`,
  });
  const scoreOf = (corpus: ProjectMemory[], query: string, name: string) =>
    scoreCorpus(corpus, query).find((s) => s.memory.name === name)?.score ?? 0;

  it("ignores stopwords, so a sentence full of filler scores like its keywords", async () => {
    const corpus = [mem("deploy-runbook", "how we ship", "the pipeline runs")];
    // Every extra function word used to add points to EVERY memory; padding the
    // same keywords with filler must now leave the score untouched.
    const bare = scoreOf(corpus, "deploy pipeline", "deploy-runbook");
    const padded = scoreOf(corpus, "so how is it that we do the deploy pipeline", "deploy-runbook");
    expect(padded).toBeCloseTo(bare, 5);
    expect(bare).toBeGreaterThan(0);
  });

  it("scores an off-topic sentence at zero rather than a nonzero floor", () => {
    const corpus = [mem("deploy-runbook", "how we ship to prod", "run the pipeline")];
    // "the/is/and/of" appear in the body but must contribute nothing.
    expect(scoreOf(corpus, "what is the colour of the sky and sea", "deploy-runbook")).toBe(0);
  });

  it("matches across inflections (desyncing → desync)", () => {
    const corpus = [mem("lobby-rejoin-desync", "roster desync on rejoin", "peers drift")];
    expect(scoreOf(corpus, "desyncing", "lobby-rejoin-desync")).toBeGreaterThan(0);
    expect(scoreOf(corpus, "lobbies", "lobby-rejoin-desync")).toBeGreaterThan(0);
  });

  it("demotes a token that appears in nearly every memory (IDF)", () => {
    // `player` is ubiquitous here, `turret` is rare — a turn naming both should
    // be carried by the rare one, so the turret memory must win.
    const corpus = [
      ...Array.from({ length: 8 }, (_, i) => mem(`sys-${i}`, "player system", "player logic")),
      mem("turret-aim", "turret aiming", "turret leads the target"),
    ];
    const ranked = scoreCorpus(corpus, "player turret aiming").sort((a, b) => b.score - a.score);
    expect(ranked[0]?.memory.name).toBe("turret-aim");
  });

  it("is comparable across queries of different lengths", () => {
    const corpus = [mem("turret-aim", "turret aiming", "turret leads the target")];
    // A one-word query and a wordy one about the SAME topic should land in the
    // same band — that comparability is what makes a fixed threshold meaningful.
    const short = scoreOf(corpus, "turret", "turret-aim");
    const long = scoreOf(corpus, "can you look at the turret please", "turret-aim");
    expect(Math.abs(short - long)).toBeLessThan(25);
  });
});

describe("MemoryService — graded auto-surface", () => {
  const longBody = (word: string) => `${word} detail. `.repeat(300); // ~4KB

  it("gives a confident match its full body, clamped well under the old 4KB", async () => {
    await memory.write("p1", {
      name: "turret-aim-and-fire",
      description: "how turret aiming works",
      type: "project",
      body: longBody("turret"),
    });
    const out = await memory.surfaceFor("p1", "the turret aiming feels off, can you look at it");
    expect(out).not.toBeNull();
    expect(out!.names).toEqual(["turret-aim-and-fire"]);
    expect(out!.block).toContain("turret detail.");
    expect(out!.block).toContain("truncated");
    expect(out!.block.length).toBeLessThan(2200);
  });

  it("offers a match below the confidence bar as a pointer, not as a body", async () => {
    await memory.write("p1", {
      name: "turret-aim-and-fire",
      description: "how turret aiming works",
      type: "project",
      body: longBody("turret"),
    });
    // An unreachable confidence bar forces the pointer tier, so this asserts the
    // tier's RENDERING regardless of how the corpus happens to score.
    const out = await memory.surfaceFor("p1", "the turret aiming feels off", {
      fullScore: 1000,
    });
    expect(out).not.toBeNull();
    expect(out!.names).toEqual([]);
    expect(out!.pointed).toEqual(["turret-aim-and-fire"]);
    // The DESCRIPTION is offered; the body stays out of context entirely.
    expect(out!.block).toContain("how turret aiming works");
    expect(out!.block).not.toContain("turret detail.");
    expect(out!.block).toContain("mcp__manager__recall");
    expect(out!.block.length).toBeLessThan(700);
  });

  it("does not count a pointer as a 'surfaced' access (only full bodies)", async () => {
    await memory.write("p1", {
      name: "turret-aim-and-fire",
      description: "how turret aiming works",
      type: "project",
      body: longBody("turret"),
    });
    await memory.surfaceFor("p1", "the turret aiming feels off", { fullScore: 1000 });
    // A one-liner the agent may never have opened is not evidence of usefulness —
    // counting it would quietly disqualify the memory from prune candidates.
    expect((await memory.accessStats("p1"))["turret-aim-and-fire"]).toBeUndefined();
  });

  it("keeps a whole turn's block inside the char budget", async () => {
    for (let i = 0; i < 8; i++) {
      await memory.write("p1", {
        name: `turret-subsystem-${i}`,
        description: `turret subsystem ${i} aiming and firing`,
        type: "project",
        body: longBody("turret"),
      });
    }
    const out = await memory.surfaceFor("p1", "turret aiming and firing subsystem");
    expect(out).not.toBeNull();
    expect(out!.block.length).toBeLessThanOrEqual(4000);
    expect(out!.names.length).toBeLessThanOrEqual(2);
  });

  it("only excludes full-body pushes, so a pointer can be promoted later", async () => {
    await memory.write("p1", {
      name: "turret-aim-and-fire",
      description: "how turret aiming works",
      type: "project",
      body: longBody("turret"),
    });
    await memory.write("p1", {
      name: "menu-hex-backdrop",
      description: "the animated hex backdrop behind the turret menu",
      type: "project",
      body: longBody("backdrop"),
    });
    const first = await memory.surfaceFor("p1", "the turret aiming feels off");
    expect(first!.names).toEqual(["turret-aim-and-fire"]);
    // The broker excludes `names` only — a memory merely pointed at is not in it.
    expect(first!.names).not.toContain("menu-hex-backdrop");

    // So a later turn squarely about the backdrop can still deliver it in full:
    // it was only ever named, never actually put into context.
    const second = await memory.surfaceFor("p1", "the animated hex backdrop behind the menu", {
      exclude: new Set(first!.names),
    });
    expect(second!.names).toContain("menu-hex-backdrop");
    expect(second!.block).toContain("backdrop detail.");
  });

  it("stays silent on an off-topic turn instead of dragging in link neighbours", async () => {
    await memory.write("p1", {
      name: "turret-aim-and-fire",
      description: "how turret aiming works",
      type: "project",
      body: `turret leads the target. see [[menu-hex-backdrop]]`,
    });
    await memory.write("p1", {
      name: "menu-hex-backdrop",
      description: "the animated hex backdrop",
      type: "project",
      body: longBody("backdrop"),
    });
    // Nothing here matches; the linked neighbour must NOT ride in on a non-match.
    expect(await memory.surfaceFor("p1", "can you bump the dependencies and commit")).toBeNull();
  });
});

describe("clusterAreas", () => {
  it("maps by kebab name prefix, sorts by count desc", () => {
    const areas = clusterAreas(
      ["steam-a", "steam-b", "steam-c", "boss-a", "boss-b", "solo"].map((name) => ({ name })),
    );
    expect(areas).toContain("steam (3)");
    expect(areas).toContain("boss (2)");
    expect(areas).toContain("solo (1)");
    expect(areas.indexOf("steam")).toBeLessThan(areas.indexOf("boss"));
  });

  it("caps at the area limit with a +N more tail", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ name: `area${i}-x` }));
    expect(clusterAreas(many)).toContain("+2 more");
  });
});

describe("MemoryService — .dispatch/ config dir source of truth", () => {
  // Project "cfg" has a config dir → memory lives in the repo memory dir;
  // project "plain" has none → back-compat `.data` store.
  let repoMemoryDir: string;
  let cfgMemory: MemoryService;

  beforeEach(() => {
    repoMemoryDir = join(dir, "repo", ".dispatch", "memory");
    const resolver = {
      getConfig: (projectId: string) =>
        projectId === "cfg" ? { memoryDir: repoMemoryDir } : null,
    };
    let clock = 2000;
    cfgMemory = new MemoryService({ store, bus, now: () => ++clock, projectConfig: resolver });
  });

  it("writes a config-dir project's memory into the repo dir (+ index) — not .data — and injection reflects it", async () => {
    await cfgMemory.write("cfg", {
      name: "repo-fact",
      description: "lives in the repo",
      type: "project",
      body: "REPO BODY",
    });

    // The `.md` + regenerated `MEMORY.md` land in the REPO dir…
    expect(existsSync(join(repoMemoryDir, "repo-fact.md"))).toBe(true);
    const idx = await readFile(join(repoMemoryDir, "MEMORY.md"), "utf8");
    expect(idx).toContain("- [repo-fact](repo-fact.md) — lives in the repo");
    // …and NOT in the legacy `.data` store.
    expect(existsSync(join(store.projectMemoryDir("cfg"), "repo-fact.md"))).toBe(false);

    // Reads + injection route through the repo dir too.
    expect((await cfgMemory.read("cfg", "repo-fact"))?.body).toBe("REPO BODY");
    const injection = await cfgMemory.buildInjection("cfg");
    expect(injection).toContain("`repo-fact` — lives in the repo");

    // The memory-update event fired as usual (client sees no difference).
    expect(events.some((e) => e.type === "memory-update" && e.memory.name === "repo-fact")).toBe(true);
  });

  it("forget removes a config-dir memory from the repo dir + regenerates the index", async () => {
    await cfgMemory.write("cfg", { name: "keep", description: "stays", type: "project", body: "1" });
    await cfgMemory.write("cfg", { name: "drop", description: "goes", type: "project", body: "2" });
    expect(existsSync(join(repoMemoryDir, "drop.md"))).toBe(true);

    expect(await cfgMemory.delete("cfg", "drop")).toBe(true);
    expect(existsSync(join(repoMemoryDir, "drop.md"))).toBe(false);
    const idx = await readFile(join(repoMemoryDir, "MEMORY.md"), "utf8");
    expect(idx).not.toContain("drop.md");
    expect(idx).toContain("keep.md");
    expect(events.some((e) => e.type === "memory-deleted" && e.name === "drop")).toBe(true);
  });

  it("a project WITHOUT a config dir still uses the .data store (back-compat)", async () => {
    await cfgMemory.write("plain", { name: "legacy-home", description: "d", type: "project", body: "b" });
    expect(existsSync(join(store.projectMemoryDir("plain"), "legacy-home.md"))).toBe(true);
    expect(existsSync(join(repoMemoryDir, "legacy-home.md"))).toBe(false);
  });

  it("migrates legacy .data memories into the repo dir, idempotently, without deleting the originals", async () => {
    // Seed a legacy `.data` memory via the plain (config-less) service.
    await memory.write("cfg", { name: "legacy", description: "from .data", type: "project", body: "LEGACY BODY" });
    const legacyPath = join(store.projectMemoryDir("cfg"), "legacy.md");
    expect(existsSync(legacyPath)).toBe(true);

    events.length = 0;
    await cfgMemory.migrateProject("cfg");

    // Copied into the repo dir (+ index regenerated) …
    expect(existsSync(join(repoMemoryDir, "legacy.md"))).toBe(true);
    expect((await cfgMemory.read("cfg", "legacy"))?.body).toBe("LEGACY BODY");
    expect(await readFile(join(repoMemoryDir, "MEMORY.md"), "utf8")).toContain("[legacy](legacy.md)");
    // … the legacy original is left in place …
    expect(existsSync(legacyPath)).toBe(true);
    // … and a memory-update fired so open UIs refresh.
    expect(events.some((e) => e.type === "memory-update" && e.memory.name === "legacy")).toBe(true);

    // Idempotent: re-running does NOT clobber a repo copy that has since diverged.
    await writeFile(
      join(repoMemoryDir, "legacy.md"),
      "---\nname: legacy\ndescription: edited in repo\ntype: project\n---\n\nEDITED BODY\n",
      "utf8",
    );
    await cfgMemory.migrateProject("cfg");
    expect((await cfgMemory.read("cfg", "legacy"))?.body).toBe("EDITED BODY");
  });

  it("migrateProject is a no-op for a project without a config dir", async () => {
    await memory.write("plain", { name: "x", description: "d", type: "project", body: "b" });
    // Should neither throw nor create anything under a (non-existent) repo dir.
    await cfgMemory.migrateProject("plain");
    expect(existsSync(join(dir, "plain-repo"))).toBe(false);
  });

  it("copies every legacy memory but skips ones already present in the repo dir", async () => {
    await memory.write("cfg", { name: "a", description: "da", type: "project", body: "A" });
    await memory.write("cfg", { name: "b", description: "db", type: "project", body: "B" });
    // Pre-seed one of them in the repo dir with a divergent body.
    await mkdir(repoMemoryDir, { recursive: true });
    await writeFile(
      join(repoMemoryDir, "a.md"),
      "---\nname: a\ndescription: repo wins\ntype: project\n---\n\nREPO A\n",
      "utf8",
    );

    await cfgMemory.migrateProject("cfg");

    // "b" copied fresh; "a" kept the pre-existing repo version.
    expect((await cfgMemory.read("cfg", "b"))?.body).toBe("B");
    expect((await cfgMemory.read("cfg", "a"))?.body).toBe("REPO A");
  });
});

describe("MemoryService — inventory (the curation view)", () => {
  it("reports size, retrieval counts and the link graph in BOTH directions", async () => {
    await memory.write("p1", {
      name: "hub",
      description: "the central fact",
      type: "project",
      body: "points at [[spoke]] and at [[ghost]] which does not exist",
    });
    await memory.write("p1", {
      name: "spoke",
      description: "the pointed-at fact",
      type: "project",
      body: "no links here",
    });

    const rows = await memory.inventory("p1");
    const hub = rows.find((m) => m.name === "hub")!;
    const spoke = rows.find((m) => m.name === "spoke")!;

    // A link to a memory that doesn't exist is not a link — it's a typo, and
    // counting it would make the graph look healthier than it is.
    expect(hub.links).toEqual(["spoke"]);
    expect(hub.backlinks).toEqual([]);
    expect(spoke.backlinks).toEqual(["hub"]);
    expect(hub.bytes).toBe(hub.body.length);
    // Nothing has been retrieved yet.
    expect(spoke).toMatchObject({ surfaced: 0, recalled: 0 });
    expect(spoke.lastAccessedAt).toBeUndefined();
  });

  it("counts a recall against the memories it returned", async () => {
    await memory.write("p1", {
      name: "deploy-runbook",
      description: "how we ship to prod",
      type: "project",
      body: "run pnpm ship",
    });
    await memory.recall("p1", "deploy runbook");

    const [row] = await memory.inventory("p1");
    expect(row!.recalled).toBe(1);
    expect(row!.lastAccessedAt).toBeGreaterThan(0);
  });

  it("filters by type/prefix/names but computes backlinks over the WHOLE store", async () => {
    await memory.write("p1", {
      name: "steam-a",
      description: "a",
      type: "project",
      body: "[[other-b]]",
    });
    await memory.write("p1", { name: "steam-c", description: "c", type: "reference", body: "" });
    await memory.write("p1", { name: "other-b", description: "b", type: "project", body: "" });

    expect((await memory.inventory("p1", { prefix: "steam" })).map((m) => m.name)).toEqual([
      "steam-a",
      "steam-c",
    ]);
    expect((await memory.inventory("p1", { type: "reference" })).map((m) => m.name)).toEqual([
      "steam-c",
    ]);
    // Names are slugified, so a human-typed name still resolves.
    expect((await memory.inventory("p1", { names: ["Steam A"] })).map((m) => m.name)).toEqual([
      "steam-a",
    ]);

    // `steam-a` is filtered OUT of this query, but the link it holds still has
    // to count when you ask about its target — otherwise a filtered inventory
    // reports a memory as safe to delete when something points at it.
    const [b] = await memory.inventory("p1", { names: ["other-b"] });
    expect(b!.backlinks).toEqual(["steam-a"]);
  });

  it("is empty for a project with no memories", async () => {
    expect(await memory.inventory("empty")).toEqual([]);
  });
});

describe("MemoryService — grep (exhaustive literal search)", () => {
  beforeEach(async () => {
    await memory.write("p1", {
      name: "taskkill-orphans-subapps",
      description: "Never taskkill the server",
      type: "feedback",
      body:
        "Windows maps SIGTERM to TerminateProcess.\n" +
        "Use pnpm app:stop instead.\n" +
        "Taskkill orphans every subApp.",
    });
    await memory.write("p1", {
      name: "publish-refuses-while-up",
      description: "app:publish builds in place",
      type: "project",
      body: "It refuses to run while the app is up.",
    });
  });

  it("finds EVERY line mentioning a string, across all fields, case-insensitively", async () => {
    const { matches, scanned } = await memory.grep("p1", { pattern: "taskkill" });
    expect(scanned).toBe(2);
    // name, description AND the body line — every occurrence, not the best one.
    expect(matches.map((m) => `${m.field}${m.line ? `:${m.line}` : ""}`)).toEqual([
      "name",
      "description",
      "body:3",
    ]);
    expect(matches.every((m) => m.name === "taskkill-orphans-subapps")).toBe(true);
  });

  it("honours caseSensitive and a field restriction", async () => {
    const cased = await memory.grep("p1", { pattern: "Taskkill", ignoreCase: false });
    expect(cased.matches.map((m) => m.field)).toEqual(["body"]);

    const bodyOnly = await memory.grep("p1", { pattern: "taskkill", field: "body" });
    expect(bodyOnly.matches).toHaveLength(1);
  });

  it("treats the pattern as a LITERAL by default — an unescaped regex char matches nothing", async () => {
    // The whole point: a curator types `app:stop`, `.env`, `foo(bar)`, and a
    // silently-regex `.` matching any character is the wrong kind of helpful.
    expect((await memory.grep("p1", { pattern: "app:st.p" })).matches).toHaveLength(0);
    expect((await memory.grep("p1", { pattern: "app:stop" })).matches).toHaveLength(1);
    expect((await memory.grep("p1", { pattern: "app:st.p", regex: true })).matches).toHaveLength(1);
  });

  it("reports truncation rather than silently returning a partial answer", async () => {
    const { matches, truncated } = await memory.grep("p1", { pattern: "e", limit: 2 });
    expect(matches).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it("rejects an empty pattern and an invalid regex", async () => {
    await expect(memory.grep("p1", { pattern: "   " })).rejects.toThrow(/non-empty/);
    await expect(memory.grep("p1", { pattern: "(unclosed", regex: true })).rejects.toThrow(
      /invalid regex/,
    );
  });
});
