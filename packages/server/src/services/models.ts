/**
 * Available session models for the composer's model picker.
 *
 * When an ANTHROPIC_API_KEY is present we query the Anthropic Models API
 * (GET /v1/models) so the list reflects exactly what the key can reach — new
 * models show up the day they ship, no code change. Subscription/OAuth auth has
 * no usable API key, so we fall back to a curated static list (FALLBACK_MODELS).
 * The live result is cached briefly so we don't round-trip on every request.
 */
import { FALLBACK_MODELS, type ModelOption } from "@cm/shared";

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=1000";
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { at: number; models: ModelOption[] } | null = null;

/** Lightweight tier hint from the model family in the id (matches FALLBACK_MODELS). */
function hintFor(id: string): string | undefined {
  if (/fable|mythos/i.test(id)) return "most capable";
  if (/opus/i.test(id)) return "deepest";
  if (/sonnet/i.test(id)) return "balanced";
  if (/haiku/i.test(id)) return "fast";
  return undefined;
}

/** Map a raw Models API record to a picker option (drop the redundant "Claude" prefix). */
function toOption(m: { id: string; display_name?: string }): ModelOption {
  const label = m.display_name?.replace(/^Claude\s+/i, "").trim() || m.id;
  return { value: m.id, label, hint: hintFor(m.id) };
}

/**
 * The model list for the picker. Live from the Anthropic Models API when a key
 * is set, otherwise the static fallback. Never throws — any failure degrades to
 * the last good cache or the fallback so the picker always has options.
 */
export async function listAvailableModels(): Promise<ModelOption[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return FALLBACK_MODELS;

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;

  try {
    const res = await fetch(MODELS_URL, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) throw new Error(`models api ${res.status}`);
    const body = (await res.json()) as {
      data?: { id: string; display_name?: string; created_at?: string }[];
    };
    const rows = body.data ?? [];
    if (rows.length === 0) return cache?.models ?? FALLBACK_MODELS;
    // Newest first — created_at is an ISO string, so a lexical sort orders it.
    const models = rows
      .slice()
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
      .map(toOption);
    cache = { at: Date.now(), models };
    return models;
  } catch {
    return cache?.models ?? FALLBACK_MODELS;
  }
}
