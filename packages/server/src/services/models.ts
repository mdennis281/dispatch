/**
 * Available session models for the composer's model picker.
 *
 * The list comes from the Claude Code runtime itself via the Agent SDK's
 * `Query.supportedModels()` control — the same source that fills `/model` in the
 * CLI. That matters because it is auth-aware and needs no API key: this app runs
 * on subscription/OAuth credentials (`~/.claude/.credentials.json`, no
 * `ANTHROPIC_API_KEY`), which the public `GET /v1/models` endpoint cannot use.
 * We previously queried that endpoint, so on subscription auth the picker ALWAYS
 * silently fell through to the static list and looked hardcoded — because it was.
 *
 * The runtime also returns things the raw Models API has no concept of: the
 * `default` alias, 1M-context variants (`opus[1m]`), and per-model effort
 * support. Reading it means new models appear the day they ship, no code change.
 *
 * Cost: `supportedModels()` needs a live query, which spawns a `claude`
 * subprocess (~3s). We open one with an input channel that never yields — so no
 * prompt is sent and no tokens are spent — read the list, and abort. The result
 * is cached, concurrent callers share one probe, and any failure degrades to the
 * last good cache or FALLBACK_MODELS. This function never throws.
 */
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ModelInfo, Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { FALLBACK_MODELS, type ModelOption } from "@dispatch/shared";
import { claudeExecutableOption } from "./runtime.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
/** Cap on the probe subprocess — a hung runtime must not hang the HTTP route. */
const PROBE_TIMEOUT_MS = 20_000;

/** The subset of the SDK `query` signature this service calls. */
export type ModelsQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;

let cache: { at: number; models: ModelOption[] } | null = null;
/** In-flight probe, so a burst of callers spawns ONE subprocess, not N. */
let inFlight: Promise<ModelOption[] | null> | null = null;

/** An input channel that never yields — we want the control channel, not a turn. */
const SILENT_PROMPT: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
};

/**
 * Compact tier hint for the picker row. The runtime's own `description` is the
 * full story ("Opus 4.8 with 1M context · Best for everyday, complex tasks") and
 * rides along separately; this is the short tag the menu shows beside the label,
 * derived from the model family so it keeps working for ids we've never seen.
 */
function hintFor(m: ModelInfo): string | undefined {
  if (m.value === "default") return "recommended";
  const id = `${m.value} ${m.resolvedModel ?? ""}`;
  if (/fable|mythos/i.test(id)) return "most capable";
  if (/opus/i.test(id)) return "deepest";
  if (/sonnet/i.test(id)) return "balanced";
  if (/haiku/i.test(id)) return "fast";
  return undefined;
}

/** Project a runtime `ModelInfo` onto the picker's wire shape. */
function toOption(m: ModelInfo): ModelOption {
  return {
    value: m.value,
    label: m.displayName || m.value,
    hint: hintFor(m),
    resolvedModel: m.resolvedModel,
    description: m.description || undefined,
  };
}

/** Reject once `ms` elapses, so an unresponsive runtime can't pin the request. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("supportedModels timed out")), ms);
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Ask the runtime for its model list. Returns null on any failure so the caller
 * can fall back rather than surface an error.
 *
 * `settingSources: []` keeps the probe from loading repo settings or starting
 * project MCP servers — it only needs the control channel.
 */
async function probe(query: ModelsQueryFn): Promise<ModelOption[] | null> {
  const abort = new AbortController();
  try {
    const q = query({
      prompt: SILENT_PROMPT,
      options: { settingSources: [], abortController: abort, ...claudeExecutableOption() },
    });
    const models = await withTimeout(q.supportedModels(), PROBE_TIMEOUT_MS);
    if (!models?.length) return null;
    return models.map(toOption);
  } catch {
    return null;
  } finally {
    // Always tear the subprocess down — we never consume the message stream.
    abort.abort();
  }
}

export interface ListModelsOptions {
  /** Injectable for tests; defaults to the real Agent SDK `query`. */
  query?: ModelsQueryFn;
  /** Skip the cache and re-probe the runtime (the `?refresh=1` route param). */
  refresh?: boolean;
}

/**
 * The model list for the picker: live from the Claude Code runtime, cached for
 * {@link CACHE_TTL_MS}. Never throws — any failure degrades to the last good
 * cache, then to FALLBACK_MODELS, so the picker always has options.
 */
export async function listAvailableModels(opts: ListModelsOptions = {}): Promise<ModelOption[]> {
  // E2E boots with a fake SDK and no `claude` binary; probing would just burn
  // the timeout on every request. Serve the static list directly.
  if (process.env.DISPATCH_FAKE_SDK === "1") return FALLBACK_MODELS;

  if (!opts.refresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;

  const query = opts.query ?? (sdkQuery as unknown as ModelsQueryFn);
  inFlight ??= probe(query).finally(() => {
    inFlight = null;
  });
  const models = await inFlight;
  if (!models) return cache?.models ?? FALLBACK_MODELS;
  cache = { at: Date.now(), models };
  return models;
}

/** Drop the cached list (tests; also lets a process force a cold read). */
export function resetModelsCache(): void {
  cache = null;
  inFlight = null;
}
