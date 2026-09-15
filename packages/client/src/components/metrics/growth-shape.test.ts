import { describe, it, expect } from "vitest";
import { GROWTH_GENERATED_KEY, METRIC_OTHER_KEY, type GrowthReport } from "@dispatch/shared";
import { autoBucket, bucketStart, lineStep, lineTicks, shapeGrowth } from "./growth-shape.js";

const DAY = 86_400_000;
/** 2024-03-01T00:00Z, a Friday. */
const D0 = Date.UTC(2024, 2, 1);

function report(points: GrowthReport["points"], totals: GrowthReport["totals"]): GrowthReport {
  return {
    projectId: "p",
    ref: "main",
    commits: points.reduce((n, p) => n + p.commits, 0),
    authors: 1,
    firstTs: points[0]?.ts ?? D0,
    lastTs: points.at(-1)?.ts ?? D0,
    points,
    totals,
    notable: [],
    binaries: 0,
    generatedAt: D0,
    elapsedMs: 1,
  };
}

const SAMPLE = report(
  [
    {
      ts: D0,
      commits: 1,
      additions: 130,
      deletions: 0,
      keys: {
        ".ts": { additions: 100, deletions: 0 },
        ".md": { additions: 30, deletions: 0 },
      },
    },
    {
      ts: D0 + 3 * DAY,
      commits: 2,
      additions: 1020,
      deletions: 40,
      keys: {
        ".tsx": { additions: 20, deletions: 0 },
        ".ts": { additions: 0, deletions: 40 },
        [GROWTH_GENERATED_KEY]: { additions: 1000, deletions: 0 },
      },
    },
    {
      ts: D0 + 10 * DAY,
      commits: 1,
      additions: 5,
      deletions: 0,
      keys: { ".md": { additions: 5, deletions: 0 } },
    },
  ],
  {
    ".ts": { additions: 100, deletions: 40, files: 3 },
    ".tsx": { additions: 20, deletions: 0, files: 1 },
    ".md": { additions: 35, deletions: 0, files: 2 },
    [GROWTH_GENERATED_KEY]: { additions: 1000, deletions: 0, files: 1 },
  },
);

describe("bucketStart", () => {
  it("snaps to the UTC day, ISO week and month", () => {
    const wed = Date.UTC(2024, 2, 6, 15, 30);
    expect(bucketStart(wed, "day")).toBe(Date.UTC(2024, 2, 6));
    expect(bucketStart(wed, "week")).toBe(Date.UTC(2024, 2, 4)); // Monday
    expect(bucketStart(wed, "month")).toBe(Date.UTC(2024, 2, 1));
    // A Sunday belongs to the week that STARTED the previous Monday.
    expect(bucketStart(Date.UTC(2024, 2, 3), "week")).toBe(Date.UTC(2024, 1, 26));
  });
});

describe("autoBucket", () => {
  it("widens with the span", () => {
    expect(autoBucket(30 * DAY)).toBe("day");
    expect(autoBucket(365 * DAY)).toBe("week");
    expect(autoBucket(5 * 365 * DAY)).toBe("month");
  });
});

describe("shapeGrowth", () => {
  const now = D0 + 12 * DAY;

  it("folds keys into languages and accumulates size to the line count at HEAD", () => {
    const s = shapeGrowth(SAMPLE, {
      from: null,
      split: "language",
      bucket: "day",
      includeGenerated: false,
      limit: 8,
      now,
    });
    expect(s.bucket).toBe("day");
    expect(s.buckets).toHaveLength(13);
    expect(s.series.map((x) => x.label)).toEqual(["TypeScript", "Markdown"]);
    // .ts and .tsx are one series: 100 − 40 + 20.
    expect(s.series[0]!.now).toBe(80);
    expect(s.size[0]!.at(-1)).toBe(80);
    expect(s.size[1]!.at(-1)).toBe(35);
    // Day 3 holds the tsx add and the ts delete; day 4 carries the total.
    expect(s.added[0]![3]).toBe(20);
    expect(s.deleted[0]![3]).toBe(40);
    expect(s.size[0]![3]).toBe(80);
    expect(s.size[0]![4]).toBe(80);
    expect(s.commits[3]).toBe(2);
    expect(s.linesNow).toBe(115);
    expect(s.groups.find((g) => g.label === "TypeScript")!.keys.sort()).toEqual([".ts", ".tsx"]);
    expect(s.groups.find((g) => g.label === "TypeScript")!.files).toBe(4);
  });

  it("hides the generated bucket unless asked, and it dominates when shown", () => {
    const off = shapeGrowth(SAMPLE, {
      from: null, split: "language", bucket: "day", includeGenerated: false, limit: 8, now,
    });
    expect(off.groups.some((g) => g.label === "Generated")).toBe(false);
    const on = shapeGrowth(SAMPLE, {
      from: null, split: "language", bucket: "day", includeGenerated: true, limit: 8, now,
    });
    expect(on.series[0]!.label).toBe("Generated");
    expect(on.linesNow).toBe(1115);
  });

  it("starts a narrowed range at the size the repo already was", () => {
    const s = shapeGrowth(SAMPLE, {
      from: D0 + 5 * DAY,
      split: "none",
      bucket: "day",
      includeGenerated: false,
      limit: 8,
      now,
    });
    expect(s.buckets[0]).toBe(D0 + 5 * DAY);
    expect(s.linesAtStart).toBe(110);
    expect(s.size[0]![0]).toBe(110);
    expect(s.addedInRange).toBe(5);
    expect(s.deletedInRange).toBe(0);
    expect(s.commitsInRange).toBe(1);
    expect(s.linesNow).toBe(115);
  });

  it("folds the tail into Other past the limit, ranked on the whole history", () => {
    const s = shapeGrowth(SAMPLE, {
      from: null,
      split: "extension",
      bucket: "week",
      includeGenerated: false,
      limit: 2,
      now,
    });
    expect(s.series.map((x) => x.key)).toEqual([".ts", ".md", METRIC_OTHER_KEY]);
    expect(s.folded).toBe(1);
    expect(s.series[2]!.now).toBe(20);
    // Weekly: Fri Mar 1 is in the week of Mon Feb 26.
    expect(s.buckets[0]).toBe(Date.UTC(2024, 1, 26));
    // Every series sums to the whole at the end.
    const end = s.size.reduce((n, z) => n + z.at(-1)!, 0);
    expect(end).toBe(s.linesNow);
  });

  it("clamps the range start to the first commit", () => {
    const s = shapeGrowth(SAMPLE, {
      from: D0 - 400 * DAY,
      split: "none",
      bucket: "auto",
      includeGenerated: false,
      limit: 8,
      now,
    });
    expect(s.buckets[0]).toBe(D0);
    expect(s.bucket).toBe("day");
  });
});

describe("lineTicks", () => {
  it("picks a round step for a line count", () => {
    expect(lineStep(235_000)).toBe(50_000);
    expect(lineStep(1_200)).toBe(250);
    expect(lineStep(80)).toBe(20);
  });

  it("runs from a round floor through zero to a round ceiling", () => {
    expect(lineTicks(0, 235_000)).toEqual([0, 50_000, 100_000, 150_000, 200_000, 250_000]);
    expect(lineTicks(-7_000, 26_000)).toEqual([-10_000, 0, 10_000, 20_000, 30_000]);
    expect(lineTicks(-300, 120)).toEqual([-300, -200, -100, 0, 100, 200]);
    expect(Object.is(lineTicks(0, 235_000)[0], -0)).toBe(false);
  });

  it("still yields a zero tick for an empty window", () => {
    expect(lineTicks(0, 0)).toEqual([0, 1]);
  });
});
