/**
 * @dispatch/plugin-sdk — what a plugin author imports.
 *
 * The host's contract lives in `@dispatch/shared` (`plugin-manifest.ts`,
 * `plugin-api.ts`, `plugin-client-api.ts`); this package re-exports it under
 * one name and adds the three things an author needs that the host does not:
 * `definePlugin` / `defineClientPlugin` (typed identity helpers, so a module's
 * shape is checked where it is written), the Vite presets (`./vite`) that
 * build a client bundle against the host's globals shim and a dependency-free
 * server module, and `createTestContext` (`./testing`), a fake `PluginContext`
 * for unit-testing `activate` with no server.
 *
 * Versioned WITH the host: the API is additive within `PLUGIN_API_VERSION`,
 * and a plugin's `dispatch:` range in plugin.yaml is what the host checks.
 * The manifest schema and constants (`PluginManifestSchema`,
 * `PLUGIN_API_VERSION`, …) are on `@dispatch/plugin-sdk/manifest`.
 * See docs/plugins.md → "Authoring".
 */
import type { ClientPluginModule, PluginContext as HostPluginContext, PluginModule } from "@dispatch/shared";

/* ---------------------------------------------------------------- types */

export type {
  // manifest
  PluginManifest,
  PluginCapability,
  PluginOAuthClient,
  PluginProcess,
  PluginInfo,
  PluginStatus,
  PluginSettingsEntry,
  // server context
  PluginModule,
  PluginLog,
  PluginRouter,
  PluginRouteHandler,
  PluginChatSummary,
  PluginChatListQuery,
  PluginChatFindQuery,
  PluginChatView,
  PluginChatReadOptions,
  PluginChatState,
  PluginSendOptions,
  PluginSendResult,
  PluginAskResult,
  PluginProjectSummary,
  PluginMemoryInput,
  // client host
  ClientHost,
  ClientHostKit,
  ClientPluginModule,
  PluginChatRef,
  ComposerControlDef,
  SettingsSectionDef,
  PanelTabDef,
  ChatBadgeDef,
  DictationEngineDef,
  DictationEngine,
  DictationHandlers,
  TtsEngineDef,
  TtsEngine,
  ToastKind,
  PluginFetch,
  DispatchClientGlobals,
  KitButtonProps,
  KitIconButtonProps,
  KitSelectProps,
  KitSelectOption,
  KitMenuItemProps,
  KitDialogProps,
  KitTooltipProps,
  KitToggleProps,
  KitFieldProps,
  KitComponent,
  // the wire, for `ctx.bus.on` / `host.events.on` handlers
  WsServerEvent,
  WsServerEventType,
  AttentionItem,
  QuestionAnswer,
  ChatStatus,
  MemoryType,
} from "@dispatch/shared";

/*
 * NO VALUE re-exports from @dispatch/shared here, deliberately. This entry is
 * what `src/server.ts` and `src/client.tsx` import, and the presets INLINE
 * what they import: a single `export { PluginManifestSchema } from
 * "@dispatch/shared"` pulled shared's whole index — zod, yaml, every schema,
 * none of it tree-shakeable past module-level `z.object()` calls — into a
 * 400 kB client bundle and a 600 kB server module (measured on hello-slot
 * and event-forwarder). The schema and the constants live in `./manifest`,
 * for the tooling that wants them.
 */

/* ------------------------------------------------------------- requests */

/**
 * What a route handler receives, as the SDK types it.
 *
 * `@dispatch/shared` cannot name Fastify's request and reply (it has no
 * server dependency), so `PluginContext` there is generic over them. The host
 * narrows to the real Fastify types; this package narrows to the STRUCTURAL
 * subset every Fastify request and reply satisfies and that a plugin
 * actually reads. Typing against the subset keeps the SDK free of a Fastify
 * dependency and lets `createTestContext` hand a handler a plain object that
 * is honestly the same shape. A handler that needs more (`req.raw`, a
 * multipart stream) may cast to Fastify's types; the object IS one at runtime.
 */
export interface PluginRequest {
  method: string;
  /** Path + query, as Fastify reports it. */
  url: string;
  /** `:param` captures from the route's path. */
  params: Record<string, string | undefined>;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  /** The parsed JSON body (or whatever the content-type parser produced). */
  body: unknown;
}

export interface PluginReply {
  /** Set the status; chainable. */
  code(status: number): PluginReply;
  /** Set a response header; chainable. */
  header(name: string, value: string): PluginReply;
  /** Set the content type; chainable. */
  type(mime: string): PluginReply;
  /** Send the response. Returning a value from the handler does the same. */
  send(payload?: unknown): unknown;
  /** The status set so far. */
  readonly statusCode: number;
}

/** The server context as a plugin author sees it: route handlers get {@link PluginRequest} / {@link PluginReply}. */
export type PluginContext = HostPluginContext<PluginRequest, PluginReply>;

/** The shared generic, for a plugin that wants to name its own request/reply types (e.g. Fastify's). */
export type PluginContextOf<Req, Reply> = HostPluginContext<Req, Reply>;

/* -------------------------------------------------------------- helpers */

/**
 * A server module, typed where it is written. An identity function — the
 * host accepts a bare `export function activate` just as well — whose only
 * job is to make `activate(ctx)` infer {@link PluginContext} without an
 * import-and-annotate dance, and to fail the build when `deactivate` has the
 * wrong shape rather than at the host's 30 s budget.
 *
 * Export the result as `default` or as `plugin`; the host reads either.
 */
export function definePlugin(mod: {
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}): PluginModule {
  // The widening to the shared generic is sound: the host passes Fastify's
  // request and reply, which satisfy the structural subset above.
  return mod as PluginModule;
}

/** The client twin of {@link definePlugin}: `activate(host)` typed against `ClientHost`. */
export function defineClientPlugin(mod: ClientPluginModule): ClientPluginModule {
  return mod;
}
