/**
 * What a chat RUNS as — harness, account, mode, effort, model — resolved once,
 * the same way, for every path that needs it.
 *
 * Three code paths used to decide this independently: `createChat` (an inline
 * `??` chain), `broker.spawnChat` (its own chain, which inherited the parent's
 * provider and model but forgot effort and mode), and the broker's session
 * builder (which read whatever `createChat` had snapshotted into the chat row).
 * The project layer — `.dispatch/project.yaml` → `defaults.{harness,mode,
 * effort,model}` — was parsed by the config loader and read by none of them.
 *
 * The layers, most specific first:
 *
 *   chat     what the chat itself pins (or, at creation, what the request asked
 *            for — a caller passes a value ONLY when the human chose one)
 *   parent   for a spawned chat, what the chat that spawned it runs as. A child
 *            is an extension of its parent, so it inherits the parent's posture
 *            before it looks at the project's
 *   project  `defaults` in the project manifest — committed, so a repo can say
 *            "work here starts in plan mode at high effort"
 *   app      `harness.defaults[<provider>]` and `defaultModeId` in app settings
 *   default  the built-in floor
 *
 * Absent means inherit at every layer, and a chat row that pins nothing keeps
 * tracking the layers below it as they change — the resolver is called when a
 * value is NEEDED (session start, the composer's badge), not once at creation.
 *
 * Two fields are provider-bound and resolve differently from the rest:
 *
 *   - A MODEL id belongs to one provider's catalogue. The parent's and the
 *     project's model apply only when the chat lands on the SAME provider they
 *     were authored for; otherwise that provider's own app default applies.
 *     This is the rule that stops a Codex child of a Claude parent wearing a
 *     Claude model id (see `spawned-chats-inherit-parent-provider-and-model`).
 *   - An ACCOUNT belongs to one provider too, and names it: a request that
 *     pins an account without a harness lands on that account's provider.
 */
import { DEFAULT_HARNESS, type Effort, type HarnessKind } from "./common.js";
import { resolveChain, type LayerEntry } from "./layered.js";
import {
  findSubscription,
  pinnedIdOf,
  subscriptionFor,
  type ResolvedSubscription,
  type SubscriptionSettings,
} from "./subscriptions.js";
import { providerDefaults, type HarnessDefaults } from "./runtime-config.js";

/** Where a posture field's value came from. `parent` only exists for a spawn. */
export type PostureSource = "chat" | "parent" | "project" | "app" | "default";

/** One resolved posture field. */
export interface PostureValue<T> {
  effective: T;
  source: PostureSource;
  /** What this field falls back to if the chat's own pin were cleared. */
  inherited: T;
}

/** The chat layer: what the row pins, or what a create request asked for. */
export interface PostureChat {
  harness?: HarnessKind;
  subscriptionId?: string;
  modeId?: string;
  effort?: Effort;
  model?: string;
}

/**
 * The parent layer, for a spawned chat. `harness` and `subscriptionId` are the
 * parent's RESOLVED values (what it actually runs as), not its pins — a legacy
 * parent with no pin still hands down the account it runs under.
 */
export interface PostureParent {
  harness: HarnessKind;
  subscriptionId?: string;
  modeId?: string;
  effort?: Effort;
  model?: string;
}

/** The project layer: `defaults` from the manifest. */
export interface PostureProject {
  harness?: HarnessKind;
  mode?: string;
  effort?: Effort;
  model?: string;
}

/** The app layer: the slice of settings posture reads. */
export interface PostureSettings extends SubscriptionSettings {
  defaultModeId?: string;
  harness?: {
    defaultHarness?: HarnessKind;
    defaults?: Partial<Record<HarnessKind, HarnessDefaults>>;
  };
}

export interface PostureLayers {
  chat?: PostureChat;
  parent?: PostureParent;
  project?: PostureProject | null;
  settings?: PostureSettings | null;
}

export interface ChatPosture {
  harness: PostureValue<HarnessKind>;
  /** The resolved account; pin `pinnedIdOf(subscription.effective)` on the row. */
  subscription: PostureValue<ResolvedSubscription>;
  modeId: PostureValue<string>;
  effort: PostureValue<Effort>;
  /** `undefined` means the provider's own recommendation — a real, valid answer. */
  model: PostureValue<string | undefined>;
}

/** The floor for mode. `auto` is what every UI entry point pinned before the
 *  pins were removed, so an unconfigured install keeps its posture. */
export const DEFAULT_MODE_ID = "auto";
/** The floor for effort. */
export const DEFAULT_EFFORT: Effort = "medium";

/**
 * The provider a project's OWN defaults are authored for: its pinned harness,
 * else the app's default. Exported because the project pane's model picker
 * has to list this provider's catalogue, not the app default's.
 */
export function projectHarnessOf(
  project: PostureProject | null | undefined,
  settings: PostureSettings | null | undefined,
): HarnessKind {
  return project?.harness ?? settings?.harness?.defaultHarness ?? DEFAULT_HARNESS;
}

function field<T>(entries: readonly LayerEntry<PostureSource, T>[], fallback: T): PostureValue<T> {
  const { effective, source, inherited } = resolveChain<PostureSource, T>(entries, fallback);
  // `inherited` from the chain is "the next layer down from whichever answered".
  // For the UI's reset affordance we want "what applies if the CHAT's pin goes",
  // which is the same thing when the chat answered and `effective` otherwise.
  return { effective, source, inherited: source === "chat" ? inherited : effective };
}

/** Resolve every posture field for a chat. Pure; safe with every layer absent. */
export function resolveChatPosture(layers: PostureLayers): ChatPosture {
  const { chat, parent, project, settings } = layers;

  // A pinned account names its provider. Only honoured when it exists — a stale
  // id must not throw a chat onto a provider nothing asked for.
  const pinnedAccount = findSubscription(settings, chat?.subscriptionId);
  const harness = field<HarnessKind>(
    [
      ["chat", chat?.harness ?? pinnedAccount?.provider],
      ["parent", parent?.harness],
      ["project", project?.harness ?? undefined],
      ["app", settings?.harness?.defaultHarness],
    ],
    DEFAULT_HARNESS,
  );
  const provider = harness.effective;
  const appDefaults = providerDefaults(settings?.harness, provider);

  // Account: `subscriptionFor` already walks pin → app default → first for the
  // provider, and ignores a pin on another provider. The chain here only has to
  // decide WHICH pin to hand it and report where the answer came from.
  const chatAccountId =
    pinnedAccount && pinnedAccount.provider === provider ? pinnedAccount.id : undefined;
  const parentAccountId =
    parent && parent.harness === provider ? parent.subscriptionId : undefined;
  const wantedAccount = chatAccountId ?? parentAccountId;
  const subscriptionEffective = subscriptionFor(settings, provider, wantedAccount);
  const subscriptionSource: PostureSource = chatAccountId
    ? "chat"
    : parentAccountId
      ? "parent"
      : appDefaults.subscriptionId && subscriptionEffective.id === appDefaults.subscriptionId
        ? "app"
        : "default";
  const subscription: PostureValue<ResolvedSubscription> = {
    effective: subscriptionEffective,
    source: subscriptionSource,
    inherited:
      subscriptionSource === "chat"
        ? subscriptionFor(settings, provider, parentAccountId)
        : subscriptionEffective,
  };

  const modeId = field<string>(
    [
      ["chat", chat?.modeId],
      ["parent", parent?.modeId],
      ["project", project?.mode ?? undefined],
      ["app", settings?.defaultModeId],
    ],
    DEFAULT_MODE_ID,
  );

  const effort = field<Effort>(
    [
      ["chat", chat?.effort],
      ["parent", parent?.effort],
      ["project", project?.effort ?? undefined],
      ["app", appDefaults.effort],
    ],
    DEFAULT_EFFORT,
  );

  // Provider-bound: a model authored for another provider is skipped, not
  // carried. The app layer is per provider by construction.
  const projectProvider = projectHarnessOf(project, settings);
  const model = field<string | undefined>(
    [
      ["chat", chat?.model],
      ["parent", parent && parent.harness === provider ? parent.model : undefined],
      ["project", project && projectProvider === provider ? (project.model ?? undefined) : undefined],
      ["app", appDefaults.model],
    ],
    undefined,
  );

  return { harness, subscription, modeId, effort, model };
}

/**
 * The fields to PERSIST on a new chat row from a resolved posture.
 *
 * The harness and account are always pinned at creation: a native session id
 * belongs to one runtime and one config dir, so a later change of default must
 * not move the chat away from the session it wrote. Mode, effort and model are
 * pinned only when the request chose them or the parent handed them down — a
 * spawned child copies its parent's pins the way it always copied its model —
 * and left ABSENT when the project or app answered, so the row keeps tracking
 * those layers as they change instead of freezing today's default into it.
 */
export function pinnedPostureFields(posture: ChatPosture): {
  harness: HarnessKind;
  subscriptionId?: string;
  modeId?: string;
  effort?: Effort;
  model?: string;
} {
  const subscriptionId = pinnedIdOf(posture.subscription.effective);
  const pinned = <T>(v: PostureValue<T>): T | undefined =>
    v.source === "chat" || v.source === "parent" ? v.effective : undefined;
  const modeId = pinned(posture.modeId);
  const effort = pinned(posture.effort);
  const model = pinned(posture.model);
  return {
    harness: posture.harness.effective,
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(modeId !== undefined ? { modeId } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}
