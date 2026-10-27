/**
 * Claude Code's provider descriptor — the static facts the rest of Dispatch
 * labels, picks and accounts it by. Registered with the host by `activate` in
 * `main.ts`. It moved here from `@dispatch/shared` when Claude became a
 * shipped plugin (#428), so the host compiles without knowing Claude exists —
 * and an install with this plugin switched off has no "Claude" anywhere it
 * could be offered from.
 */
import type { ModelOption, ProviderDescriptor } from "@dispatch/shared";

/**
 * The model an unpinned Claude chat sends. "default" is a real runtime alias
 * meaning "whatever Claude Code recommends today", so an unpinned chat tracks
 * the recommendation instead of freezing on the model that happened to be best
 * when this line was written.
 */
export const DEFAULT_MODEL = "default";

/**
 * Static Claude model list used only when the live list can't be read from the
 * runtime (see `models.ts`), and as the client's pre-fetch seed so the picker
 * never renders empty. Deliberately ALIASES, not dated wire ids: aliases keep
 * resolving to the current model as new ones ship, so a stale fallback degrades
 * to "slightly wrong labels" instead of "unselectable dead ids".
 */
export const FALLBACK_MODELS: ModelOption[] = [
  { value: "default", label: "Default", hint: "recommended" },
  { value: "opus", label: "Opus", hint: "deepest" },
  { value: "sonnet", label: "Sonnet", hint: "balanced" },
  { value: "haiku", label: "Haiku", hint: "fast" },
];

export const CLAUDE_PROVIDER: ProviderDescriptor = {
  id: "claude",
  label: "Claude Code",
  shortLabel: "Claude",
  blurb: "Anthropic's agent CLI. Subagents, skills and the full MCP tool surface.",
  defaultModel: DEFAULT_MODEL,
  fallbackModels: FALLBACK_MODELS,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  subagents: true,
  skillsDir: ".claude",
  account: {
    configDirEnv: "CLAUDE_CONFIG_DIR",
    defaultConfigDir: ".claude",
    loginFile: ".credentials.json",
    loginCommand: "claude auth login",
  },
};
