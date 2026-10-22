# Plugins and integrations: the layer that lets outside code into Dispatch

## The problem this solves

Dispatch has six seams a third party would want to register into — agent
tools (MCP), authored guidance (modes, skills, instructions, personas), managed
processes (sub-apps), the typed event bus, identity, and the composer / settings
/ panel UI — and none of them accept a contribution from outside the repo.
Adding a capability today means a PR to this repo. That is the right bar for
the control plane and the wrong bar for everything around it: a voice front
end, a bot that reads chats from another assistant, a provider that runs the
agent somewhere else.

Three plugins motivate the design, and two of them are what this layer has to
make possible without any further change to the host:

1. **Voice.** Talk to a chat with a locally hosted Whisper, hear replies through
   a TTS engine, with a "voice mode" that keeps spoken replies short and a
   control in the composer toolbar to enter it.
2. **A Grok bot.** From inside Grok: search chats, queue messages, filter by
   message kind, receive chat-completion webhooks, and answer questions an agent
   raised.
3. **Remote execution.** Run the agent runtime on a per-chat container. This one
   needs a core seam first (see `docs/remote-execution.md` when it exists) and
   only its *provider* is a plugin; it is explicitly a later effort.

## Decisions already made

These were settled with the owner on 2026-10-21 and are not open for
re-litigation in the workstreams:

- **Plugins are global-only.** They live in `<configDir>/plugins/<id>/`. The
  config root is shared by the stable and dev instances and is never replaced by
  an upgrade, so a plugin installed once is seen by both and survives every
  publish. There is no project-scoped plugin. A plugin's contributed MCP servers
  are ordinary named servers, so the existing per-project `mcpEnabled` map is
  how a project opts out of one.
- **Server plugins run in-process** with the server's full privileges. This is a
  single-user control plane on the owner's own machine; an out-of-process
  protocol would roughly double the work for a trust boundary nobody here
  needs yet. The install step puts a consent card up listing the plugin's
  declared capabilities, which are a declaration for the human, not a sandbox.
- **OAuth is part of the layer and the host owns it.** Both primitives touch
  the auth gate and the secret store, which plugin code must never reimplement:
  Dispatch as an OAuth 2.1 authorization server for remote-MCP connectors, and a
  host-run OAuth *client* flow plugins declare in their manifest. OAuth as a way
  to log in to Dispatch is a later adapter.
- **Hot reload is out of scope.** Changing a plugin means restarting the server.
- **Workstreams land on green** under the project's normal review workflow.

## Anatomy of a plugin

```
<configDir>/plugins/<id>/
  plugin.yaml          the manifest (required)
  server/index.js      ESM module exporting activate/deactivate (optional)
  client/index.js      ESM module exporting activate(host) (optional). This
                       directory, and only this directory, is served publicly
  settings.schema.json JSON Schema for the plugin's settings (optional)
  modes/ skills/ instructions/ personas/   contributions (optional)
```

Every path in the manifest resolves inside the plugin directory; one that
escapes it (`../x`) fails validation. The `client` entry must sit in a
directory that holds nothing else of the plugin's, because the host serves
that whole directory without authentication (see "Client host"). A manifest
whose `client` and `server` entries share a directory, or whose `client` sits
at the plugin root, fails validation for that reason.

The manifest:

```yaml
id: voice                       # [a-z0-9][a-z0-9-]{0,39}; never starts with "dispatch-"
name: Voice
version: 0.1.0                  # the plugin's own version, semver
dispatch: ">=1"                 # host plugin-API major it was built against
description: Talk to a chat; hear replies.
server: ./server/index.js       # optional
client: ./client/index.js       # optional; its directory is served under /plugins/<id>/
settings: ./settings.schema.json
secrets: [WHISPER_URL]          # names the plugin may read; requested through the secret card
capabilities:                   # declared for the consent card; see "Capabilities"
  - events
  - routes
  - chats:write
  - process
contributes:
  modes: ./modes
  skills: ./skills
  instructions: ./instructions
  personas: ./personas
  mcpServers: ./mcp.yaml
  processes: ./processes.yaml
oauth:                          # see "OAuth"
  clients:
    xai:                        # [a-z0-9][a-z0-9-]{0,31}
      authorizationUrl: https://…
      tokenUrl: https://…
      scopes: [read]
      clientId: ${secret:XAI_CLIENT_ID}
      clientSecret: ${secret:XAI_CLIENT_SECRET}
```

`PluginManifestSchema` lives in `packages/shared/src/plugin-manifest.ts` so the
CLI, the server and the settings pane validate the same shape. The host exports
`PLUGIN_API_VERSION`; a manifest whose `dispatch` range excludes it is listed as
`incompatible` and never activated.

### Capabilities

| capability | grants |
|---|---|
| `events` | `ctx.bus` |
| `routes` | `ctx.routes` |
| `chats:read` | `ctx.chats.find/read/state/list` |
| `chats:write` | `ctx.chats.send/ask/reply`, `ctx.attention.answer` |
| `memory` | `ctx.memory` |
| `secrets` | `ctx.secrets` (only names listed under `secrets:`) |
| `kv` | `ctx.kv` |
| `mcp` | `contributes.mcpServers` |
| `process` | `contributes.processes`, `ctx.processes` |
| `oauth` | `oauth.clients`, `ctx.oauth` |
| `ui` | a `client` entry |

A capability the manifest does not declare is simply absent from the context
object the plugin receives. That is enforcement enough for code the owner
chose to install; the point of the list is the consent card and the Settings
row, not containment.

## Lifecycle

`PluginService` is a member of the service container.

1. **Discover.** Every `plugins/*/plugin.yaml` under the config root, sorted by
   id. A directory without a manifest is ignored; a manifest that fails
   validation is listed with `status: "invalid"` and its error.
2. **Resolve enablement.** `AppSettings.plugins[id].enabled`, default `true`
   for a valid manifest. The `plugins` key must be on the preserve list of the
   full-replace `PUT /api/settings`, carried raw through `normalize()` in the
   settings view, and have a `SECTION_SLICE` entry — the three edits every
   app-level setting needs, or a theme change deletes it.
3. **Activate**, after `app.listen()`, from `services.warm()` — the unbounded
   half of boot, where the PR catalog backfill and worktree detection already
   run — in id order, each `activate(ctx)` awaited with a 30 s budget. The port
   is open before the first plugin runs, so a hung `activate` delays the
   plugins after it and nothing else; `install.mjs`'s health check never waits
   on one. A throw or timeout marks the plugin `error` with the message, logs
   it to the crash log, and moves on. Until a plugin is active, its route
   prefix answers 503.
4. **Run.** Everything the plugin registered (bus listeners, route handlers,
   processes) is tracked against the plugin id so deactivate can undo it.
5. **Deactivate** on `services.dispose()` or when the enable toggle flips off:
   `deactivate()` if exported, then the host drops the plugin's listeners,
   empties its route table (the prefix answers 404 from then on), and stops
   its processes. Fastify cannot remove a route from a listening instance,
   which is why plugin routes are a table and not registrations — see
   "Server API". Flipping the toggle on requires a restart; the pane says so.

`GET /api/plugins` returns, per plugin: manifest summary, `status`
(`active | disabled | error | invalid | incompatible`), `error`, the client URL
when it has one, and the settings schema. `PUT /api/plugins/:id/enabled` and
`PUT /api/plugins/:id/settings` are targeted patches, not settings-draft writes.

### Install and the CLI

```
cm plugin add <path | git-url | tarball>   copy into config/plugins/<id>, validate, print the consent summary
cm plugin link <path>                      junction/symlink a working directory (development)
cm plugin list | enable <id> | disable <id> | remove <id>
cm plugin init <name>                      scaffold from the SDK template (workstream G)
```

Settings → Plugins is the same list with the enable toggle, status, error text,
a generic settings form rendered from the JSON schema, the OAuth Connect button
when the manifest declares a client, and "open folder".

## Server API

Pure types in `packages/shared/src/plugin-api.ts`, re-exported by
`@dispatch/plugin-sdk`. The server implements them in
`packages/server/src/plugins/`.

```ts
export interface PluginModule {
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

export interface PluginContext {
  readonly id: string;
  readonly dir: string;                 // absolute path of the plugin directory
  readonly version: string;             // the plugin's own
  readonly log: { info(m: string): void; warn(m: string): void; error(m: string, err?: unknown): void };

  bus: {
    on<T extends WsServerEventType>(type: T, fn: (evt: Extract<WsServerEvent, { type: T }>) => void): () => void;
    subscribe(fn: (evt: WsServerEvent) => void): () => void;
  };
  /**
   * Add handlers under /api/plugins/<id>/. The host registered ONE wildcard
   * route per plugin prefix at build time, before listen; this fills the
   * table that wildcard consults. Fastify can neither add nor remove routes
   * on a listening instance, so a table is what makes activate-after-listen
   * and deactivate possible at all. The global auth hook gates the prefix
   * because it is under /api/.
   */
  routes(define: (r: PluginRouter) => void): void;
  settings: { get<T = unknown>(): T; onChange(fn: (next: unknown) => void): () => void };
  secrets: { get(name: string): Promise<string | undefined>; list(): Promise<string[]> };
  kv: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
  };
  chats: {
    list(q?: { projectId?: string; status?: ChatStatus; since?: number; limit?: number }): Promise<ChatSummary[]>;
    find(q: ChatFindQuery): Promise<ChatFindHit[]>;
    read(chatId: string, view?: "digest" | "messages" | "grep", opts?: ChatReadOptions): Promise<string>;
    state(chatId: string): Promise<ChatState>;
    send(chatId: string, text: string, opts?: { delivery?: "queue" | "interrupt"; sender?: string }): Promise<void>;
    ask(chatId: string, question: string, opts?: { timeoutSeconds?: number }): Promise<string>;
    reply(askId: string, answer: string): Promise<void>;
  };
  attention: {
    list(): Promise<AttentionItem[]>;
    answer(itemId: string, answer: QuestionAnswer | { decline: true }): Promise<void>;
  };
  memory: {
    recall(projectId: string, query?: string): Promise<string>;
    remember(projectId: string, m: { name: string; description: string; type: MemoryType; body: string }): Promise<void>;
    forget(projectId: string, name: string): Promise<void>;
  };
  projects: { list(): Promise<ProjectSummary[]>; get(id: string): Promise<ProjectSummary | undefined> };
  /** Publish a `plugin-event` to connected clients; the plugin's client half receives it via host.events.onPlugin. */
  emit(payload: unknown, chatId?: string): void;

  /* Workstream D */
  processes?: { start(id: string): Promise<void>; stop(id: string): Promise<void>; list(): Promise<PluginProcessInfo[]> };
  /* Workstream F */
  oauth?: { connectUrl(name: string): Promise<string>; token(name: string): Promise<string | undefined>; disconnect(name: string): Promise<void> };
}

/** Paths are relative to /api/plugins/<id>/ and take `:param` segments. */
export interface PluginRouter {
  get(path: string, handler: PluginRouteHandler): void;
  post(path: string, handler: PluginRouteHandler): void;
  put(path: string, handler: PluginRouteHandler): void;
  delete(path: string, handler: PluginRouteHandler): void;
}
export type PluginRouteHandler = (req: FastifyRequest, reply: FastifyReply) => unknown;
```

Rules the implementation must keep:

- **Routes are a table, not registrations.** `buildApp` registers one
  wildcard per plugin prefix (`/api/plugins/:id/*`) before listen; the handler
  looks the plugin up and matches the request against that plugin's table
  (`find-my-way`, Fastify's own router, is already a dependency). An
  activating plugin's prefix answers 503, a disabled or unknown one's 404.

- **Sends go through `ChatMessenger`**, never `broker.sendMessage` directly. The
  broker declines every pending question card on send; the messenger holds a
  queued message while the target is awaiting input. A plugin message is not a
  human's dismissal.
- **Plugin-sent rows carry `origin: "channel"`** and `channel: { name }` where
  `name` is the plugin id (or the sender it passed). See "Attribution".
- **Every listener and route is owned.** `bus.on` returns an unsubscribe and
  the host also records it; deactivate removes everything the plugin left.
- **Secrets never reach the client half.** `ctx.secrets` exists on the server
  context only; the client host has no equivalent and must not grow one.
- **`kv` is a table** (`plugin_kv(plugin, key, value, updated_at)`) in the
  per-instance state database, not a JSON file. Same reason runner state moved.

### The `plugin-event` wire event

One new member of `WsServerEventSchema`:

```ts
{ type: "plugin-event", plugin: string, chatId?: string, payload: unknown }
```

Added in workstream A (the server publishes it) and consumed in workstream E.
One generic event instead of a schema per plugin keeps the wire closed and
typed; what a plugin puts in `payload` is its own contract with its client
half.

## Contributions (workstream D)

**Authored guidance** gains a fourth scope, `plugin`, between `shipped` and
`global`: `shipped → plugin → global → project` in both materialization order
(skills) and injection order (instructions). It is read-only; `config_write`
and `config_delete` refuse it the way they refuse `shipped`. `config_list`
reports it with the plugin id. Plugin modes are a fourth mode home — listed,
never written, like the built-ins.

**MCP servers** declared under `contributes.mcpServers` use the manifest
transport schema project servers use. Rules: the default `cwd` is the plugin
directory (a project server's default is the chat's tree, which is wrong for
code that ships with the plugin); names refuse the `dispatch-` prefix through
the same chokepoint project names do; the catalog lists them with kind
`plugin`; they merge *under* project servers so a project can shadow one by
name, and *under* Dispatch's own category servers, which still win every
collision; enablement runs through the existing four-layer `mcpEnabled`
resolver with the plugin's own `enabled` as the default layer.

**Processes** declared under `contributes.processes` (`id`, `command`, `args`,
`env`, `ports`, `url`, `autostart`) run through `RunnerService` with owner
`plugin:<id>` instead of a project and worktree. They get the port allocator,
persisted logs, the Ports & processes panel and the orphan reaper. `autostart`
starts them on activate; `ctx.processes` starts and stops them on demand. The
manager-env quarantine applies as it does to sub-apps. Both instances load the
same plugin, so a process that cannot run twice declares `singleton: true` and
the second instance adopts the running one by its port lease instead of
spawning.

## Client host (workstream E)

The server serves the directory holding each enabled plugin's `client` entry,
and nothing else of the plugin, at `/plugins/<id>/`, after checking that the
resolved path stays inside the plugin directory and is not the plugin root.
That path is **not** auth-gated, deliberately: the SPA bundle is public too, a
plugin's client code is code and not data, and a bare `import()` cannot carry a
bearer header any more than an `<img>` can. That is exactly why the manifest
refuses a layout that puts the server module beside the client entry: a public
directory must hold only what is meant to be public, and the layout is
validated rather than left to a warning in the docs.

After boot the SPA fetches `GET /api/plugins`, dynamically imports every active
plugin with a `client` entry, and calls `activate(host)`. A failing import or
activate shows a toast naming the plugin and is skipped.

**React is a singleton.** Plugins must not bundle their own. The host exposes
`window.__dispatch.deps = { react, reactDom, jsxRuntime, zustand, lucide }`
and the SDK's Vite preset marks those packages external, resolving them to the
globals. Versions are pinned by the host and declared as peer dependencies by
the SDK.

```ts
export interface ClientHost {
  readonly pluginId: string;
  readonly React: typeof React;
  ui: { Button; IconButton; Select; MenuItem; Dialog; Tooltip; Toggle; Field };  // the kit subset, no raw <button>
  slots: {
    composerControl(def: { id: string; label: string; hint: string; icon: ReactNode; priority?: number;
                           render(size: "sm"): ReactNode; menu?: ReactNode }): () => void;
    settingsSection(def: { id: string; label: string; blurb: string; icon: LucideIcon; render(): ReactNode }): () => void;
    panelTab(def: { id: string; label: string; group: "run" | "ship"; render(chat: ChatRef): ReactNode }): () => void;
    chatBadge(def: { render(chat: ChatRef): ReactNode }): () => void;
  };
  toast(msg: string, opts?: { kind?: "info" | "warn" | "error" }): void;
  engines: {
    dictation: { register(def: { id: string; label: string; create(handlers: DictationHandlers): DictationEngine }): () => void };
    tts: { register(def: { id: string; label: string; create(): TtsEngine }): () => void };
  };
  events: {
    on<T extends WsServerEventType>(type: T, fn: (evt: Extract<WsServerEvent, { type: T }>) => void): () => void;
    onPlugin(fn: (payload: unknown, chatId?: string) => void): () => void;   // this plugin's plugin-events only
  };
  chat: {
    current(): ChatRef | undefined;         // { id, projectId, modeId, status, ext }
    setExt(chatId: string, patch: Record<string, unknown> | null): Promise<void>;
    setMode(chatId: string, modeId: string | null): Promise<void>;
    send(chatId: string, text: string): Promise<void>;
  };
  api: { fetch(path: string, init?: RequestInit): Promise<Response> };  // sessionFetch under /api/plugins/<id>/
}
```

Rules:

- **A composer control enters the size ladder.** It is appended to
  `COMPOSER_CONTROLS` at runtime with a `sm` rung and the given priority, it
  gets a root row and a drill-in view in the options menu, and it never adds a
  row to the composer box. The persona row incident is the reason this is a
  rule and not a suggestion.
- **Engines are per browser, not per chat.** Which dictation or TTS engine is
  active is a local preference beside the composer-control visibility prefs;
  the built-in Web Speech engine is always registered and is the default.
- **TTS streams.** `TtsEngine` has `feed(delta)`, `flush()`, `cancel()`. The
  host feeds `message-chunk` deltas for the current chat and flushes on the
  assistant row; the engine speaks at sentence boundaries. Voice mode's
  convention is that the spoken part precedes a horizontal rule and the engine
  stops there.
- **`chat.ext`** is `Chat.ext?: Record<string, unknown>` keyed by plugin id.
  `PUT /api/chats/:id` merges per key; `null` clears a key; the row rides
  `chat-update`. The host never interprets it.
- **Raw buttons stay out.** `ui/rawButtons.test.ts` is a ratchet; plugin
  authors get the kit, and the examples use it.

## Integrations

Everything under this heading is host work. No plugin is needed for a bot to
reach Dispatch, and the Grok plugin is mostly configuration of these pieces.

### Tokens, external MCP, REST (workstream B)

**Integration tokens** are long-lived bearer tokens for a non-browser,
non-chat caller.

- Format `dsp_` + 32 random bytes base64url. Stored hashed (SHA-256) with
  `name`, `scopes`, optional `projectIds`, `createdAt`, `lastUsedAt`,
  `expiresAt`, `revokedAt`, and `clientId` when an OAuth grant minted it.
- Owned by `AuthService` and persisted beside its sessions, so **turning auth
  off revokes every token** under the rule sessions already follow. Minting
  refuses while auth is disabled: an unauthenticated install has nothing to
  scope.
- The auth gate recognises the prefix before the JWT path and sets
  `req.authIdentity = { kind: "integration", tokenId, name, scopes, projectIds }`;
  browser sessions get `kind: "user"`. A `requireScope(req, scope)` helper
  answers 403 with the missing scope named. WS tickets refuse integrations in
  v1; they get webhooks instead.
- Rate limit 60 requests per minute per token by default, 429 with
  `Retry-After`.
- Minted once and shown once, in Settings → Integrations → Tokens or
  `cm token create --name … --scopes … [--projects …] [--expires …]`.

**Scopes:** `chats:read`, `chats:write`, `attention:read`, `attention:answer`,
`memory:read`, `memory:write`, `projects:read`, `webhooks:manage`, and
`tools:<category>` for each manager category.

**External MCP.** The existing manager bridge gains a second mount,
`/api/mcp/integration/<category>`, serving the same category servers built with
an *external* `ManagerMcpContext` that has no self chat. The registry gains
`MANAGER_TOOL_EXTERNAL: Record<ManagerToolKey, boolean>`, cross-checked at
compile time like the categories. The rule for the flag: a tool that acts on
the calling chat's own session, shell or tree, or that puts a card in front of
the human on the calling chat's behalf, is **not** external. So `chat_find`,
`chat_read`, `chat_send`, `chat_ask`, `chat_reply`, `chat_state`,
`wait_for_chat`, `spawn_chat` (its consent card still applies), `project_info`,
`project_list`, the memory tools, the issue tools, `mode_list`, `config_list`
and `config_read` are external; `wait`, `context_usage`, `compact_context`,
the workspace tools, the PR tools, the confirm tools, `secret_request`, the
`mcp_*` editors and every `*_write`/`*_delete` are not. A category is offered
only when the token holds `tools:<category>`.

**REST**, under `/api/integration/`, a curated surface rather than scope checks
sprinkled over the SPA's routes:

| route | scope |
|---|---|
| `GET chats?projectId&status&since&q&limit` | `chats:read` |
| `GET chats/:id` (digest) · `GET chats/:id/messages?kinds&before&after&limit` | `chats:read` |
| `POST chats/:id/messages { text, delivery?, sender? }` | `chats:write` |
| `GET attention` · `POST attention/:id/answer { answer \| answers \| decline }` | `attention:read` / `attention:answer` |
| `GET projects` | `projects:read` |
| `GET openapi.json` | any |

### Attribution

`MessageOriginSchema` already declares `channel` and nothing writes it. A row
sent through the integration surface or `ctx.chats.send` carries
`origin: "channel"` and `channel: { name }`. `UserRow` renders it through the
existing `AuthoredCard` with the voice `<NAME> → <provider>`, never the speech
bubble, and the model receives a reminder in the style of the peer one: this
came from an external integration, the human in the app may not have seen it.
A test modelled on `peerAttribution.test.tsx` asserts the bubble's absence.

### Outbound webhooks (workstream C)

A **subscription** is a row in the state database: `id`, `name`, `url`,
`secret`, `filters`, `active`, `createdBy` (`user` or a token id), `createdAt`,
`lastDeliveryAt`, `consecutiveFailures`.

Filters: `events` (wire event types plus `chat-settled`), `rowKinds` (for
`chat-message`), `attentionKinds` (for `attention-add`), `projectIds`,
`chatIds`. Unset means all. `message-chunk` is never offered.

**`chat-settled`** is derived, not a wire event. A raw `idle` is published
before queued sends flush and before held peer messages are delivered, so it
would fire "done" on a chat already a sentence into its next turn. The service
reuses the settle rule in `services/chat-completion-notice.ts`: wait the
window, re-read the status, fire only if the chat stayed at rest, cancel on a
working status. Payload: `{ chatId, projectId, status, lastAssistantText }`.

Delivery: `POST` with body `{ id, type, at, projectId?, chatId?, data }` where
`data` is the wire event shape, and headers:

- `X-Dispatch-Event`: the event type.
- `X-Dispatch-Delivery`: the delivery id. It is the **same across every retry
  of one delivery**, so a receiver can use it as an idempotency key.
- `X-Dispatch-Signature`: `t=<unix seconds>,v1=<hex HMAC-SHA256 over
  "<t>.<raw body>">`. The timestamp is inside the signed string, so a captured
  delivery cannot be replayed later with its original signature; receivers
  should reject a `t` more than five minutes from their clock. This is the
  Stripe scheme, chosen because receivers already know how to verify it.

Retries at 5 s, 30 s, 2 m, 10 m, 30 m, each re-signed with a fresh `t`; after
five failures the delivery is dead; after twenty consecutive dead deliveries
the subscription is paused and a `notice` says so. A delivery log
(`webhook_delivery`) keeps seven days and is visible in Settings with status,
attempts and the last response code; a dead delivery can be redelivered.

Routes: `GET/POST/PUT/DELETE /api/webhooks`, `POST /api/webhooks/:id/test`,
`GET /api/webhooks/:id/deliveries`, `POST /api/webhooks/:id/deliveries/:d/redeliver`.

**A token-created subscription is bounded by its token.** A subscription made
by a browser session may target anything, including the owner's own LAN; that
is the point of a self-hosted ntfy. A subscription made through
`webhooks:manage` is not a way around the token's other limits:

- its `projectIds` filter is intersected with the token's `projectIds`, and an
  unset filter is set to the token's list, never to "all";
- its event types are limited to those the token's read scopes cover:
  `chat-message`, `chat-status`, `chat-update`, `chat-deleted` and
  `chat-settled` need `chats:read`; `attention-add`, `attention-resolve` and
  `permission-request` need `attention:read`; `pr-update`, `pr-record-update`
  and `project-update` need `projects:read`; `memory-update` and
  `memory-deleted` need `memory:read`;
- its `url` must be `https:` and resolve to a public address — loopback,
  link-local and RFC 1918 ranges are refused at creation and re-checked at
  each delivery, so an integration token cannot turn Dispatch into a request
  proxy to the LAN;
- it may read, edit, test and delete only subscriptions it created.

The existing `AppSettings.webhook` block (ntfy / pushover on attention-add) is
left alone in v1.

### OAuth (workstream F)

The auth gate authenticates `/api/*` from a bearer header and nothing else.
A browser navigation carries no bearer, so every OAuth step a browser performs
lives **outside** `/api/`, and the two `/api/oauth/` endpoints that remain are
exempt from the JWT gate because they *are* the credential exchange and carry
their own proof (PKCE verifier, client secret, refresh token). This is the one
called-out exception to the subresource rule at the end of this document.

**Authorization server.** Remote-MCP connectors expect to discover and
register themselves.

- `/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource`: public metadata.
- `POST /api/oauth/register`: dynamic client registration. Exempt from the
  gate, rate-limited, and only while the server advertises itself.
- `GET /oauth/authorize`: validates `client_id`, `redirect_uri`, scopes and
  the PKCE challenge (S256 is mandatory), parks the request under a
  single-use nonce, and redirects into the SPA at `#oauth=<nonce>`. The SPA
  already forces login before rendering anything, so "requires a logged-in
  Dispatch session" costs nothing extra: a logged-out user sees the login
  sheet first, then the consent page naming the client and the scopes. The
  decision goes back with the session's bearer, `POST
  /api/oauth/requests/:nonce/decision`, which mints the code and returns the
  client's redirect URL for the SPA to navigate to.
- `POST /api/oauth/token` (code and refresh grants) and `POST
  /api/oauth/revoke`: exempt from the gate, authenticated by what they carry.

An access token *is* an integration token with `clientId` set, one hour long;
refresh tokens rotate and last thirty days. The server only advertises itself
when auth is enabled and the canonical URL is HTTPS. Grants appear in
Settings → Integrations beside hand-minted tokens, with the same revoke.

**Client flow for plugins.** A manifest `oauth.clients.<name>` entry gives the
host everything it needs; `name` is `[a-z0-9][a-z0-9-]{0,31}`.

- `ctx.oauth.connectUrl(name)` and the Connect button mint a single-use
  `state` bound to the browser session that asked, valid ten minutes.
- The provider redirects to `GET /oauth/callback/<plugin>/<name>`, outside
  `/api/` because it is a top-level navigation with no bearer. The handler
  authenticates the request by the `state` alone, exchanges the code, and
  redirects to `#settings=plugins`.
- Tokens live in a per-instance table, `plugin_oauth_token`, keyed by
  `(pluginId, name)` with access token, refresh token, expiry and granted
  scopes. Not in the secret store: a flattened secret name built from two
  hyphenated identifiers is ambiguous (`a-b` + `c` reads the same as `a` +
  `b-c`), and a shared store would let the stable and dev instances race on
  refresh-token rotation and invalidate each other.
- `ctx.oauth.token(name)` returns a live access token, refreshing before
  expiry; `ctx.oauth.disconnect(name)` deletes the row. The settings pane shows
  Connect and the connection status.

The redirect URIs are derived from the canonical URL the passkey setup already
requires.

## Authoring (workstream G)

- `packages/plugin-sdk`: the shared types re-exported, `definePlugin()`
  helpers, the Vite preset, and `createTestContext()` so a server plugin's
  `activate` can be unit-tested with a fake context and no server.
- `cm plugin init <name>` scaffolds server-only, client-only or both from a
  template under `examples/plugins/`.
- `examples/plugins/hello-server`, `hello-slot`, `contributions` and
  `event-forwarder` build in CI and are the canonical references.
- A bundled skill, `packages/server/skills/plugin-authoring/`, teaches an agent
  the whole thing with references per topic. Bundled skills are materialized
  once per checkout and never refreshed; after shipping, delete the stale copy
  in any checkout that has run a session.

## Workstreams

| id | tracker | scope | depends on |
|---|---|---|---|
| A | #373 | host core: manifest, loader, lifecycle, `AppSettings.plugins`, Settings → Plugins, `cm plugin`, server facade, `plugin-event` | — |
| B | #374 | tokens + external MCP + REST: integration tokens, scopes, auth-gate identity, `MANAGER_TOOL_EXTERNAL`, `/api/integration/`, channel attribution | — |
| C | #375 | webhooks: subscriptions, signing, retries, delivery log, `chat-settled`, Settings → Integrations → Webhooks | — |
| D | #376 | contributions: `plugin` scope, MCP contribution, managed processes | A |
| E | #377 | client host: loader, globals shim, slots, engines, `chat.ext` | A |
| F | #378 | OAuth: authorization server, plugin client flow | A, B |
| G | #379 | authoring: SDK, template, examples, skill, docs | A, D, E |

Three workstreams run at a time; the next starts when one lands.

B and C both add to one new settings section, `integrations`. Whichever lands
first creates `settings/sections/IntegrationsSection.tsx` with its block; the
other adds a block to it.

## Rules every workstream inherits

- Comments say *why*, naming the failure the code prevents.
- A new app-level setting needs the schema, the preserve line in the
  full-replace route or the `normalize()` carry, and a `SECTION_SLICE` entry.
- Nothing under `/api/` is reachable as a bare subresource when auth is on; use
  the authenticated fetch helpers. The OAuth endpoints are the one called-out
  exception, and they are shaped to need it as little as possible: browser
  navigations live outside `/api/`, and only the credential exchange itself
  (`register`, `token`, `revoke`) is exempt from the gate.
- A per-chat composer control goes into the toolbar ladder, never a new row.
- Verify UI by looking at it: a screenshot in the PR, both themes for anything
  in the composer or settings.
- `pnpm test` does not run the client suites; run them when you touch the SPA.
- Materialized skills never refresh; delete the stale directory after changing
  a bundled skill.
- The `dispatch-` server-name prefix is reserved, in every new place a name
  can be declared.
