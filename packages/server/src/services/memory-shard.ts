/**
 * memory-shard — split a project's memory store into subsets one agent each can
 * actually audit.
 *
 * A consolidation pass over 140 facts does not fit in one context, and even if
 * it did, one agent reading 140 bodies in sequence forgets the first forty by
 * the time it reaches the last. So the work fans out. The only question is
 * WHERE to cut, and the naive cuts are both wrong:
 *
 *   - Alphabetically / arbitrarily: `steam-lobby-desync` and
 *     `steam-rejoin-desync` land in different shards, and NEITHER agent can see
 *     the duplicate. The whole point of the pass is missed, silently — each
 *     shard reports "no duplicates here" and both are telling the truth.
 *   - By name prefix alone: better, since duplicates usually share a feature
 *     word, but it misses the reworded pair (`pfsense-dns-outage` vs
 *     `unbound-died-silently`) that shares no prefix at all.
 *
 * So shards are built from CONTENT similarity: cluster near-duplicates first
 * (same blended name/description/body signal the `remember` dedup nudge uses),
 * treat each cluster as indivisible, then pack clusters into balanced shards
 * preferring to keep a topic area together. A duplicate pair is then guaranteed
 * to be visible to exactly one agent, which is the property that makes the
 * fan-out sound.
 *
 * Cross-shard duplicates still exist in the tail — two facts that resemble each
 * other below the clustering bar. Those are the orchestrator's job on the way
 * back (see the consolidation briefing), not this file's.
 *
 * Pure and deterministic: no I/O, no clock, ties broken by name. That's what
 * lets it be tested against a real corpus shape.
 */
import { memoryTokens, similarityOfTokens, type MemoryTokens } from "./memory.js";

/** The memory fields sharding needs — structurally satisfied by ProjectMemory. */
export interface ShardableMemory {
  name: string;
  description: string;
  body: string;
}

/** One agent's slice of the store. */
export interface MemoryShard {
  /** 1-based, for "shard 3 of 8" in the briefing. */
  index: number;
  /** The dominant topic areas in this shard — a human-readable handle. */
  label: string;
  /**
   * Member names, ordered so members of the same suspected-duplicate cluster are
   * ADJACENT. An agent reading the list top to bottom meets the pairs together.
   */
  names: string[];
  /**
   * Suspected-duplicate groups within this shard (2+ members each). Pre-computed
   * rather than left to the agent to notice: this is the machine-checkable half
   * of the job, and handing it over means the agent spends its judgment on
   * "is this REALLY the same fact?" instead of on finding the candidates.
   */
  duplicates: string[][];
}

export interface ShardOptions {
  /** Memories per shard to aim for. */
  target?: number;
  /** Hard cap on shard count — i.e. on how many agents this fans out to. */
  maxShards?: number;
  /**
   * Similarity at/above which two memories are clustered together. Deliberately
   * BELOW the `remember` dedup nudge's 0.35: putting two unrelated facts in one
   * agent's pile costs nothing, while splitting a real duplicate pair across two
   * agents costs the whole finding. When in doubt, group.
   */
  threshold?: number;
}

const DEFAULT_TARGET = 18;
const DEFAULT_MAX_SHARDS = 10;
const DEFAULT_THRESHOLD = 0.25;

/**
 * Largest cluster that stays indivisible, as a multiple of the target shard size
 * (with a floor, so a small target can't make every pair "oversized").
 *
 * Clustering is transitive, which is what catches a drifted third copy — and
 * also what lets a single over-similar corpus collapse into ONE component. A
 * store whose memories all share boilerplate ("this project uses…", a repeated
 * template) chains end to end, and the fan-out silently degenerates to a single
 * agent holding everything: the exact failure sharding exists to prevent, with
 * no error to notice. So a cluster past this size is split, because whatever it
 * is, one agent can't audit it well. The pieces stay flagged as suspected
 * duplicates — the flag was always a signal for the agent to judge, not a
 * verdict, and an over-merged chunk simply comes back as "these aren't dupes".
 */
const CLUSTER_SIZE_MULTIPLE = 2;
const CLUSTER_SIZE_FLOOR = 8;

/* ------------------------------------------------------------------ clustering */

/** Union-find over memory indices — the connected components ARE the clusters. */
class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root]!;
    // Path compression — the corpus is small, but a chain of near-duplicates
    // ("a~b, b~c, c~d, …") is exactly the shape that makes find() degenerate.
    let cur = i;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur]!;
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/**
 * Group memories that look like the same fact, TRANSITIVELY: if a resembles b
 * and b resembles c, all three land together even when a and c don't resemble
 * each other directly. That transitivity is deliberate — a fact recorded three
 * times over six months usually drifts, so the first and third copies can read
 * as unrelated while both clearly match the middle one. Splitting them would
 * hand an agent two of the three and hide the third.
 *
 * Returns every memory exactly once, as clusters of 1+ members, ordered largest
 * cluster first then by first member's name.
 */
export function clusterMemories(
  memories: readonly ShardableMemory[],
  threshold: number = DEFAULT_THRESHOLD,
): string[][] {
  const n = memories.length;
  if (n === 0) return [];
  const tokens: MemoryTokens[] = memories.map((m) => memoryTokens(m));
  const dsu = new DisjointSet(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (similarityOfTokens(tokens[i]!, tokens[j]!) >= threshold) dsu.union(i, j);
    }
  }
  const groups = new Map<number, string[]>();
  for (let i = 0; i < n; i++) {
    const root = dsu.find(i);
    const list = groups.get(root);
    if (list) list.push(memories[i]!.name);
    else groups.set(root, [memories[i]!.name]);
  }
  const out = [...groups.values()];
  for (const g of out) g.sort((a, b) => a.localeCompare(b));
  out.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
  return out;
}

/* -------------------------------------------------------------------- packing */

/** Split a list into fixed-size pieces, preserving order. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A memory's topic area — the first token of its kebab name, as in the index. */
function areaOf(name: string): string {
  return (name.split("-")[0] || name).trim();
}

/** The areas a set of names spans, with counts, most common first. */
function areasOf(names: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const n of names) {
    const a = areaOf(n);
    if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  return [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
}

/**
 * Share of a shard its top area must hold before the label names areas at all.
 *
 * Plenty of real stores have no topic structure to name: a 143-fact store
 * measured here had ~100 distinct name prefixes, so every shard's honest
 * composition was "eighteen unrelated things". Labelling that `local, ui +14
 * more` claims a coherence the shard doesn't have and sends a reader looking
 * for a theme that was never there. `mixed (16 areas)` is shorter AND true.
 */
const LABEL_DOMINANCE = 0.25;

/** "steam, lobby +3 more" for a themed shard; "mixed (16 areas)" when it isn't. */
function labelFor(names: readonly string[]): string {
  const areas = areasOf(names);
  if (!areas.length) return "misc";
  const [, topCount] = areas[0]!;
  if (topCount < names.length * LABEL_DOMINANCE) return `mixed (${areas.length} areas)`;
  const shown = areas.slice(0, 2).map(([a]) => a);
  const rest = areas.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest} more` : shown.join(", ");
}

/**
 * Split a store into shards for a fan-out consolidation pass.
 *
 * Clusters are indivisible, so a shard can overshoot the target size when one
 * cluster is bigger than a shard — correct by design: breaking a duplicate group
 * across agents defeats the whole exercise, and an oversized shard merely costs
 * one agent more reading.
 *
 * Empty input yields no shards (the caller has nothing to consolidate).
 */
export function shardMemories(
  memories: readonly ShardableMemory[],
  opts: ShardOptions = {},
): MemoryShard[] {
  if (!memories.length) return [];
  const target = Math.max(1, opts.target ?? DEFAULT_TARGET);
  const maxShards = Math.max(1, opts.maxShards ?? DEFAULT_MAX_SHARDS);
  const maxCluster = Math.max(CLUSTER_SIZE_FLOOR, target * CLUSTER_SIZE_MULTIPLE);
  const clusters = clusterMemories(memories, opts.threshold ?? DEFAULT_THRESHOLD).flatMap((c) =>
    c.length > maxCluster ? chunk(c, target) : [c],
  );

  const shardCount = Math.min(maxShards, Math.max(1, Math.ceil(memories.length / target)));
  const capacity = Math.ceil(memories.length / shardCount);

  interface Bucket {
    names: string[];
    duplicates: string[][];
    /** Area → member count, for the affinity tie-break. */
    areas: Map<string, number>;
  }
  const buckets: Bucket[] = Array.from({ length: shardCount }, () => ({
    names: [],
    duplicates: [],
    areas: new Map(),
  }));

  // ORDER MATTERS as much as the scoring does. Placing strictly largest-first
  // means every singleton meets a set of buckets that don't hold its area yet,
  // so the affinity term never fires and each new area lands in whichever bucket
  // is emptiest — round-robin. Measured on a real 143-fact store that produced
  // eight shards spanning eleven-plus topic areas each: the packing was perfect
  // and the grouping was noise.
  //
  // So: place the clusters too big to be moved around first (they're the ones a
  // late placement would strand), then walk the rest AREA BY AREA so an area's
  // members meet each other's bucket. A shard that is recognizably "the steam
  // one" is one a human can actually read the report for.
  const bulky = clusters.filter((c) => c.length * 2 > capacity);
  const rest = clusters
    .filter((c) => c.length * 2 <= capacity)
    .sort(
      (a, b) =>
        areaOf(a[0] ?? "").localeCompare(areaOf(b[0] ?? "")) ||
        b.length - a.length ||
        (a[0] ?? "").localeCompare(b[0] ?? ""),
    );

  for (const cluster of [...bulky, ...rest]) {
    const area = areaOf(cluster[0] ?? "");
    let best: Bucket | undefined;
    let bestScore = -Infinity;
    for (const b of buckets) {
      const room = capacity - b.names.length;
      // Prefer a bucket that fits; among those, the one already holding this
      // area; among those, the emptiest. A cluster that fits nowhere goes to the
      // emptiest bucket rather than spawning an unbounded shard count.
      const score =
        (room >= cluster.length ? 1_000_000 : 0) +
        (b.areas.get(area) ?? 0) * 1_000 +
        room;
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    const bucket = best!;
    bucket.names.push(...cluster);
    if (cluster.length > 1) bucket.duplicates.push(cluster);
    for (const n of cluster) {
      const a = areaOf(n);
      bucket.areas.set(a, (bucket.areas.get(a) ?? 0) + 1);
    }
  }

  return buckets
    .filter((b) => b.names.length > 0)
    .map((b, i) => ({
      index: i + 1,
      label: labelFor(b.names),
      names: b.names,
      duplicates: b.duplicates,
    }));
}
