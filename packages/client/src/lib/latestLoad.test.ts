import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldFresh, latestLoad, LOAD_DEBOUNCE_MS, REMOUNT_FRESH_MS, type LoadContext } from "./latestLoad.js";

/** A job whose every run waits for the test to settle it by hand. */
function deferredJob() {
  const runs: { ctx: LoadContext; resolve: () => void }[] = [];
  const job = (ctx: LoadContext) =>
    new Promise<void>((resolve) => {
      runs.push({ ctx, resolve });
    });
  return { runs, job };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("latestLoad — debounce", () => {
  it("collapses a burst of schedules into ONE run after the controls settle", () => {
    // The freeze: every chip click fired a full batch. Three quick clicks must
    // cost one.
    const { runs, job } = deferredJob();
    const loader = latestLoad(job);
    loader.schedule();
    vi.advanceTimersByTime(LOAD_DEBOUNCE_MS - 1);
    loader.schedule();
    vi.advanceTimersByTime(LOAD_DEBOUNCE_MS - 1);
    loader.schedule();
    expect(runs).toHaveLength(0);
    vi.advanceTimersByTime(LOAD_DEBOUNCE_MS);
    expect(runs).toHaveLength(1);
  });

  it("run() goes at once and swallows a pending schedule", () => {
    const { runs, job } = deferredJob();
    const loader = latestLoad(job);
    loader.schedule();
    void loader.run();
    expect(runs).toHaveLength(1);
    vi.advanceTimersByTime(LOAD_DEBOUNCE_MS * 2);
    expect(runs).toHaveLength(1);
  });

  it("cancel() drops a pending schedule", () => {
    const { runs, job } = deferredJob();
    const loader = latestLoad(job);
    loader.schedule();
    loader.cancel();
    vi.advanceTimersByTime(LOAD_DEBOUNCE_MS * 2);
    expect(runs).toHaveLength(0);
  });
});

describe("latestLoad — abort + generation", () => {
  it("aborts the superseded run's signal and marks it stale", () => {
    // Abort is what stops the browser sending (and the server running) a batch
    // nobody wants; the generation is what stops a reply that already landed.
    const { runs, job } = deferredJob();
    const loader = latestLoad(job);
    void loader.run();
    void loader.run();
    const [first, second] = runs;
    expect(first!.ctx.signal.aborted).toBe(true);
    expect(first!.ctx.current()).toBe(false);
    expect(second!.ctx.signal.aborted).toBe(false);
    expect(second!.ctx.current()).toBe(true);
  });

  it("is already stale when the aborted run's rejection reaches its catch", async () => {
    // Ordering bug this guards: abort first, bump later, and the old run's
    // catch would see current() === true and write an "aborted" error over the
    // newer query.
    let staleAtCatch: boolean | undefined;
    const loader = latestLoad(async ({ signal, current }) => {
      await new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      ).catch(() => {
        staleAtCatch ??= !current();
      });
    });
    void loader.run();
    void loader.run();
    await vi.runAllTimersAsync();
    expect(staleAtCatch).toBe(true);
  });

  it("cancel() aborts and stales the run in flight without starting another", () => {
    const { runs, job } = deferredJob();
    const loader = latestLoad(job);
    void loader.run();
    loader.cancel();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ctx.signal.aborted).toBe(true);
    expect(runs[0]!.ctx.current()).toBe(false);
    expect(loader.inFlight()).toBe(false);
  });

  it("reports in-flight only while the CURRENT run is out", async () => {
    const { runs, job } = deferredJob();
    const loader = latestLoad(job);
    expect(loader.inFlight()).toBe(false);
    const done = loader.run();
    expect(loader.inFlight()).toBe(true);
    runs[0]!.resolve();
    await done;
    expect(loader.inFlight()).toBe(false);
  });
});

describe("latestLoad — freshness", () => {
  it("is fresh for the same key until the age cap, and never for another key", async () => {
    let now = 1_000;
    const loader = latestLoad(async ({ landed }) => landed("q1"), { now: () => now });
    expect(loader.fresh("q1", REMOUNT_FRESH_MS)).toBe(false);
    await loader.run();
    expect(loader.fresh("q1", REMOUNT_FRESH_MS)).toBe(true);
    expect(loader.fresh("q2", REMOUNT_FRESH_MS)).toBe(false);
    now += REMOUNT_FRESH_MS;
    expect(loader.fresh("q1", REMOUNT_FRESH_MS)).toBe(false);
  });

  it("ignores a landed() from a superseded run", () => {
    const { runs, job } = deferredJob();
    const loader = latestLoad(job);
    void loader.run();
    void loader.run();
    runs[0]!.ctx.landed("old");
    expect(loader.fresh("old", REMOUNT_FRESH_MS)).toBe(false);
  });

  it("heldFresh needs the same scope AND a young enough copy", () => {
    expect(heldFresh(null, "a", 0)).toBe(false);
    expect(heldFresh({ key: "a", at: 0 }, "b", 0)).toBe(false);
    expect(heldFresh({ key: "a", at: 0 }, "a", REMOUNT_FRESH_MS - 1)).toBe(true);
    expect(heldFresh({ key: "a", at: 0 }, "a", REMOUNT_FRESH_MS)).toBe(false);
  });
});
