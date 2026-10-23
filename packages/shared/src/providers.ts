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
 * The `satisfies Record<BuiltinHarnessKind, …>` below is what makes adding a
 * BUILT-IN provider one registration: put its id in `BUILTIN_HARNESS_KINDS`,
 * and the compiler refuses to build until it has a row here (and a `Harness` in
 * the server registry). Any other provider arrives at runtime through
 * {@link registerProvider} — the server registers it beside its `Harness`, and
 * the client learns it from `/api/harnesses`.
 *
 * Only facts that are true of the runtime WITHOUT asking it belong here. What a
 * live runtime reports (installed version, the live model catalogue, the
 * account's limits) stays on the server `Harness`, and its capability object
 * remains the authority the UI reads once `/api/harnesses` has answered.
 */
import {
  BUILTIN_HARNESS_KINDS,
  DEFAULT_HARNESS,
  HarnessKindSchema,
  type BuiltinHarnessKind,
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
   * Set only on the placeholder {@link providerFor} synthesizes for an id
   * nothing has registered — a row written by a provider that has since been
   * uninstalled. Callers that would otherwise act on the account fields (spawn
   * env, "is there a login") check this instead of trusting empty strings.
   */
  unregistered?: true;
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
     * The command a human runs to log in, for the setup card. Absent when there
     * is nothing to log into (a local model).
     */
    loginCommand?: string;
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

export const BUILTIN_PROVIDERS = {
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
      loginCommand: "claude auth login",
    },
  },
} as const satisfies Record<BuiltinHarnessKind, ProviderDescriptor>;

/**
 * Every provider this process knows about, in picker order: the built-ins,
 * then whatever was registered at runtime. Module state on purpose — the server
 * and the client each hold exactly one catalogue, and threading a registry
 * object through every label call would touch a hundred call sites to buy
 * nothing.
 */
const registry = new Map<HarnessKind, ProviderDescriptor>(
  BUILTIN_HARNESS_KINDS.map((id) => [id, BUILTIN_PROVIDERS[id]]),
);

/**
 * Add (or refresh) a provider's descriptor.
 *
 * Idempotent on purpose: the client re-registers everything every time
 * `/api/harnesses` answers, and the server's copy of a descriptor is the
 * authority over the static one compiled into the bundle.
 */
export function registerProvider(descriptor: ProviderDescriptor): void {
  const parsed = HarnessKindSchema.safeParse(descriptor.id);
  if (!parsed.success) throw new Error(`invalid provider id "${descriptor.id}"`);
  if (descriptor.unregistered) throw new Error(`cannot register a placeholder for "${descriptor.id}"`);
  registry.set(descriptor.id, descriptor);
}

/**
 * Drop a provider registered at runtime — its plugin was switched off. A
 * built-in cannot be dropped: it is the fallback a chat on the dropped
 * provider resolves to.
 */
export function unregisterProvider(id: HarnessKind): void {
  if ((BUILTIN_HARNESS_KINDS as readonly string[]).includes(id)) {
    throw new Error(`cannot unregister built-in provider "${id}"`);
  }
  registry.delete(id);
}

/** True when something has registered this id (built-ins always have). */
export function isKnownProvider(id: string | undefined | null): id is HarnessKind {
  return Boolean(id) && registry.has(id!);
}

/** Every known provider id, in the order pickers list them. */
export function providerIds(): HarnessKind[] {
  return [...registry.keys()];
}

/**
 * The stand-in for an id nothing registered. It names the provider by its id
 * rather than borrowing Claude's descriptor, which is what this used to do —
 * so a chat from an uninstalled provider rendered as "Claude" everywhere, and
 * its account resolved to Claude's login directory.
 */
function unregisteredProvider(id: HarnessKind): ProviderDescriptor {
  return {
    id,
    label: id,
    shortLabel: id,
    blurb: "This provider is not installed.",
    fallbackModels: [],
    efforts: [],
    subagents: false,
    skillsDir: ".agents",
    account: { configDirEnv: "", defaultConfigDir: "", loginFile: "" },
    unregistered: true,
  };
}

/**
 * The descriptor for a provider id. An absent id is a legacy row written when
 * Claude was the only provider, so it resolves to the default. An id nothing
 * has registered gets a placeholder named after itself — see
 * {@link unregisteredProvider} for why that is no longer Claude.
 */
export function providerFor(id: HarnessKind | undefined | null): ProviderDescriptor {
  if (!id) return registry.get(DEFAULT_HARNESS)!;
  return registry.get(id) ?? unregisteredProvider(id);
}

/** Every provider descriptor, in picker order. */
export function listProviders(): ProviderDescriptor[] {
  return [...registry.values()];
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
