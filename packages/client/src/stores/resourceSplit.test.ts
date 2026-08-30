/**
 * The three-way split behind every resource bar.
 *
 * Worth a test because the arithmetic has two corrections in it that are
 * invisible in the rendered output right up until they are wrong — and both
 * were previously duplicated inline at three call sites, which is three places
 * to get them right. The bar geometry is what makes a mistake here expensive:
 * a `dispatch` that exceeds `used` does not render as a wrong number, it
 * renders as a bright segment sticking out past the fill it is nested inside,
 * which reads as a broken component rather than a bad reading.
 */
import { describe, expect, it } from "vitest";
import { SHARED_PAGE_FACTOR, type DispatchResources, type SystemResources } from "@dispatch/shared";
import { cpuSplit, memorySplit } from "./resources.js";

const GB = 1024 ** 3;

function system(over: Partial<SystemResources> = {}): SystemResources {
  return {
    cpuPct: 40,
    logicalCores: 16,
    totalBytes: 64 * GB,
    freeBytes: 16 * GB,
    usedBytes: 48 * GB,
    ...over,
  };
}

function dispatch(over: Partial<DispatchResources> = {}): DispatchResources {
  return {
    pid: 1,
    procs: 100,
    rssBytes: 19 * GB,
    cpuPct: 160,
    serverRssBytes: 340 * 1024 ** 2,
    serverCpuPct: 2,
    unattributed: { procs: 3, rssBytes: 0, cpuPct: 0 },
    ...over,
  };
}

describe("memorySplit", () => {
  it("corrects the tree sum for shared pages before nesting it", () => {
    const s = memorySplit(system(), dispatch({ rssBytes: 19 * GB }));
    expect(s.dispatch).toBeCloseTo((19 * GB) / SHARED_PAGE_FACTOR, -6);
    // 10 GB of 64 GB.
    expect(s.dispatchPct).toBeCloseTo(15.6, 1);
    expect(s.usedPct).toBeCloseTo(75, 1);
  });

  it("splits used into ours and everything else, with free left over", () => {
    const s = memorySplit(system(), dispatch());
    expect(s.dispatch! + s.other).toBeCloseTo(48 * GB, -6);
    expect(s.free).toBe(16 * GB);
  });

  it("caps our slice at what the machine says is in use", () => {
    // The raw sum can exceed installed RAM outright; corrected it can still
    // land above `usedBytes` on a machine the OS considers mostly free. Left
    // uncapped that draws a bright segment past the end of the dim one.
    const s = memorySplit(system({ usedBytes: 4 * GB, freeBytes: 60 * GB }), dispatch());
    expect(s.dispatch).toBe(4 * GB);
    expect(s.other).toBe(0);
  });

  it("reports no slice at all — not a zero one — before the first scan", () => {
    const s = memorySplit(system(), null);
    expect(s.dispatch).toBeNull();
    expect(s.dispatchPct).toBe(0);
    // Everything in use is still known; it just cannot be attributed yet.
    expect(s.other).toBe(48 * GB);
    expect(s.measured).toBe(true);
  });
});

describe("cpuSplit", () => {
  it("re-expresses our share of ONE core as a share of the machine", () => {
    // 160% of one core on 16 cores is 10% of the machine — not 160%.
    const s = cpuSplit(system({ cpuPct: 40 }), dispatch({ cpuPct: 160 }));
    expect(s.dispatch).toBeCloseTo(10, 5);
    expect(s.other).toBeCloseTo(30, 5);
    expect(s.free).toBeCloseTo(60, 5);
  });

  it("caps our slice at the machine figure when the samplers disagree", () => {
    // Different samplers over different windows: the process walk can read
    // above `os.cpus()` by a point or two, which must not overflow the bar.
    const s = cpuSplit(system({ cpuPct: 5 }), dispatch({ cpuPct: 160 }));
    expect(s.dispatch).toBe(5);
    expect(s.other).toBe(0);
    expect(s.free).toBe(95);
  });

  it("is unmeasured, not idle, on the first poll", () => {
    // A rate needs two samples. Reporting 0% on a machine that is pegged is
    // the reading that makes someone stop trusting the page.
    const s = cpuSplit(system({ cpuPct: null }), dispatch());
    expect(s.measured).toBe(false);
    expect(s.dispatch).toBeNull();
    expect(s.usedPct).toBe(0);
  });

  it("survives a machine reporting no cores", () => {
    const s = cpuSplit(system({ logicalCores: 0, cpuPct: 50 }), dispatch({ cpuPct: 30 }));
    expect(s.dispatch).toBe(30);
    expect(s.usedPct).toBe(50);
  });
});
