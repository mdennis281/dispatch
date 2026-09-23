/**
 * The provider registry — the static facts about each agent runtime that more
 * than one package needs.
 *
 * Before this existed every surface answered "what is Codex like" for itself:
 * the settings pane looped over a `["claude", "codex"]` literal, the setup
 * wizard kept its own label table, the broker picked a skills dir with a
 * ternary, and `defaultModelFor` special-cased Codex. Each of those was correct
 * for two providers and silently wrong for a third — a new runtime would have
 * rendered as "Claude" in every label that tested `=== "codex"`.
 *
 * The `satisfies Record<HarnessKind, …>` below is what makes adding a provider
 * one registration: put its id in `HarnessKindSchema`, and the compiler refuses
 * to build until it has a row here (and a `Harness` in the server registry).
 *
 * Only facts that are true of the runtime WITHOUT asking it belong here. What a
 * live runtime reports (installed version, the live model catalogue, the
 * account's limits) stays on the server `Harness`, and its capability object
 * remains the authority the UI reads once `/api/harnesses` has answered.
 */
import {
  DEFAULT_HARNESS,
  HarnessKindSchema,
  type Effort,
  type HarnessKind,
  type ModelOption,
} from "./common.js";

export interface ProviderDescriptor {
  id: HarnessKind;
  /** Product name, for pickers and headings: "Claude Code". */
  label: string;
  /** Sender name on a transcript row: "Claude". */
  shortLabel: string;
  /** One line for the setup wizard. */
  blurb: string;
  /**
   * The model id an unpinned chat sends. Undefined means send none and let the
   * runtime pick — Codex has no "default" alias, it flags a catalogue row.
   */
  defaultModel?: string;
  /** Seed catalogue for before (or instead of) a live probe. */
  fallbackModels: ModelOption[];
  /** Effort levels, until the live capability object has loaded. */
  efforts: Effort[];
  /**
   * Dispatch-authored agent definitions (own prompt/model/effort) can run
   * here. Gates whether a chat keeps its `agentId` on this provider.
   */
  subagents: boolean;
  /**
   * Directory under a checkout where this runtime discovers skills — where
   * `materializeSkills` writes them.
   */
  skillsDir: string;
  /**
   * How a login account is selected for this runtime. Every provider Dispatch
   * drives keeps its login in a config directory the CLI's own login flow
   * writes, and picks that directory from an env var — which is what lets a
   * subscription be nothing more than a directory, with no token ever passing
   * through Dispatch.
   */
  account: {
    /** Env var naming the config dir, e.g. `CLAUDE_CONFIG_DIR`. */
    configDirEnv: string;
    /** The config dir when that var is unset, relative to the home directory. */
    defaultConfigDir: string;
    /**
     * File whose presence in the config dir means a login exists. Only ever
     * checked for EXISTENCE by the settings pane — never read for display.
     */
    loginFile: string;
    /**
     * Set when an account for this provider selects an ENDPOINT rather than a
     * login directory — and the env var that carries it.
     *
     * The hosted providers keep one login per config dir, so "which account"
     * and "which directory" are the same question. A local-model provider has
     * no login at all; what actually distinguishes one goose account from
     * another is WHICH MACHINE IS SERVING THE MODELS. A laptop's own Ollama and
     * the workstation with the 3090 in it are different accounts in every sense
     * that matters — different model lists, different speed, different cost —
     * and nothing about a config dir can express that.
     *
     * Absent for claude and codex, whose endpoint is not the user's to choose.
     */
    endpointEnv?: string;
    /** Where that provider looks when no account names a host. */
    defaultEndpoint?: string;
    /** Field label in the accounts pane, e.g. "Ollama host". */
    endpointLabel?: string;
  };
}

/**
 * The app's default session model when a Claude chat hasn't pinned one.
 * "default" is a real runtime alias meaning "whatever Claude Code recommends
 * today", so an unpinned chat tracks the recommendation instead of freezing on
 * the model that happened to be best when this line was written.
 */
export const DEFAULT_MODEL = "default";

/**
 * Static Claude model list used only when the live list can't be read from the
 * runtime (see server `services/models.ts`), and as the client's pre-fetch seed
 * so the picker never renders empty. Deliberately ALIASES, not dated wire ids:
 * aliases keep resolving to the current model as new ones ship, so a stale
 * fallback degrades to "slightly wrong labels" instead of "unselectable dead ids".
 */
export const FALLBACK_MODELS: ModelOption[] = [
  { value: "default", label: "Default", hint: "recommended" },
  { value: "opus", label: "Opus", hint: "deepest" },
  { value: "sonnet", label: "Sonnet", hint: "balanced" },
  { value: "haiku", label: "Haiku", hint: "fast" },
];

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

/**
 * Seed model list for an ACP agent running local models.
 *
 * Unlike Claude's aliases and Codex's catalogue, these ids belong to whatever
 * Ollama instance the agent is pointed at, so there is no list that is correct
 * for every install. `AcpHarness.listModels` therefore asks Ollama's `/api/tags`
 * for the REAL list and this is only what the picker shows when that endpoint
 * can't be reached — chosen as the models most commonly pulled for agentic
 * coding, so a stale entry degrades to "not on this box" rather than a
 * plausible-looking id that silently 404s at turn start.
 */
export const FALLBACK_MODELS_GOOSE: ModelOption[] = [
  {
    value: "qwen3-coder:30b",
    label: "qwen3-coder:30b",
    hint: "recommended",
    description: "MoE coding model; ~19GB at Q4, fits a 24GB card with room for context.",
  },
  {
    value: "qwen3:30b-a3b-instruct-2507-q4_K_M",
    label: "qwen3:30b-a3b",
    description: "General MoE instruct model with solid tool calling.",
  },
  { value: "devstral:24b", label: "devstral:24b", description: "Tuned for agentic edit loops." },
  { value: "qwen2.5:14b", label: "qwen2.5:14b", hint: "fast", description: "Smaller, quicker, weaker at long tool chains." },
];

export const PROVIDERS = {
  claude: {
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
    },
  },
  codex: {
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
    },
  },
  goose: {
    id: "goose",
    label: "goose",
    shortLabel: "goose",
    blurb: "Open-source agent driven over the Agent Client Protocol. Runs local models via Ollama.",
    // No "default" alias: an Ollama model id is concrete, and which ids exist
    // is a fact about the box the models are pulled on. An unpinned chat sends
    // none and lets the agent's own configured model stand.
    fallbackModels: FALLBACK_MODELS_GOOSE,
    // ACP has NO reasoning-effort concept — there is no field on session/new or
    // session/prompt to carry one. Empty rather than a plausible ladder, so the
    // composer hides the control instead of rendering one that does nothing.
    efforts: [],
    subagents: false,
    // goose discovers skills in `.agents/skills` — the same directory Codex
    // uses, verified with `goose skills list`. So `materializeSkills` needs no
    // new branch for this provider.
    skillsDir: ".agents",
    account: {
      // goose resolves its config dir from the platform's config location and
      // honours no override env var (probed: GOOSE_CONFIG_DIR, GOOSE_HOME and
      // XDG_CONFIG_HOME all leave `goose info` pointing at the default). The
      // var below is therefore inert, which is harmless: a local model needs no
      // login, so a directory is not what a second goose account selects.
      //
      // The ENDPOINT is. See `endpointEnv` below: one account is the Ollama on
      // this machine, another is the box with the big GPU, and a chat picks
      // between them exactly the way it picks between two Claude logins.
      configDirEnv: "GOOSE_CONFIG_DIR",
      // Correct on Linux/macOS. Windows keeps it under
      // `AppData/Roaming/Block/goose/config`; the only thing that reads this is
      // the settings pane's "is there a login" dot, which is cosmetic here.
      defaultConfigDir: ".config/goose",
      loginFile: "config.yaml",
      endpointEnv: "OLLAMA_HOST",
      // Ollama's own default. Note this is the SERVER's loopback, not the
      // user's: an install that never sets a host talks to whatever is running
      // beside Dispatch, which is very often not the machine holding the
      // models they meant. That silent mismatch is what accounts fix.
      defaultEndpoint: "http://127.0.0.1:11434",
      endpointLabel: "Ollama host",
    },
  },
} as const satisfies Record<HarnessKind, ProviderDescriptor>;

/** Every provider id, in the order pickers list them. */
export const PROVIDER_IDS: readonly HarnessKind[] = HarnessKindSchema.options;

/**
 * The descriptor for a provider id. An absent id is a legacy row written when
 * Claude was the only provider, so it resolves to the default; an unknown
 * string (a provider removed since the row was written) does too, because a
 * label that says the wrong name beats a surface that throws.
 */
export function providerFor(id: HarnessKind | string | undefined | null): ProviderDescriptor {
  return (PROVIDERS as Record<string, ProviderDescriptor>)[id ?? ""] ?? PROVIDERS[DEFAULT_HARNESS];
}

/** Every provider descriptor, in picker order. */
export function listProviders(): ProviderDescriptor[] {
  return PROVIDER_IDS.map((id) => PROVIDERS[id]);
}

/** The seed model list for a provider, used before/instead of a live probe. */
export function fallbackModels(harness: HarnessKind): ModelOption[] {
  return providerFor(harness).fallbackModels;
}

/**
 * The default model id for a provider when a chat hasn't pinned one.
 *
 * Claude has a real "default" alias it resolves server-side; Codex does not, so
 * an unpinned Codex chat sends no model at all and lets `thread/start` pick.
 */
export function defaultModelFor(harness: HarnessKind): string | undefined {
  return providerFor(harness).defaultModel;
}
