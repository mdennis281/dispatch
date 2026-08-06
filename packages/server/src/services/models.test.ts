import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import { FALLBACK_MODELS } from "@dispatch/shared";
import { listAvailableModels, resetModelsCache, type ModelsQueryFn } from "./models.js";

/* --------------------------------------------------------------- fixtures */

/** Shape of a real `supportedModels()` row (captured from Claude Code 2.1.222). */
const LIVE: ModelInfo[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Default (recommended)",
    description: "Opus 5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
  },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "" },
] as ModelInfo[];

/**
 * A fake `query` whose control channel answers `supportedModels()`. Records how
 * many subprocesses we'd have spawned and whether each was torn down.
 */
function makeQuery(
  supportedModels: () => Promise<ModelInfo[]>,
): ModelsQueryFn & { calls: number; aborts: number } {
  const fn = ((params) => {
    fn.calls++;
    params.options?.abortController?.signal.addEventListener("abort", () => {
      fn.aborts++;
    });
    return { supportedModels } as unknown as Query;
  }) as ModelsQueryFn & { calls: number; aborts: number };
  fn.calls = 0;
  fn.aborts = 0;
  return fn;
}

const ok = () => makeQuery(async () => LIVE);

/* ------------------------------------------------------------------ tests */

describe("listAvailableModels", () => {
  beforeEach(() => {
    resetModelsCache();
    delete process.env.DISPATCH_FAKE_SDK;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("projects the runtime's live list onto picker options", async () => {
    const models = await listAvailableModels({ query: ok() });
    expect(models).toEqual([
      {
        value: "default",
        label: "Default (recommended)",
        hint: "recommended",
        resolvedModel: "claude-opus-5[1m]",
        description: "Opus 5 with 1M context · Best for everyday, complex tasks",
      },
      {
        value: "sonnet",
        label: "Sonnet",
        hint: "balanced",
        resolvedModel: "claude-sonnet-5",
        description: "Sonnet 5 · Efficient for routine tasks",
      },
      {
        value: "haiku",
        label: "Haiku",
        hint: "fast",
        resolvedModel: "claude-haiku-4-5-20251001",
        description: undefined,
      },
    ]);
  });

  it("preserves the runtime's own ordering rather than re-sorting", async () => {
    const models = await listAvailableModels({ query: ok() });
    expect(models.map((m) => m.value)).toEqual(["default", "sonnet", "haiku"]);
  });

  it("hints an unseen model family from its resolved wire id", async () => {
    const q = makeQuery(async () => [
      { value: "wildcard", resolvedModel: "claude-fable-9", displayName: "Wildcard" },
    ] as ModelInfo[]);
    const [m] = await listAvailableModels({ query: q });
    expect(m).toMatchObject({ value: "wildcard", label: "Wildcard", hint: "most capable" });
  });

  it("always tears down the probe subprocess", async () => {
    const q = ok();
    await listAvailableModels({ query: q });
    expect(q.aborts).toBe(1);
  });

  it("caches, and re-probes only when asked to refresh", async () => {
    const q = ok();
    await listAvailableModels({ query: q });
    await listAvailableModels({ query: q });
    expect(q.calls).toBe(1);

    await listAvailableModels({ query: q, refresh: true });
    expect(q.calls).toBe(2);
  });

  it("re-probes once the cache goes stale", async () => {
    vi.useFakeTimers();
    const q = ok();
    await listAvailableModels({ query: q });
    vi.advanceTimersByTime(6 * 60 * 1000);
    await listAvailableModels({ query: q });
    expect(q.calls).toBe(2);
  });

  it("shares one probe across concurrent callers", async () => {
    const q = ok();
    const [a, b] = await Promise.all([
      listAvailableModels({ query: q }),
      listAvailableModels({ query: q }),
    ]);
    expect(q.calls).toBe(1);
    expect(a).toEqual(b);
  });

  it("falls back to the static list when the runtime is unreachable", async () => {
    const q = makeQuery(async () => {
      throw new Error("no claude binary");
    });
    expect(await listAvailableModels({ query: q })).toEqual(FALLBACK_MODELS);
  });

  it("falls back when the runtime answers with an empty list", async () => {
    expect(await listAvailableModels({ query: makeQuery(async () => []) })).toEqual(FALLBACK_MODELS);
  });

  it("serves the last good list rather than the fallback when a later probe fails", async () => {
    const live = await listAvailableModels({ query: ok() });
    const dead = makeQuery(async () => {
      throw new Error("runtime died");
    });
    expect(await listAvailableModels({ query: dead, refresh: true })).toEqual(live);
  });

  it("skips the probe entirely under DISPATCH_FAKE_SDK", async () => {
    process.env.DISPATCH_FAKE_SDK = "1";
    const q = ok();
    expect(await listAvailableModels({ query: q })).toEqual(FALLBACK_MODELS);
    expect(q.calls).toBe(0);
  });
});
