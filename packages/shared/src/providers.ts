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
 * It starts EMPTY. Every provider arrives at runtime through
 * {@link registerProvider}: the server registers a plugin's descriptor beside
 * its `Harness`, and the client learns it from `/api/harnesses`. Claude's
 * descriptor lived here, compiled in, until it became a plugin (#428) — which
 * kept "Claude Code" in every picker of an install that had no Claude.
 *
 * Only facts that are true of the runtime WITHOUT asking it belong here. What a
 * live runtime reports (installed version, the live model catalogue, the
 * account's limits) stays on the server `Harness`, and its capability object
 * remains the authority the UI reads once `/api/harnesses` has answered.
 */
import {
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
 * Every provider this process knows about, in registration order. Module state on purpose — the server
 * and the client each hold exactly one catalogue, and threading a registry
 * object through every label call would touch a hundred call sites to buy
 * nothing.
 */
const registry = new Map<HarnessKind, ProviderDescriptor>();

/**
 * Add (or refresh) a provider's descriptor.
 *
 * Idempotent on purpose: the client re-registers everything every time
 * `/api/harnesses` answers, and the server's copy of a descriptor is the
 * authority over anything a client cached.
 */
export function registerProvider(descriptor: ProviderDescriptor): void {
  const parsed = HarnessKindSchema.safeParse(descriptor.id);
  if (!parsed.success) throw new Error(`invalid provider id "${descriptor.id}"`);
  if (descriptor.unregistered) throw new Error(`cannot register a placeholder for "${descriptor.id}"`);
  registry.set(descriptor.id, descriptor);
}

/**
 * Drop a provider's descriptor — its plugin was switched off, or (on the
 * client) the server stopped listing it.
 *
 * Any provider may be dropped, Claude included. It used to be refused for
 * Claude, the fallback every chat on a dropped provider resolved to; there is
 * no fallback any more (#426) and nothing compiled in (#428).
 */
export function unregisterProvider(id: HarnessKind): void {
  registry.delete(id);
}

/** True when something has registered this id. */
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
 * The stand-in for NO provider at all — a chat or project nothing ever pointed
 * at one. Its id is empty, which no real provider can have (`HarnessKindSchema`
 * refuses it), so it can never be mistaken for, or registered as, a real one.
 */
const NO_PROVIDER: ProviderDescriptor = {
  ...unregisteredProvider(""),
  label: "No provider",
  shortLabel: "No provider",
  blurb: "No provider is chosen.",
};

/**
 * The descriptor for a provider id. Never throws and never answers undefined:
 * an id nothing has registered gets a placeholder named after itself (see
 * {@link unregisteredProvider} for why that is no longer Claude), and an absent
 * id gets {@link NO_PROVIDER}.
 *
 * An absent id used to mean "a legacy row written when Claude was the only
 * provider" and answered `registry.get("claude")!` — undefined the moment
 * Claude stopped being registered, and every sender label on every chat row
 * crashed with it. Those legacy rows are backfilled to an explicit `"claude"`
 * by the store now (#426), so absent genuinely means none.
 */
export function providerFor(id: HarnessKind | undefined | null): ProviderDescriptor {
  if (!id) return NO_PROVIDER;
  return registry.get(id) ?? unregisteredProvider(id);
}

/* ------------------------------------------------------ provider availability */

/**
 * The code a refused turn, chat creation or provider switch carries — on an
 * HTTP error body, on a WS `error` event, and on {@link ProviderUnavailable}.
 * One literal so a client can recognise the refusal without matching prose.
 */
export const PROVIDER_UNAVAILABLE = "provider-unavailable" as const;

/**
 * Why a chat cannot run on its provider.
 *
 *  - `unset`         — nothing names a provider (no chat pin, no project or app
 *                      default).
 *  - `unregistered`  — the named provider is not registered: its plugin is
 *                      disabled, uninstalled, or has not activated.
 *  - `not-installed` — registered, but its runtime reports itself unavailable
 *                      (`HarnessRuntimeInfo.available === false`): the CLI it
 *                      drives is missing.
 *  - `logged-out`    — installed, and its own login probe (`Harness.probeLogin`)
 *                      last said the account is NOT logged in. Without this a
 *                      chat on a provider with no login found out by failing
 *                      mid-turn on the runtime's auth error (#428).
 *
 * `logged-out` is judged off a CACHED probe (see the server's
 * `ProviderLogins`), never one per send, and only a probe that actually ran
 * and said "no" counts: a probe that could not run, or a provider with nothing
 * to log into, never refuses a turn.
 */
export type ProviderUnavailableReason = "unset" | "unregistered" | "not-installed" | "logged-out";

/**
 * A chat's provider is not able to run it. Derived, never stored: it is a fact
 * about the chat's `harness` and what is registered RIGHT NOW, which is what
 * makes a chat recover on its own the moment its provider comes back — there
 * is no flag on the row for anything to remember to clear.
 */
export interface ProviderUnavailable {
  code: typeof PROVIDER_UNAVAILABLE;
  /** The provider the chat names; absent for `unset`. */
  provider?: HarnessKind;
  reason: ProviderUnavailableReason;
  /** One human sentence, for a notice or a 409 body. */
  message: string;
}

/** The minimum of a registered harness this module needs to judge availability. */
export interface RegisteredRuntime {
  kind: HarnessKind;
  runtime: { available: boolean };
  /**
   * The last login probe for the account in question, when one has run.
   * Absent means "not known yet", which is never a refusal.
   */
  login?: { checked: boolean; loggedIn: boolean; notRequired?: boolean };
}

/**
 * Can a chat on `provider` run, given what is registered? `null` means yes.
 *
 * The ONE judgement both halves make: the server's `HarnessRegistry.resolve`
 * passes its live harnesses, the client passes the `/api/harnesses` list. Two
 * copies of this rule would disagree about exactly one case, and that case
 * would be a composer that offers Send for a turn the server refuses.
 */
export function providerAvailability(
  provider: HarnessKind | undefined | null,
  registered: ReadonlyArray<RegisteredRuntime>,
): ProviderUnavailable | null {
  if (!provider) {
    return {
      code: PROVIDER_UNAVAILABLE,
      reason: "unset",
      message: "No provider is chosen for this chat.",
    };
  }
  const found = registered.find((h) => h.kind === provider);
  const label = providerFor(provider).label;
  if (!found) {
    return {
      code: PROVIDER_UNAVAILABLE,
      provider,
      reason: "unregistered",
      message: `${label} is not available — its provider plugin is disabled or not installed.`,
    };
  }
  if (!found.runtime.available) {
    return {
      code: PROVIDER_UNAVAILABLE,
      provider,
      reason: "not-installed",
      message: `${label} is not installed on this machine.`,
    };
  }
  if (isLoggedOut(found.login)) {
    const command = providerFor(provider).account.loginCommand;
    return {
      code: PROVIDER_UNAVAILABLE,
      provider,
      reason: "logged-out",
      message: command
        ? `${label} is not logged in — run \`${command}\`, then send again.`
        : `${label} is not logged in.`,
    };
  }
  return null;
}

/**
 * Did a login probe actually run and say "no"? The ONLY shape that refuses a
 * turn. `checked: false` is a probe that could not run (a missing binary, a
 * timeout) — refusing on that would turn a flaky probe into a dead chat.
 */
export function isLoggedOut(login: RegisteredRuntime["login"]): boolean {
  return !!login && login.checked && !login.loggedIn && !login.notRequired;
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
