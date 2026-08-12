import { describe, it, expect } from "vitest";
import { clusterMemories, shardMemories, type ShardableMemory } from "./memory-shard.js";

/** A memory whose fields all carry the same words — a compact, controllable fixture. */
function mem(name: string, description: string, body = ""): ShardableMemory {
  return { name, description, body: body || description };
}

/** Which shard holds a given name. */
function shardOf(shards: ReturnType<typeof shardMemories>, name: string): number | undefined {
  return shards.find((s) => s.names.includes(name))?.index;
}

describe("clusterMemories", () => {
  it("groups two reworded copies of the same fact and leaves unrelated ones alone", () => {
    const clusters = clusterMemories([
      mem("pfsense-wan-flap", "pfSense WAN speed duplex autoselect causes link flap"),
      mem("pfsense-wan-autoselect-flap", "pfSense WAN autoselect duplex speed causes a link flap"),
      mem("unifi-controller-ports", "UniFi controller runs rootless podman on port 11443"),
    ]);
    const grouped = clusters.find((c) => c.length > 1);
    expect(grouped).toEqual(["pfsense-wan-autoselect-flap", "pfsense-wan-flap"]);
    expect(clusters.some((c) => c.length === 1 && c[0] === "unifi-controller-ports")).toBe(true);
  });

  it("groups TRANSITIVELY — a drifted third copy rides in on the middle one", () => {
    // a↔b share "lobby rejoin desync"; b↔c share "desync after a player leaves".
    // a and c share almost nothing directly, which is exactly the case a
    // pairwise-only grouping would split and hide.
    const clusters = clusterMemories([
      mem("steam-lobby-rejoin-desync", "lobby rejoin desync", "the lobby rejoin desync bug"),
      mem(
        "steam-rejoin-desync-leave",
        "lobby rejoin desync after a player leaves",
        "the lobby rejoin desync happens after a player leaves",
      ),
      mem(
        "netcode-leave-desync",
        "desync after a player leaves",
        "clients desync after a player leaves",
      ),
    ]);
    expect(clusters[0]).toHaveLength(3);
  });

  it("returns every memory exactly once, as singletons when nothing resembles anything", () => {
    const input = [
      mem("alpha-thing", "the alpha subsystem boots first"),
      mem("beta-widget", "widgets render through canvas"),
      mem("gamma-cron", "nightly cron prunes old snapshots"),
    ];
    const clusters = clusterMemories(input);
    expect(clusters.flat().sort()).toEqual(input.map((m) => m.name).sort());
    expect(clusters.every((c) => c.length === 1)).toBe(true);
  });

  it("is empty for an empty store", () => {
    expect(clusterMemories([])).toEqual([]);
  });
});

describe("shardMemories", () => {
  /**
   * 60 mutually-unrelated memories — the "big store, no duplicates" baseline.
   * Every token is unique to its memory ON PURPOSE: shared boilerplate across
   * descriptions is enough to chain the whole store into one cluster, which is
   * a real corpus shape (covered separately below) but not the baseline.
   */
  const distinct = (i: number) =>
    mem(`topic${i}-fact`, `zeta${i} kappa${i} omicron${i} lambda${i} sigma${i}`);
  const many: ShardableMemory[] = Array.from({ length: 60 }, (_, i) => distinct(i));

  it("covers every memory exactly once", () => {
    const shards = shardMemories(many);
    const names = shards.flatMap((s) => s.names);
    expect(names).toHaveLength(many.length);
    expect(new Set(names).size).toBe(many.length);
  });

  it("respects the target size and the shard cap", () => {
    const shards = shardMemories(many, { target: 10 });
    expect(shards).toHaveLength(6);

    // 200 memories at target 18 would want 12 shards; the cap holds it at 10.
    const huge = Array.from({ length: 200 }, (_, i) => distinct(i));
    expect(shardMemories(huge, { target: 18, maxShards: 10 })).toHaveLength(10);
  });

  it("still fans out when boilerplate chains the WHOLE store into one cluster", () => {
    // Every description shares the same template, so transitive clustering
    // collapses all 60 into a single component. Left whole that would hand one
    // agent the entire store — the failure sharding exists to prevent, and one
    // that reports no error.
    const boilerplate = Array.from({ length: 60 }, (_, i) =>
      mem(`topic${i}-fact`, `this project uses the standard approach for subject ${i}`),
    );
    const shards = shardMemories(boilerplate, { target: 10 });
    expect(shards.length).toBeGreaterThan(1);
    expect(shards.every((s) => s.names.length <= 20)).toBe(true);
    expect(shards.flatMap((s) => s.names)).toHaveLength(60);
  });

  it("keeps a duplicate pair in ONE shard — the property the fan-out depends on", () => {
    // The pair is buried in the middle of a large store, so a size-based split
    // would have every reason to cut between them.
    const withDupes = [
      ...many.slice(0, 30),
      mem("pfsense-wan-flap", "pfSense WAN speed duplex autoselect causes link flap"),
      ...many.slice(30, 55),
      mem("pfsense-wan-autoselect-flap", "pfSense WAN autoselect duplex speed causes a link flap"),
      ...many.slice(55),
    ];
    const shards = shardMemories(withDupes, { target: 8 });
    expect(shardOf(shards, "pfsense-wan-flap")).toBe(shardOf(shards, "pfsense-wan-autoselect-flap"));
  });

  it("reports the suspected duplicates it grouped, and lists them adjacently", () => {
    const shards = shardMemories([
      mem("pfsense-wan-flap", "pfSense WAN speed duplex autoselect causes link flap"),
      mem("pfsense-wan-autoselect-flap", "pfSense WAN autoselect duplex speed causes a link flap"),
      mem("unifi-controller-ports", "UniFi controller runs rootless podman on port 11443"),
    ]);
    const dupes = shards.flatMap((s) => s.duplicates);
    expect(dupes).toEqual([["pfsense-wan-autoselect-flap", "pfsense-wan-flap"]]);

    // Adjacent in the listing, so an agent reading top-to-bottom meets them together.
    const names = shards.flatMap((s) => s.names);
    const a = names.indexOf("pfsense-wan-flap");
    const b = names.indexOf("pfsense-wan-autoselect-flap");
    expect(Math.abs(a - b)).toBe(1);
  });

  it("reports no duplicates when there are none", () => {
    expect(shardMemories(many).flatMap((s) => s.duplicates)).toEqual([]);
  });

  it("keeps a cluster whole even when it overflows a shard", () => {
    // Six copies of one fact with a target of 2: breaking the cluster would be
    // the size-respecting choice and the wrong one.
    const copies = Array.from({ length: 6 }, (_, i) =>
      mem(`dupe-fact-${i}`, "the very same recorded fact about the very same thing"),
    );
    const shards = shardMemories(copies, { target: 2 });
    expect(shards).toHaveLength(1);
    expect(shards[0]!.names).toHaveLength(6);
  });

  it("labels a shard by its dominant topic areas", () => {
    const shards = shardMemories(
      [
        mem("steam-alpha", "alpha subject one"),
        mem("steam-beta", "beta subject two"),
        mem("steam-gamma", "gamma subject three"),
      ],
      { target: 10 },
    );
    expect(shards[0]!.label).toBe("steam");
  });

  it("says `mixed` rather than inventing a theme a shard doesn't have", () => {
    // Every one of these has a distinct name prefix — the real shape of a store
    // that grew organically. Naming two of sixteen areas would read as a theme.
    const shards = shardMemories(many, { target: 20 });
    expect(shards[0]!.label).toMatch(/^mixed \(\d+ areas\)$/);
  });

  it("keeps an area together when there IS area structure to keep", () => {
    // 20 unrelated facts plus 8 `steam-*` ones: the steam facts should collect
    // rather than round-robin across every bucket.
    const steam = Array.from({ length: 8 }, (_, i) =>
      mem(`steam-${i}`, `alpha${i} beta${i} gamma${i} delta${i}`),
    );
    const store = [...Array.from({ length: 20 }, (_, i) => distinct(i)), ...steam];
    const shards = shardMemories(store, { target: 7 });
    const steamShards = new Set(
      shards
        .filter((s) => s.names.some((n) => n.startsWith("steam-")))
        .map((s) => s.index),
    );
    expect(steamShards.size).toBeLessThanOrEqual(2);
  });

  it("numbers shards from 1 and emits none for an empty store", () => {
    expect(shardMemories([])).toEqual([]);
    const shards = shardMemories(many, { target: 10 });
    expect(shards.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("is deterministic — same input, same shards", () => {
    const a = shardMemories(many, { target: 7 });
    const b = shardMemories(many, { target: 7 });
    expect(a).toEqual(b);
  });
});
