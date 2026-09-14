/**
 * The one way a layered setting resolves.
 *
 * Dispatch has three places a setting can be set — the app (`config/`, this
 * install), the project (`.dispatch/project.yaml`, this repo) and the chat (its
 * `.data` row) — and for a long time every setting that lived in more than one
 * of them resolved through its own inline `??` chain. Those chains disagreed in
 * ways nobody could see from any one of them: `showInjectedContext` resolved
 * client-side and could never go back to "inherit"; `effort` and `mode` were
 * snapshotted into the chat at creation while `shellFilter` inherited live;
 * project `defaults.mode/effort/model` were parsed and read by nothing; and no
 * UI could say WHERE a value came from because no chain reported that.
 *
 * So there is one resolver, shaped like `resolveMcpEnablement` (which keeps its
 * own extra `alwaysOn` semantics): it takes every layer, returns the effective
 * value, names the layer that answered, and keeps each layer's own value
 * visible so a control can render "inheriting X from the project" without
 * re-deriving the chain. `undefined` at a layer ALWAYS means "inherit" — which
 * is why a setting that can legitimately be `false` or `[]` still round-trips:
 * only absence falls through.
 */

/** Where a layered value can be set, most specific first. */
export type LayerScope = "chat" | "project" | "app";

/** Which layer answered — `default` when none of them pinned a value. */
export type LayerSource = LayerScope | "default";

/** The three settable layers. Absent ⇒ inherit from the next one down. */
export interface Layers<T> {
  chat?: T;
  project?: T;
  app?: T;
}

/** A resolved layered value, with every layer's own answer kept visible. */
export interface Layered<T> extends Layers<T> {
  /** What applies. */
  effective: T;
  /** Which layer produced `effective`. */
  source: LayerSource;
  /** What applies when no layer pins it. */
  byDefault: T;
  /**
   * What THIS value would be if the most specific pin were cleared — the
   * answer a "reset to inherit" affordance shows before it is clicked. Equal
   * to `effective` when nothing more specific than the project is set.
   */
  inherited: T;
}

/** One entry of an explicit chain: a named layer and what it says, if anything. */
export type LayerEntry<S extends string, T> = readonly [scope: S, value: T | undefined];

/**
 * The general form: walk an ORDERED list of named layers and take the first one
 * that has a value. `resolveLayered` is the three-layer case of this; the
 * new-chat posture resolver needs it directly because a spawned chat has a
 * fourth layer (its parent) sitting between the request and the project.
 */
export function resolveChain<S extends string, T>(
  entries: readonly LayerEntry<S, T>[],
  fallback: T,
): {
  effective: T;
  source: S | "default";
  /** The value BENEATH the answering layer — what clearing that pin reveals. */
  inherited: T;
} {
  let effective: T = fallback;
  let source: S | "default" = "default";
  let found = false;
  let inherited: T = fallback;
  let inheritedFound = false;
  for (const [scope, value] of entries) {
    if (value === undefined) continue;
    if (!found) {
      effective = value;
      source = scope;
      found = true;
      continue;
    }
    if (!inheritedFound) {
      inherited = value;
      inheritedFound = true;
      break;
    }
  }
  return { effective, source, inherited };
}

/**
 * Resolve chat → project → app → `fallback`.
 *
 * Pure and total: every layer may be absent, and the result always carries a
 * value and a source. Callers that only have two layers (an app-level pane
 * resolving project → app) just omit `chat`.
 */
export function resolveLayered<T>(layers: Layers<T>, fallback: T): Layered<T> {
  const { effective, source, inherited } = resolveChain<LayerScope, T>(
    [
      ["chat", layers.chat],
      ["project", layers.project],
      ["app", layers.app],
    ],
    fallback,
  );
  return {
    ...(layers.chat !== undefined ? { chat: layers.chat } : {}),
    ...(layers.project !== undefined ? { project: layers.project } : {}),
    ...(layers.app !== undefined ? { app: layers.app } : {}),
    effective,
    source,
    byDefault: fallback,
    // "If the CHAT's pin were cleared", not "the layer under whichever answered":
    // a project-sourced value has no chat pin to clear, so it inherits itself.
    inherited: source === "chat" ? inherited : effective,
  };
}

/**
 * The sentence a control uses to say where its value came from. One phrasing
 * for every layered setting, so the injected-context toggle, the effort picker
 * and the project pane all describe inheritance the same way.
 */
export function layerSourceLabel(source: LayerSource, defaultLabel = "built-in default"): string {
  switch (source) {
    case "chat":
      return "set for this chat";
    case "project":
      return "from this project's config";
    case "app":
      return "from your app settings";
    default:
      return defaultLabel;
  }
}
