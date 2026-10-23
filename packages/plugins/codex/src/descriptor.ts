/**
 * Codex's provider descriptor — the static facts the rest of Dispatch labels,
 * picks and accounts it by. Registered with the host by `activate` in
 * `main.ts`. It moved here from `@dispatch/shared` when Codex became a
 * shipped plugin, so the host compiles without knowing Codex exists.
 */
import type { ModelOption, ProviderDescriptor } from "@dispatch/shared";

/**
 * Codex's equivalent seed list.
 *
 * Unlike Claude's, these are concrete ids rather than aliases — Codex's
 * `model/list` has no "default" alias, it flags one row `isDefault`. A stale
 * entry here therefore degrades to a dead id rather than a wrong label, which
 * is why the live list is always preferred and this is only ever a last resort.
 *
 * It is also what an agent finds when it greps the built app for model ids, so
 * it must mirror the live catalogue (`~/.codex/models_cache.json`, rows with
 * `visibility: "list"`, in priority order). It once topped out at GPT-5.6-Sol
 * after GPT-6-Astra shipped, and a chat told to use Astra concluded from this
 * list that no such model existed.
 */
export const FALLBACK_MODELS_CODEX: ModelOption[] = [
  {
    value: "gpt-6-astra",
    label: "GPT-6-Astra",
    hint: "recommended",
    description: "Our most capable model for complex, demanding work.",
  },
  { value: "gpt-5.6-sol", label: "GPT-5.6-Sol", description: "Reliable agentic workhorse for everyday tasks." },
  { value: "gpt-5.6-terra", label: "GPT-5.6-Terra", description: "Balanced agentic coding model for everyday work." },
  // `hint: "fast"` is load-bearing: CodexHarness picks the title model by it.
  // The catalogue's own "fast and affordable" row; gpt-5.4-mini, which held it
  // before, is gone from the catalogue.
  { value: "gpt-5.6-luna", label: "GPT-5.6-Luna", hint: "fast", description: "Fast and affordable agentic coding model." },
  { value: "gpt-5.5", label: "GPT-5.5", description: "Proven previous-generation model for coding and general work." },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark", description: "Ultra-fast coding model." },
];

export const CODEX_PROVIDER: ProviderDescriptor = {
  id: "codex",
  label: "Codex",
  shortLabel: "Codex",
  blurb: "OpenAI's agent CLI, driven over its app-server protocol.",
  fallbackModels: FALLBACK_MODELS_CODEX,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  // Codex has multi-agent collaboration, but not Dispatch-authored agent
  // definitions with their own prompt/model/effort.
  subagents: false,
  skillsDir: ".agents",
  account: {
    configDirEnv: "CODEX_HOME",
    defaultConfigDir: ".codex",
    loginFile: "auth.json",
    loginCommand: "codex login",
  },
};
