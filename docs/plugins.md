# Plugins and integrations: the layer that lets outside code into Dispatch

## The problem this solves

Dispatch has six seams a third party would want to register into — agent
tools (MCP), authored guidance (modes, skills, instructions, personas), managed
processes (sub-apps), the typed event bus, identity, and the composer / settings
/ panel UI — and until this layer none of them accepted a contribution from
outside the repo. Adding a capability meant a PR to this repo. That is the
right bar for the control plane and the wrong bar for everything around it: a
voice front end, a bot that reads chats from another assistant, a provider that
runs the agent somewhere else.

Three plugins motivated the design, and two of them are what this layer makes
possible without any further change to the host:

1. **Voice.** Talk to a chat with a locally hosted Whisper, hear replies through
   a TTS engine, with a "voice mode" that keeps spoken replies short and a
   control in the composer toolbar to enter it.
2. **A Grok bot.** From inside Grok: search chats, queue messages, filter by
   message kind, receive chat-completion webhooks, and answer questions an agent
   raised. Mostly host features (tokens, REST, the external MCP mount,
   webhooks, OAuth); a plugin only if the bot loop itself runs inside Dispatch.
3. **Remote execution.** Run the agent runtime on a per-chat container. This one
   needs a core seam first (see `docs/remote-execution.md` when it exists) and
   only its *provider* is a plugin; it is explicitly a later effort.

An agent building any of these should start from the bundled `plugin-authoring`
skill (`packages/server/skills/plugin-authoring/`), which is this document cut
into task-sized references; this document is the contract.

## Decisions already made

Settled with the owner on 2026-10-21; the implementation kept every one:

- **Plugins are global-only.** They live in `<configDir>/plugins/<id>/`. The
  config root is shared by the stable and dev instances and is never replaced by
  an upgrade, so a plugin installed once is seen by both and survives every
  publish. There is no project-scoped plugin. A plugin's contributed MCP servers
  are ordinary named servers, so the existing per-project `mcpEnabled` map is
  how a project opts out of one.
- **Server plugins run in-process** with the server's full privileges. This is a
  single-user control plane on the owner's own machine; an out-of-process
  protocol would roughly double the work for a trust boundary nobody here
  needs yet. `dispatch plugin add` prints a consent summary of the plugin's declared
  capabilities, which are a declaration for the human, not a sandbox.
- **OAuth is part of the layer and the host owns it.** Both primitives touch
  the auth gate and the secret store, which plugin code must never reimplement:
  Dispatch as an OAuth 2.1 authorization server for remote-MCP connectors, and a
  host-run OAuth *client* flow plugins declare in their manifest. OAuth as a way
  to log in to Dispatch is a later adapter.
- **Hot reload is out of scope.** Changing a plugin means restarting the server.
  The one live edge: switching a plugin off in Settings deactivates it now.
- **Workstreams landed on green** under the project's normal review workflow.

## Anatomy of a plugin

```
<configDir>/plugins/<id>/
  plugin.yaml          the manifest (required); the directory name must equal its id
  server/index.js      ESM module exporting activate/deactivate (optional); no runtime npm imports
  client/index.js      ESM module exporting activate(host) (optional). This
                       directory, and only this directory, is served publicly
  settings.schema.json JSON Schema for the plugin's settings (optional)
  modes/ skills/ instructions/ personas/ mcp.yaml processes.yaml   contributions (optional)
```

Every path in the manifest resolves inside the plugin directory; one that
escapes it (`../x`) fails validation. The `client` entry must sit in a
directory that holds nothing else of the plugin's, because the host serves
that whole directory without authentication (see "Client host"). A manifest
whose `client` and `server` entries share a directory, or whose `client` sits
at the plugin root, fails validation for that reason. The directory name must
equal the manifest `id`: settings key, route prefix, kv rows and the
`plugin-event` discriminator are all keyed by it.

The manifest:

```yaml
id: voice                       # [a-z0-9][a-z0-9-]{0,39}; never starts with "dispatch-"
name: Voice
version: 0.1.0                  # the plugin's own version, semver; not interpreted by the host
dispatch: ">=1"                 # REQUIRED: host plugin-API major it was built against
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
      clientId: ${secret:XAI_CLIENT_ID}       # only names listed under secrets: resolve
      clientSecret: ${secret:XAI_CLIENT_SECRET}
      extraParams: { access_type: offline }   # appended to the authorization URL verbatim
```

`PluginManifestSchema` lives in `packages/shared/src/plugin-manifest.ts` so the
CLI, the server and the settings pane validate the same shape. The host exports
`PLUGIN_API_VERSION` (currently `1`); `dispatch` is a small range grammar over
that one integer (`">=1"`, `"^1"`, `"1.x"`, `">=1 <3"`; clauses AND; no `||`),
and a manifest whose range excludes it — or cannot be parsed — is listed as
`incompatible` and never activated. The API is additive within a major.

### Capabilities

| capability | grants |
|---|---|
| `events` | `ctx.bus` |
| `routes` | `ctx.routes` |
| `chats:read` | `ctx.chats.list/find/read/state`, `ctx.attention.list` |
| `chats:write` | `ctx.chats.send/ask/reply`, `ctx.attention.answer` |
| `memory` | `ctx.memory` |
| `secrets` | `ctx.secrets` (only names listed under `secrets:`) |
| `kv` | `ctx.kv` |
| `mcp` | `contributes.mcpServers` |
| `process` | `contributes.processes`, `ctx.processes` |
| `oauth` | `oauth.clients`, `ctx.oauth` |
| `ui` | a `client` entry |
| `providers` | `ctx.providers.register` — see "Providers" |
| `terminals` | `ctx.terminals.registerBackend/publishPort/ports` — see "Terminal backends" |

A capability the manifest does not declare is simply absent from the context
object the plugin receives — the members are typed optional for that reason.
That is enforcement enough for code the owner chose to install; the point of
the list is the consent summary and the Settings row, not containment. A
contribution that needs a capability the manifest lacks (`mcpServers` without
`mcp`) is dropped with a warning on the row.

## Lifecycle

`PluginService` (`packages/server/src/plugins/service.ts`) is a member of the
service container.

1. **Discover.** Every `plugins/*/plugin.yaml` under the config root, sorted by
   id, in `services.start()` — bounded work, nothing a plugin wrote runs. A
   directory without a manifest is ignored; a manifest that fails validation is
   listed with `status: "invalid"` and its error. Contributions are snapshotted
   here.
2. **Resolve enablement.** `AppSettings.plugins[id].enabled`, default `true`
   for a valid manifest. The `plugins` key is on the preserve list of the
   full-replace `PUT /api/settings`, carried raw through `normalize()` in the
   settings view, and has a `SECTION_SLICE` entry — the three edits every
   app-level setting needs, or a theme change deletes it.
3. **Activate**, after `app.listen()`, from `services.warm()` — in id order,
   each `activate(ctx)` awaited with a 30 s budget, and nothing awaits the
   whole. The port is open before the first plugin runs, so a hung `activate`
   delays the plugins after it and nothing else; `install.mjs`'s health check
   never waits on one. A throw or timeout marks the plugin `error` with the
   message, files it through the crash log, and moves on. Until a plugin is
   active, its route prefix answers 503. `autostart` processes start before the
   module's `activate`, so it can talk to them.
4. **Run.** Everything the plugin registered (bus listeners, route handlers,
   settings listeners, processes) is tracked against the plugin id so
   deactivate can undo it.
5. **Deactivate** on `services.dispose()` (reverse id order; an activation
   still in flight is not waited for — it tears itself down when it returns) or
   when the enable toggle flips off: `deactivate()` if exported (10 s budget),
   then the host drops the plugin's listeners, empties its route table (the
   prefix answers 404 from then on), stops its processes and stops serving its
   client directory. Fastify cannot remove a route from a listening instance,
   which is why plugin routes are a table and not registrations — see "Server
   API". Flipping the toggle on requires a restart; the pane says so.

`GET /api/plugins` returns, per plugin (`PluginInfo`): manifest summary, `dir`,
`status` (`active | disabled | error | invalid | incompatible`), `error`,
`enabled`, `needsRestart`, `capabilities`, `hasServer`, `clientUrl` (the entry
**module's** URL, `/plugins/<id>/<file>`, which the SPA imports as-is),
`settingsSchema`, `settings`, the declared `secrets` names, `oauth[]` (per
client: `connected`, `expiresAt`, `scopes`, `configError`), `warnings[]`
(non-fatal contribution problems, on the row rather than only in a server log),
`origin` (`url | local | linked | builtin | unknown`) and the recorded `source` —
see "Updating and uninstalling".
`PUT /api/plugins/:id/enabled` and `PUT /api/plugins/:id/settings` are targeted
patches, not settings-draft writes; `POST /api/plugins/:id/reveal` opens the
directory on the machine Dispatch runs on (from a remote browser the pane also
shows and copies the path).

### Install and the CLI

```
dispatch plugin init <id> [--server|--client|--both] [--name <n>] [--dir <parent>] [--sdk <path>]
dispatch plugin add <path | git-url | tarball>   validate in the source, copy into plugins/<id>, print the consent summary
dispatch plugin link <path>                      junction/symlink a working directory (development)
dispatch plugin list | enable <id> | disable <id>
dispatch plugin update [<id>] [--check] [--yes]  follow the recorded source; --yes accepts an update that asks for more
dispatch plugin remove <id> [--purge] [--data-dir <dir>]
```

`add` claims the slot by the manifest's id (not the source directory's name),
finds the manifest at the root or one directory down (a tarball or clone
wrapper), and leaves `.git` and `node_modules` behind — a built plugin needs
neither, and a scaffold's `node_modules` holds a link to the SDK that
`dereference` would copy through. Discovery and validation live in
`packages/cli/src/core/plugins.ts`; the server imports them, so the loader and
the CLI cannot disagree about what a plugin directory is.

### Inspecting a plugin before installing it

Settings → Plugins opens with **Inspect from URL**. The owner pastes a GitHub URL
(`github.com/<o>/<r>`, `…/tree/<ref>/<dir>`, `…/blob/<ref>/…/plugin.yaml`, a `.git`
or `git@github.com:` URL) or any https git clone URL (`#<ref>` optional), and
`POST /api/plugins/inspect` returns a `PluginInspection`
(`packages/shared/src/plugin-inspection.ts`). Nothing the plugin ships is imported,
required, built or run; the report is deterministic — manifest, README, static
scan, no model.

- **Ref → sha** is one `git ls-remote --symref` (any host, no API rate limit), and
  the ref/subdir split of `/tree/feat/x/plugins/a` takes the LONGEST branch or tag
  that prefixes the path, as GitHub's router does. A full sha is taken as-is; an
  abbreviated one is refused (resolving it needs the host's API). Git runs with
  prompts and credential helpers off, so a private repo fails fast instead of
  opening a credential window on the host.
- **Fetch** is GitHub's codeload tarball of that exact sha (other hosts: `git fetch
  --depth 1 <url> <sha>` + `git archive`), streamed through an in-process tar reader
  that writes only regular files and directories, refuses links, `..`, absolute
  and Windows-reserved names, skips `.git`/`node_modules`, keeps only the requested
  subdirectory, and caps files (2000), bytes (25 MB), per-file bytes (8 MB), the
  download (100 MB), the unpacked stream (400 MB) and time (60 s). GitHub's pax
  header carries the commit sha; a mismatch is refused. Every later read is
  lexically and `realpath`-confined to the scratch directory.
- **Report**: identity and README excerpt; the verdict of the host's own
  `PluginManifestSchema` / `pluginRangeAccepts`; declared capabilities with one
  plain-language line each (`PLUGIN_CAPABILITY_LINES`); contributions, read with
  the host's own readers but with `${…}` left unexpanded; secrets, OAuth providers
  and scopes, the settings schema; whether each entry file is actually in the
  tree (built output is usually gitignored — the report says the plugin will not
  load until it is built); and what is already installed under that id.
- **Hooks used** is a token scan of the entries' directories, `src/`, `dist/`,
  `lib/`, `build/` and any code file a contributed MCP server or process runs
  (tests and configs excluded): `ctx.*` / `host.*` and whatever `activate`'s first
  parameter is called, destructuring of those, routes, slots and their ids, events
  by name when literal, and `fetch`, `node:http(s)`/`net`/`child_process`/`fs`,
  `eval`, computed `import()`, `process.env`. It cannot see an alias it does not
  follow or a name built at runtime, and the card says so.
- **Mismatches**: a capability the scan (or a contribution) needs that the manifest
  does not declare — absent from `ctx` at runtime, or the contribution ignored —
  and a declared capability nothing uses. A literal `ctx.secrets.get("X")` for an
  unlisted `X`, and a bare npm import in a built entry, are warnings.

`POST /api/plugins/install { url, sha, replace? }` re-fetches **that sha** (never the
ref's current tip), re-runs the same report, refuses unless it is installable, and
hands the extracted directory to the CLI's `addPlugin` — the same validate / claim /
copy-without-`.git`-and-`node_modules` / rename path `dispatch plugin add` takes. Replacing
an installed copy needs `replace: true` (the card's "Update to x.y.z"). The plugin is
not loaded: `PluginService.noteInstalled` lists a new id as inert, or flags an
existing (enabled) one, with `needsRestart`. An active plugin whose files were
replaced keeps its loaded server code but stops serving its client bundle until
the restart, so a new client never talks to the old server half. Both routes are owner-only (403 for a non-owner
session or an integration token; auth off means the single local user).

Settings → Plugins is the same list with the enable toggle, status, error text,
capability and secret chips, warnings, a generic settings form rendered from the
JSON schema (string / number / integer / boolean / enum), Connect / Disconnect
per declared OAuth client, the source line, copy path, "open folder", Check for
updates and Uninstall.

### Updating and uninstalling

**The recorded source.** Every URL install — the pane's Install, and `dispatch
plugin add <git-url>` — records `AppSettings.plugins[id].source` =
`{ type: "git", url, cloneUrl, ref, refKind: branch | tag | sha, subdir, sha,
installedAt }` in `config.json`; `add <path | tarball>` records `{ type: "local",
path }`. It lives in host-owned config and **never** in the plugin directory:
everything in there came from the plugin's author, and a source a plugin could
write is one it could re-point, so Update would install whatever the plugin said
to. It survives every other write to the entry (toggle, settings) and the
full-replace `PUT /api/settings`, which preserves the whole `plugins` map. A
plugin already on disk with no record — installed by hand or before #409 — is
`origin: "unknown"` ("Source unknown"). It is not backfilled; reinstalling from
its URL records one. `origin` is derived: `builtin` (shipped in the app
payload — `DiscoveredPlugin.builtin`) wins, then `linked` (a junction), then the
record's type.

**Check for updates** (`POST /api/plugins/:id/check-update`, per row and "Check all
for updates"; manual only, nothing polls) resolves the record against one `git
ls-remote` with the shared `resolveUpdateTarget`
(`packages/shared/src/plugin-lifecycle.ts`): a **branch** follows its tip (a deleted
branch is an error, not "up to date"); a **tag** looks for the newest semver-greater
tag with the same prefix (`v`, `hello-v`, `hello@`), skipping prereleases unless the
installed tag is one, and reports a force-moved tag as an update; a **sha** is
pinned. When there is a newer commit it is fetched and reported exactly like an
inspect, the installed directory is scanned in place, and `diffPluginSurfaces`
compares the two: **escalations first** — new capabilities, secrets, OAuth clients
or scopes, new or re-pointed MCP servers and processes, newly undeclared uses, a
server or browser half where there was none, a new instruction file — then the
other changes (what it dropped, contributions, then "hooks used" with `io` first).
A network failure is a row result (`status: "error"`), so Check all keeps going.

**Update** (`POST /api/plugins/:id/update { sha }`) re-resolves the ref and refuses
(409) if it no longer points at the sha the owner was shown — they consented to a
diff of one commit. It then runs Install's own path pinned to that sha, refusing an
invalid or incompatible target or one whose manifest id differs. Settings, the
toggle, kv rows, secrets and OAuth tokens are all keyed by the id **outside** the
directory, so replacing the directory keeps them with no copying. Same restart rule
as Install. `dispatch plugin update` makes the same decisions offline, fetches with
a shallow clone of the target ref, and compares manifests and contribution files
(it has no scanner); an update that escalates is not installed without `--yes`.

**Uninstall** (`GET /api/plugins/:id/uninstall` previews, `POST` with `{ purge }`
does it) deactivates a running plugin in place — the teardown a toggle-off runs, so
its routes 404, its processes stop and its contributions vanish with the record —
then deletes the directory, or for a **linked** plugin removes only the junction and
never touches the directory it points at. The recorded source always goes. The
"Also delete its data" box (default off; `--purge` in the CLI) also removes the
`plugins.<id>` entry, this instance's `plugin_kv` rows and `plugin_oauth_token` rows,
and the global secrets its manifest lists — except any another installed plugin also
lists, which are kept and named. kv rows and OAuth tokens are per instance (they
live in `state.db`); the CLI reaches them only with `--data-dir`. A browser bundle an
open tab already imported has no unload hook, so the result says those tabs keep it
until they reload.

**Built-in plugins** get none of this: no Update ("Built-in, updates with
Dispatch"), no Uninstall, and Install refuses their ids. The enable toggle stays.
All four routes are owner-only, like inspect and install.

## Server API

Pure types in `packages/shared/src/plugin-api.ts`, re-exported by
`@dispatch/plugin-sdk`. The server implements them in
`packages/server/src/plugins/context.ts`.

```ts
export interface PluginModule {
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

/**
 * Generic over the request/reply types because this file cannot import
 * Fastify. The server narrows them to Fastify's (`ServerPluginContext`); the
 * SDK narrows them to a structural subset (`PluginRequest` / `PluginReply`).
 * Capability-gated members are OPTIONAL: they are absent at runtime without
 * the capability.
 */
export interface PluginContext<Req = unknown, Reply = unknown> {
  readonly id: string;
  readonly dir: string;                 // absolute path of the plugin directory
  readonly version: string;             // the plugin's own
  readonly log: { info(m: string): void; warn(m: string): void; error(m: string, err?: unknown): void };

  bus?: {
    on<T extends WsServerEventType>(type: T, fn: (evt: Extract<WsServerEvent, { type: T }>) => void): () => void;
    subscribe(fn: (evt: WsServerEvent) => void): () => void;
  };
  /** Add handlers under /api/plugins/<id>/ — a TABLE the host's wildcard consults; see the rules below. */
  routes?(define: (r: PluginRouter<Req, Reply>) => void): void;
  settings: { get<T = Record<string, unknown>>(): T; onChange(fn: (next: unknown) => void): () => void };
  secrets?: { get(name: string): Promise<string | undefined>; list(): Promise<string[]> };
  kv?: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
  };
  chats?: {
    list?(q?: PluginChatListQuery): Promise<PluginChatSummary[]>;
    find?(q: PluginChatFindQuery): Promise<PluginChatSummary[]>;      // summaries carrying `hits`
    read?(chatId: string, view?: "digest" | "messages" | "grep", opts?: PluginChatReadOptions): Promise<string>;
    state?(chatId: string): Promise<PluginChatState | null>;
    send?(chatId: string, text: string, opts?: { delivery?: "queue" | "interrupt"; sender?: string }): Promise<PluginSendResult>;
    ask?(chatId: string, question: string, opts?: { timeoutSeconds?: number; sender?: string }): Promise<PluginAskResult>;
    reply?(askId: string, answer: string): Promise<{ ok: boolean; message?: string }>;
  };
  attention?: {
    list?(): Promise<AttentionItem[]>;
    answer?(itemId: string, answer: QuestionAnswerInput | { decline: true }): Promise<{ ok: boolean; message?: string }>;
  };
  memory?: {
    recall(projectId: string, query?: string): Promise<string>;
    remember(projectId: string, m: { name: string; description: string; type: MemoryType; body: string }): Promise<void>;
    forget(projectId: string, name: string): Promise<void>;
  };
  projects: { list(): Promise<PluginProjectSummary[]>; get(id: string): Promise<PluginProjectSummary | undefined> };
  /** Publish a `plugin-event` to connected clients; the plugin's client half receives it via host.events.onPlugin. */
  emit(payload: unknown, chatId?: string): void;

  processes?: { start(id: string): Promise<void>; stop(id: string): Promise<void>; list(): Promise<Array<{ id; status; ports?; url? }>> };
  oauth?: { connectUrl(name: string): Promise<string>; token(name: string): Promise<string | undefined>; disconnect(name: string): Promise<void> };
}

/** Paths are relative to /api/plugins/<id>/ and take `:param` segments (find-my-way syntax). */
export interface PluginRouter<Req, Reply> {
  get(path: string, handler: (req: Req, reply: Reply) => unknown): void;
  post(path: string, handler: (req: Req, reply: Reply) => unknown): void;
  put(path: string, handler: (req: Req, reply: Reply) => unknown): void;
  delete(path: string, handler: (req: Req, reply: Reply) => unknown): void;
}
```

`send` / `ask` return result objects rather than `void` / `string`:
`{ ok, refusal?, held?, woke? }` and `{ ok, askId?, answered, answer?, reason? }`,
so a refused, parked or timed-out send is visible to the plugin. `ask` waits
600 s by default.

Rules the implementation keeps:

- **Routes are a table, not registrations.** `buildApp` registers one
  wildcard (`/api/plugins/:id/*`) before listen; the handler looks the plugin
  up and matches the request against that plugin's own `find-my-way` table
  (`find-my-way` is a direct server dependency for this). An activating plugin's
  prefix answers 503, a disabled or unknown one's 404. The prefix is gated by
  the session auth hook like all of `/api/`; an integration token does not
  reach it (see "Tokens").
- **Sends go through `ChatMessenger`**, never `broker.sendMessage` directly. The
  broker declines every pending question card on send; the messenger holds a
  queued message while the target is awaiting input. A plugin message is not a
  human's dismissal. `reply` answers AS the asked chat, which the host looks up
  from the `askId`.
- **Plugin-sent rows carry `origin: "channel"`** and `channel: { name, askId? }`
  where `name` is the plugin id (or the sender it passed). See "Attribution".
- **Every listener and route is owned.** `bus.on` returns an unsubscribe and
  the host also records it; deactivate removes everything the plugin left.
- **Secrets never reach the client half.** `ctx.secrets` exists on the server
  context only; the client host has no equivalent and must not grow one.
- **`kv` is a table** (`plugin_kv(plugin, key, value, updated_at)`) in the
  per-instance state database, not a JSON file. Same reason runner state moved.
  Values are JSON; `set(key, undefined)` deletes.
- **No runtime npm imports in `server/index.js`.** It is imported from the
  plugin directory, where there is no `node_modules`. Write TypeScript and
  bundle it with the SDK's `dispatchServerBuild`, or write dependency-free
  JavaScript (`examples/plugins/hello-server`).

### The `plugin-event` wire event

One member of `WsServerEventSchema`:

```ts
{ type: "plugin-event", plugin: string, chatId?: string, payload: unknown }
```

The server publishes it from `ctx.emit`; the client host delivers it to the
owning plugin's `host.events.onPlugin`. One generic event instead of a schema
per plugin keeps the wire closed and typed; what a plugin puts in `payload` is
its own contract with its client half.

## Contributions

**Authored guidance** has a fourth scope, `plugin`, between `shipped` and
`global`: `shipped → plugin → global → project` in both materialization order
(skills, never-clobber) and injection order (instructions). It is read-only;
`config_write`, `config_delete` and `mode_write` refuse it the way they refuse
`shipped`. `config_list` reports it with the plugin id; the `/` menu labels
plugin skills `plugin`. Plugin modes are a fourth mode home — listed by
`GET /api/modes` and `mode_list` with scope `plugin`, resolvable, never written,
shadowed by a project or store mode of the same id.

**MCP servers** declared under `contributes.mcpServers` (`mcp.yaml`: a bare
list or `{ mcpServers: [...] }`) use the manifest transport schema project
servers use. Rules: the default `cwd` is the plugin directory (a project
server's default is the chat's tree, which is wrong for code that ships with
the plugin); `${secret:NAME}` expands from the global secret store only for
names the manifest lists under `secrets:` (an unlisted name is blanked and
warned); names refuse the `dispatch-` prefix through the same chokepoint
project names do; the catalog lists them under **Plugins** with kind `plugin`,
probed in the plugin dir; they merge `bundled < plugin < project .data < project
config`, with Dispatch's own category servers on top, so a project can shadow
one by name; enablement runs through the existing layered `mcpEnabled`
resolver with the plugin's toggle as the default layer — which is why a
**disabled plugin's server stays in the catalog**, switched off with the
reason, so a per-project pin still has something to point at.

**Processes** declared under `contributes.processes` (`processes.yaml`: `id`,
`name`, `command`, `args`, `env`, `cwd`, `ports`, `url`, `autostart`,
`singleton`) run through `RunnerService` with owner `plugin:<id>` instead of a
project and worktree. `command` + `args` are joined into one shell line (the
runner spawns through a shell, which is what makes `.cmd` shims work on
Windows); `{port}` / `{portN}` are substituted from the leased ports and the
first is injected as `PORT`. They get the port allocator, persisted logs, the
Ports & processes panel (grouped "Plugin · <id>", shown even for a project with
no sub-apps), the manager-env quarantine and the orphan reaper. `autostart`
starts them on activate, before the module runs; `ctx.processes` starts and
stops them on demand; deactivate, toggle-off and dispose stop them. Both
instances load the same plugin, so a process that cannot run twice declares
`singleton: true` and the second instance **adopts** a listener on the first
declared port instead of spawning (an adopted record has no pid and its `stop`
kills nothing). Adoption is by declared port, not by port lease: leases, runner
rows and kv are per instance, and the port is the only identity both can see —
hence the schema requires `ports` on a singleton.

Reference: `examples/plugins/contributions` (no code; one of each).

## Providers

An agent runtime — what a chat actually runs on — is a plugin contribution.
Claude is the only one compiled into the host: it is the fallback every
unavailable provider resolves to, and it drives the background jobs (titles,
commit messages). **Codex and goose are built-in plugins** in
`packages/plugins/codex` and `packages/plugins/goose`.

A provider plugin declares the `providers` capability and calls, from
`activate`:

```ts
ctx.providers.register(harness, descriptor);
```

- `harness` implements `Harness` (`@dispatch/shared` → `harness.ts`): the
  session factory, the model list, limits, and optionally `probeLogin(exe, env)`
  for the setup card. A harness without `probeLogin` is shown as "login not
  checked" — the host no longer guesses by provider id.
- `descriptor` is the `ProviderDescriptor` every surface labels, picks and
  accounts it by (label, seed models, efforts, skills dir, how an account is
  selected). Its `id` must equal `harness.kind` and match
  `^[a-z][a-z0-9-]{0,39}$`; it is what chats, projects and subscriptions store.
- Registering an id that is already taken throws, so nothing can shadow
  `claude` or another plugin's provider. Deactivation (the toggle) unregisters
  it and calls `harness.dispose()`; a chat pinned to it then falls back to
  Claude and is told so. `dispose()` may end sessions in flight — switching
  Codex off tears down its shared app-server, so a Codex turn running at that
  moment errors rather than finishing.

**Context limits.** Settings → Context sets a compact threshold per model,
else a per-chat limit, and it arrives as `HarnessSessionSpec.contextTokenLimit`
(absent = the model's own maximum). The contract:

- **Enforce it mid-turn**, by handing it to the runtime's own trigger
  (Codex `model_auto_compact_token_limit`; Claude an `autoCompactWindow` derived
  from it), and declare `capabilities.nativeContextLimit: true`. The host also
  compacts at turn end once past it, but a long agentic turn never ends, so
  that alone is not enough. A runtime with no trigger of its own leaves the flag
  off and gets only the turn-end check.
- **Report each compaction once**, when it has finished, as a `compacted` event.
  `preTokens`/`postTokens` are optional: the host fills `preTokens` from its last
  reading and leaves `postTokens` to the next `usage` event.
- **A limit change** (model switch, Settings edit) on a `nativeContextLimit`
  runtime goes to `HarnessSession.setContextTokenLimit` if you implement it. If
  you don't, or it rejects, the host retires the idle session and resumes it
  with the new spec before the next message. Neither shipped runtime can apply
  it live. Without the flag nothing restarts; the turn-end check reads the new
  value anyway.
- The composer meter's denominator is the limit, not the window you report.
  `spec.contextWindow` stays the model's real window.

**Built-in plugins** load from `packages/plugins/` in the app payload, found
by `findShippedPluginsRoot()` (`server/src/plugins/shipped.ts`), never from
`<configDir>/plugins/`. Three things differ from an installed plugin:

- They activate in `start()`, **before the port opens** (`activateShipped`).
  Left to `warm()`, a chat resumed in the gap would find its provider unknown
  and fall back to Claude. One that declares managed processes still waits for
  `warm()`, behind the runner reconcile.
- They own their ids. An installed plugin with a built-in's id is ignored (and
  logged), and Settings → Plugins → Inspect refuses to install one.
- They are workspace packages, so they resolve the host's own
  `@dispatch/shared` and may import its values freely — unlike an installed
  plugin, whose server module must be self-contained. Under `pnpm dev`, a
  built-in whose `server/` output is missing loads its `src/` through tsx, so
  it hot-reloads with the server instead of running a stale build.

The Settings row shows a `built-in` chip; the toggle works as for any plugin.

## Terminal backends

A chat's managed terminals — `mcp__dispatch-workspace__terminal` and the
Terminals panel — are local `powershell`/`bash` children of the server. A
plugin declaring `terminals` can supply somewhere else for them to run (a
container, a VM, another machine) without core knowing what that is. The first
one is `mdennis281/dispatch-proxmox-terminal`, a per-chat Proxmox LXC; it is
optional and lives in its own repo.

```ts
ctx.terminals.registerBackend({
  id: "proxmox",            // ^[a-z0-9][a-z0-9-]{0,47}$, never "local"
  label: "Proxmox container",
  shell: "bash",            // the dialect of the sentinel probe core appends
  spawnTimeoutMs: 180_000,  // default 120 s, capped at 10 min
  async spawn({ chatId, projectId, name, cwd, repoPath, signal }) {
    // provision, connect, then hand back stdio
    return handle;          // TerminalBackendHandle — see below
  },
  agentNote: ({ chatId }) => "How your local edits reach the container: …",
  onChatIdle: ({ chatId }) => { /* stop what you made, maybe */ },
  onChatDeleted: ({ chatId }) => { /* destroy what you made */ },
  dispose: () => { /* close connections */ },
});
```

**The handle** is the stdio shape TerminalService already drives: `stdin`
(`write`, optional `end`/`on("error")`), `stdout` and `stderr` emitting
`data`, `kill()`, and `on("exit" | "error")`. A Node `ChildProcess` satisfies
it; so does an ssh2 exec channel with a few lines of adapter. The sentinel
protocol, scrollback, background runs and transcripts are core's and work
unchanged over any transport that carries a line each way. It has **no
`pid`**: core reads a pid as a local process it may tree-kill and walk the
process table under, so it strips one if present. `kill()` must take down the
remote shell *and what it started* — it is the only teardown core can ask for.

**Selection** is `resolveTerminalBackend` (shared): the chat's
`terminalBackend` pin, else the project's `defaults.terminalBackend` in
`project.yaml`, else `local`. The picker is in the chat's Terminals panel and
the project's Settings → Chat defaults. Both appear while a backend is
registered, or while a pin still names one that is not, so a stale pin can be
seen and cleared. Selection is read when a shell OPENS; changing it moves the
next shell, not one already running. A shell that fell back stays local until
it is closed, even after its backend returns.

The registry keeps every chat's non-local pin in memory: seeded from the store
at boot, and kept current from `chat-update`. That lets TerminalService decide
synchronously whether a shell needs resolving at all. `size > 0` alone would not
do: a chat pinned to the only backend plugin, while that plugin is off or still
activating, sees an empty registry, and must still get the warning (or the
boot wait) rather than a plain local shell.

**Failure is loud and falls back.** A spawn that rejects, or does not settle
within `spawnTimeoutMs`, brings up a LOCAL shell instead. The reason lands in
three places: a `[dispatch]` line in the terminal, a `notice` in the chat, and
the next tool result. The row's location badge turns amber, with the reason in
its tooltip. A pin to a backend that is not registered (plugin uninstalled or
switched off) falls back the same way rather than quietly reading as local.
During boot, a chat pinned to an installed plugin's backend waits for that
plugin to activate before deciding it is missing.

**Telling the agent.** The agent's own Bash tool stays local while its terminal
does not, so core says so, only to chats on a backend and never as a global
instruction. A session prompt section, "Where your terminal runs", is written
when the chat resolves to a registered backend, and the first result from each
new shell repeats it. Core's text covers what every backend shares: builds,
tests and dev servers go through the terminal tool, git stays local, and
servers are reached through forwarded URLs. `agentNote` appends what only the
backend knows.

**Lifecycle.** `onChatIdle` fires when the idle sweep retires the chat's
session. Core does NOT kill the shells; stopping is the backend's call, and a
shell that dies comes back on the next command because TerminalService re-opens
an exited name. `onChatDeleted` fires after the chat's shells are killed. Both
fan out to every registered backend, which must keep its own record of what it
made. They are fire-and-forget, contained, and bounded at 60 s.

**Ports.** A remote listener is useless to a browser on the Dispatch host until
the backend forwards it. The backend owns the transport, so it does the
forwarding and then announces it:

```ts
const withdraw = ctx.terminals.publishPort("proxmox", {
  chatId, remotePort: 5173, url: "http://127.0.0.1:53211", label: "vite",
});
```

Published ports appear in the terminal tool's results ("Forwarded ports"), in
`terminal_output`, and in the Terminals panel. A plugin may publish only for
backends it registered. Publishing the same chat + remote port again replaces
the entry, and a stale `withdraw` does not remove its replacement.

**Deactivation** unregisters every backend the plugin registered. Its shells
end with a `[dispatch]` line saying why, its ports are withdrawn, and
`dispose()` is called. The next command on one of those names re-resolves.
The pin still names the gone backend, so it comes up local, with a warning.

**What does not change with no backend plugin in use** (none registered, and
no chat or project naming one): TerminalService takes its original synchronous
spawn path, `TerminalInfo` has no `location`, no `terminal-backends` event is
ever published, no prompt section is written, and the panel shows no picker or
badge.

`createTestContext` records `terminalBackends` and `terminalPorts`, and
`t.terminals.spawn(id, { chatId })` / `chatIdle` / `chatDeleted` play the
host's side, so a backend can be unit-tested with no server.

## Client host

The server serves the directory holding each enabled plugin's `client` entry,
and nothing else of the plugin, at `/plugins/<id>/` — one wildcard registered
at build time (`routes/plugin-client.ts`), the root decided per request by
`PluginService.clientRoot` (enabled, valid, compatible, strictly inside the
plugin dir, never the dir itself), the path confined lexically AND by realpath
(a stray symlink in a linked working tree is not a reason to serve the home
directory), `no-cache`, `nosniff`. That path is **not** auth-gated, by
construction — the gate covers `/api/` and `/ws` — and deliberately: the SPA
bundle is public too, a plugin's client code is code and not data, and a bare
`import()` cannot carry a bearer header any more than an `<img>` can. That is
exactly why the manifest refuses a layout that puts the server module beside
the client entry.

After boot (and again after sign-in) the SPA fetches `GET /api/plugins`,
dynamically imports every **active** plugin's `clientUrl` (a plugin whose
server half is in `error` does not get its client loaded — its routes would
404), and calls `activate(host)`. A failing import or activate shows a toast
naming the plugin and is skipped. The deps shim is imported lazily, only when
some plugin has a client entry: the full `lucide-react` namespace would
otherwise cost every install a megabyte for a feature most have no plugin for.

**React is a singleton.** Plugins must not bundle their own. The host exposes
`window.__dispatch.deps = { react, reactDom, jsxRuntime, zustand, lucide }`
(`DispatchClientGlobals`) and the SDK's Vite preset resolves those five
packages to virtual modules over the globals, with `/*#__PURE__*/` re-exports
so lucide tree-shakes (5 kB bundles, not 400 kB). Versions are pinned by the
host and declared as peer dependencies by the SDK.

```ts
export interface ClientHost {
  readonly pluginId: string;
  readonly React: typeof React;
  ui: ClientHostKit;   // Button, IconButton, Select, MenuItem, Dialog, Tooltip, Toggle, Field — call signatures, no raw <button>
  slots: {
    composerControl(def: { id; label; hint; icon: ReactNode; priority?; render(size: "sm"): ReactNode; menu?: ReactNode; onSelect?(): void }): () => void;
    settingsSection(def: { id; label; blurb; icon: ComponentType; render(): ReactNode }): () => void;
    panelTab(def: { id; label; group: "run" | "ship"; icon?; render(chat: PluginChatRef): ReactNode }): () => void;
    chatBadge(def: { render(chat: PluginChatRef): ReactNode }): () => void;
  };
  toast(msg: string, opts?: { kind?: "info" | "warn" | "error"; detail?: string }): void;
  engines: {
    dictation: { register(def: { id; label; unavailable?(): string | null; create(handlers): DictationEngine | null }): () => void };
    tts: { register(def: { id; label; unavailable?(): string | null; create(): TtsEngine | null }): () => void };
  };
  events: {
    on<T extends WsServerEventType>(type: T, fn: (evt: Extract<WsServerEvent, { type: T }>) => void): () => void;
    onPlugin(fn: (payload: unknown, chatId?: string) => void): () => void;   // this plugin's plugin-events only
  };
  chat: {
    current(): PluginChatRef | undefined;    // { id, projectId, modeId?, status?, ext? } — ext is the whole bag
    setExt(chatId: string, patch: Record<string, unknown> | null): Promise<void>;   // writes ext[pluginId] only
    setMode(chatId: string, modeId: string | null): Promise<void>;
    send(chatId: string, text: string): Promise<void>;
  };
  api: { fetch: PluginFetch };  // sessionFetch under /api/plugins/<id>/, authenticated
}
```

The kit is typed as **call signatures**, not `ComponentType` (the host's
`forwardRef` components carry invariant `propTypes`), and assigned from the real
components so a prop the kit promises that a component stops taking is a
compile error in the host, not a runtime surprise in a plugin. `api.fetch` is
typed off the consumer's global `fetch` (shared compiles without the DOM lib).

Rules:

- **Every `render` runs as its own component inside an error boundary scoped
  to the plugin** (`PluginSlot`). A `render` may call hooks; one that throws
  shows "<plugin> failed · Retry" in the slot's place. A `menu` is a ReactNode
  created once at registration, so state belongs in a component rendered inside
  it. The host never calls a plugin render inline.
- **A composer control enters the size ladder.** It is appended to the
  `COMPOSER_CONTROLS` registry at runtime as `<pluginId>:<id>` with a single
  `sm` rung and the given priority (built-ins run 0–6; default 1), it gets a
  root row and a drill-in view in the options menu (or runs `onSelect` when it
  has no `menu`), and it never adds a row to the composer box. The persona row
  incident is the reason this is a rule and not a suggestion. The drill-in is
  rows, never a popover: on a phone the menu is a bottom sheet.
- **Engines are per browser, not per chat.** Which dictation or TTS engine is
  active is a local preference beside the composer-control visibility prefs;
  the built-in Web Speech dictation and `speechSynthesis` TTS are always
  registered and are the default; the "Voice engines…" row appears in the
  options menu once a plugin has registered one. `unavailable()` lets the mic
  control explain a plugin engine that cannot run here instead of failing on
  press. A selection naming an unregistered engine falls back to the built-in.
- **TTS streams.** `TtsEngine` has `feed(text)`, `flush()`, `cancel()`. The
  host chunks the current chat's `message-chunk` deltas at sentence boundaries
  (`feed` gets whole sentences), flushes on the assistant row, cancels on a
  chat switch or toggle-off. Voice mode's convention is that the spoken part
  precedes a horizontal rule and the chunker stops there.
- **`chat.ext`** is `Chat.ext?: Record<string, unknown>` keyed by plugin id.
  `PUT /api/chats/:id` merges per key under the chat lock (two plugins cannot
  erase each other's writes); `null` under a key clears it, top-level `ext:
  null` clears all; the row rides `chat-update`. `host.chat.setExt` writes the
  caller's key only. The host never interprets it.
- **Raw buttons stay out.** `ui/rawButtons.test.ts` is a ratchet; plugin
  authors get the kit, and the examples use it.

Reference: `examples/plugins/hello-slot` (every slot once, `ext`-backed count,
`onPlugin` echo, a server half with two routes).

## Integrations

Everything under this heading is host work. No plugin is needed for a bot to
reach Dispatch, and the Grok plugin is mostly configuration of these pieces.

### Tokens, external MCP, REST

**Integration tokens** are long-lived bearer tokens for a non-browser,
non-chat caller.

- Format `dsp_` + 32 random bytes base64url. Stored hashed (SHA-256) with
  `name`, `scopes`, optional `projectIds`, `createdAt`, `lastUsedAt`,
  `expiresAt`, `revokedAt`, and `clientId` when an OAuth grant minted it.
- **Per instance**: owned by `AuthService` and persisted in
  `<dataDir>/integration-tokens.json` beside its sessions (the stable and dev
  instances do not share tokens), so **turning auth off revokes every token**
  under the rule sessions already follow — including one minted while the
  server was down, through the auth epoch it carries. Minting refuses while
  auth is disabled: an unauthenticated install has nothing to scope.
- The auth gate recognises the prefix before the JWT path and sets
  `req.authIdentity = { kind: "integration", tokenId, name, scopes, projectIds }`;
  browser sessions get `kind: "user"`. **A `dsp_` bearer is fenced to
  `/api/integration/*` and `/api/mcp/integration/*`** — every other `/api/`
  route only checks that the gate passed, so an unfenced token would have been
  owner-equivalent. Any new route a token should reach must be added to that
  fence, not merely given a scope check. `requireScope(req, scope)` answers 403
  with the missing scope named. WS tickets and account routes refuse
  integrations; they get webhooks instead.
- Rate limit 60 requests per minute per token, 429 with `Retry-After`.
- Minted once and shown once, in Settings → Integrations → Tokens
  (owner-only) or offline with `dispatch token create --name … --scopes …
  [--projects …] [--expires …] --config-dir <dir> --data-dir <dir>` — the data
  dir because the file is per instance; the server re-reads it on mtime, so no
  restart.

**Scopes:** `chats:read`, `chats:write`, `attention:read`, `attention:answer`,
`memory:read`, `memory:write`, `projects:read`, `webhooks:manage`, and
`tools:<category>` per manager category. Every `tools:*` is valid to hold, but
only categories with at least one external tool are **offered** — in the token
form, the AS metadata, a registration's default scopes, the consent page and
the grant chips — through `OFFERABLE_TOOL_SCOPES`, derived from
`MANAGER_TOOL_EXTERNAL` in `@dispatch/shared`.

**External MCP.** The manager bridge has a second mount,
`/api/mcp/integration/<category>`, serving the same category servers built with
an *external* `ManagerMcpContext` that has no self chat. The registry carries
`MANAGER_TOOL_EXTERNAL: Record<ManagerToolName, boolean>`, total and
cross-checked against the factory at compile time like the categories. The
rule for the flag: a tool that acts on the calling chat's own session, shell or
tree, or that puts a card in front of the human on the calling chat's behalf,
is **not** external. So `chat_find`, `chat_read`, `chat_send`, `chat_ask`,
`chat_reply`, `chat_state`, `wait_for_chat`, `project_info`, `project_list`, the
memory tools, the issue tools, `mode_list`, `config_list` and `config_read` are
external; `wait`, `context_usage`, `compact_context`, the workspace tools, the
PR tools, the confirm tools, the secrets tools, `chat_set_mode`,
`chat_set_persona`, `mode_read`, the `mcp_*` editors and every
`*_write`/`*_delete` are not. `spawn_chat` is flagged external but not offered
in v1 (its consent card needs a parent session). Memory and issue tools bind
only when the token names exactly one project. A category is offered only when
the token holds `tools:<category>`; the mount is authenticated by the gate (it
does NOT ride the per-chat bridge's gate exemption), and the external context
enforces `projectIds` itself, reporting anything outside them as unknown.

**REST**, under `/api/integration/`, a curated surface rather than scope checks
sprinkled over the SPA's routes:

| route | scope |
|---|---|
| `GET chats?projectId&status&since&q&limit&archived` | `chats:read` |
| `GET chats/:id` (digest) · `GET chats/:id/messages?kinds&before&after&limit` | `chats:read` |
| `POST chats/:id/messages { text, delivery?, sender? }` | `chats:write` |
| `GET attention` · `POST attention/:id/answer { optionId \| answer \| answers \| decline }` | `attention:read` / `attention:answer` |
| `GET projects` | `projects:read` |
| `GET openapi.json` | any |

Token `projectIds` filter every route (a chat outside them is a 404).

### Attribution

A row sent through the integration surface or `ctx.chats.send` carries
`origin: "channel"` and `channel: { name, askId? }` (`ChannelSender`, beside
the peer sender in `shared/src/messages.ts`; the broker stamps it instead of
`peer`). `UserRow` renders it as a `ChannelCard` with the voice
`<NAME> → <provider>` in info-blue — a third author that borrows neither the
peer's violet nor Dispatch's amber — never the speech bubble, including when
memory surfacing hands the row `parts`; the model receives a `channelReminder`
in the style of the peer one: this came from an external integration, the
human in the app may not have seen it. Resume snapshots carry `channel` the way
they carry `peer`.

### Outbound webhooks

A **subscription** is a row in the state database (`webhook_subscription`):
`id`, `name`, `url`, `secret`, `filters`, `active`, `pausedReason`,
`createdBy` (`user` or a token id), `createdAt`, `lastDeliveryAt`,
`consecutiveFailures`.

Filters (unset or empty = all, modelled on the attention filter): `events`
(wire event types plus `chat-settled`), `rowKinds` (for `chat-message`),
`attentionKinds` (for `attention-add`), `projectIds`, `chatIds`. The event
vocabulary is derived from `WsServerEventSchema` so a new wire event is offered
automatically; `hello`, `pong`, `message-chunk`, `terminal-output` and
`runner-log` are never offered — each is a per-chunk subprocess stream, and a
delivery row plus up to six HTTP attempts per chunk would fill the table and
the receiver within one noisy `pnpm dev`; their row-level `terminal-update` /
`runner-update` are offered instead.

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
  `verifyWebhookSignature` is exported beside the signer for receivers.

Deliveries are rows (`webhook_delivery`, holding the exact signed bytes so a
redelivery re-sends them) before they are requests; a shutdown mid-schedule
resumes on boot. Retries at 5 s, 30 s, 2 m, 10 m, 30 m, each re-signed with a
fresh `t`; after the fifth retry the delivery is dead; after twenty consecutive
dead deliveries the subscription is paused with a `pausedReason` and a `notice`
says so. The delivery log keeps seven days (retention rule 5) and is visible in
Settings → Integrations → Webhooks with status, attempts and the last response
code; a dead delivery can be redelivered. Test fires use the non-subscribable
type `webhook-test`.

Routes: `GET/POST/PUT/DELETE /api/webhooks`, `POST /api/webhooks/:id/test`,
`GET /api/webhooks/:id/deliveries`, `POST /api/webhooks/:id/deliveries/:d/redeliver`.
The secret is returned on create and on rotate only.

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
  proxy to the LAN (the check and the fetch resolve DNS separately, so a record
  flipped between them gets through once; a pinned-address client is not v1);
- it may read, edit, test and delete only subscriptions it created.

The existing `AppSettings.webhook` block (ntfy / pushover on attention-add) is
left alone.

### OAuth

The auth gate authenticates `/api/*` from a bearer header and nothing else.
A browser navigation carries no bearer, so every OAuth step a browser performs
lives **outside** `/api/`, and the three `/api/oauth/` endpoints that remain
(`register`, `token`, `revoke` — `isOAuthExchangePath` in `app.ts`, exact
paths) are exempt from the JWT gate because they *are* the credential exchange
and carry their own proof (PKCE verifier, client secret, refresh token). The
consent endpoints are gated on purpose. This is the one called-out exception
to the subresource rule at the end of this document.

**Authorization server** (`services/oauth-server.ts`, decorated as
`app.oauthServer`, built in `buildApp` because it mints through
`AuthService`). Remote-MCP connectors expect to discover and register
themselves.

- Offered only when auth is enabled **and the canonical URL is https or
  loopback** — loopback so a dev instance can be verified without TLS, matching
  the passkey setup's secure-context rule. Otherwise every endpoint 404s with
  the reason. Issuer = canonical origin.
- `/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource[/<path>]`: public metadata, CORS `*`.
  `scopes_supported` lists the offerable scopes. The integration MCP mount's
  401 carries `WWW-Authenticate: Bearer resource_metadata=…`, which is how a
  client discovers the server from the refusal alone.
- `POST /api/oauth/register`: dynamic client registration (public clients
  allowed — PKCE binds them; confidential clients get a secret shown once;
  redirect URIs must be https, loopback-http or a custom scheme, no fragment;
  20 per address per hour). A registration without `scope` gets the offerable
  scopes.
- `GET /oauth/authorize`: validates `client_id`, exact `redirect_uri`, scopes
  ⊆ the registration (then narrowed to those that grant something — RFC 6749
  §3.3 lets the server issue less, and the consent page, the grant and the
  token must agree), and the PKCE challenge (S256 mandatory). An unknown client
  or unregistered URI is shown, never redirected (open-redirector rule); every
  other refusal goes back as `error=…&state=…`. Valid requests park under a
  10-minute single-use nonce and redirect into the SPA at `#oauth=<nonce>`. The
  SPA already forces login before rendering anything, so a logged-out user
  sees the login sheet first, then the consent page naming the client, the
  redirect host and the scopes with hints. The decision goes back with the
  session's bearer, `POST /api/oauth/requests/:nonce/decision`, which mints
  the code (60 s, single-use) and returns the client's redirect URL.
- `POST /api/oauth/token` (code and refresh grants) and `POST
  /api/oauth/revoke` (RFC 7009): exempt from the gate, authenticated by what
  they carry. Code reuse revokes the grant it produced. Refresh tokens rotate;
  the claim is atomic, reuse within 30 s is refused without revoking (a lost
  response or parallel tool calls), past that the family dies; scope may only
  narrow.

An access token *is* an integration token with `clientId` set, one hour long
(it appears in the Tokens list with an `oauth` chip and is fenced like any
`dsp_`); refresh tokens are `dsr_…`, hashed, thirty days. On rotation the
superseded access token is removed from the token file — the grant row
(`oauth_grant`, with the auth epoch, so turning auth off kills refreshes too) is
the audit record. Grants appear in Settings → Integrations → Connected apps
(`GET/DELETE /api/auth/oauth/grants[/:id]`, owner-only); revoking the grant or
its access token ends the connection at the next refresh. RFC 8707 `resource`
is accepted and recorded but not enforced as an audience: the token is already
fenced to the integration surface by the gate, a stronger restriction than any
audience a connector could name. Tables (`oauth_client`, `oauth_grant`,
`oauth_refresh_token`, `plugin_oauth_token`) are per instance; codes and nonces
are in memory only.

**Client flow for plugins** (`plugins/oauth.ts`, `ctx.oauth` when the manifest
declares the `oauth` capability). A manifest `oauth.clients.<name>` entry gives
the host everything it needs; `clientId` / `clientSecret` may be literals or
`${secret:NAME}` references, resolved **server-side only** and only for names
listed under `secrets:`.

- `POST /api/plugins/:id/oauth/:name/connect` (session) and the Connect button
  in Settings → Plugins mint a single-use `state` with PKCE, valid ten
  minutes, and return the provider URL; the route refuses 409 up front when a
  referenced secret is unset. `ctx.oauth.connectUrl(name)` is the same without
  a request, and needs the canonical URL; the route falls back to the request
  origin for the redirect URL when no canonical URL is set, so an auth-off dev
  instance can complete a round trip.
- The provider redirects to `GET /oauth/callback/<plugin>/<name>`, outside
  `/api/` because it is a top-level navigation with no bearer. The handler
  authenticates the request by the `state` alone, exchanges the code, and
  redirects to `#settings=plugins` (a provider refusal rides along as
  `oauthError`, shown as a toast).
- Tokens live in the per-instance table `plugin_oauth_token`, keyed by
  `(pluginId, name)` with access token, refresh token, expiry and granted
  scopes. Not in the secret store: a flattened secret name built from two
  hyphenated identifiers is ambiguous (`a-b` + `c` reads the same as `a` +
  `b-c`), and a shared store would let the stable and dev instances race on
  refresh-token rotation and invalidate each other.
- `ctx.oauth.token(name)` returns a live access token, refreshing within 60 s
  of expiry and de-duplicating concurrent refreshes (keeping the old refresh
  token when the provider does not rotate); `ctx.oauth.disconnect(name)` and
  `DELETE /api/plugins/:id/oauth/:name` delete the row. `PluginInfo.oauth[]`
  carries `connected` / `expiresAt` / `scopes` / `configError`, and the pane
  shows Connect / "Connected until …" / Disconnect per client. The values
  never reach the SPA.

## Authoring

- `packages/plugin-sdk` (`@dispatch/plugin-sdk`): the shared types re-exported
  under one name, `definePlugin()` / `defineClientPlugin()`, the Vite presets
  (`./vite`: `dispatchClientBuild` for a bundle against the globals shim,
  `dispatchServerBuild` for a self-contained Node module), and
  `createTestContext()` (`./testing`) so a server plugin's `activate` can be
  unit-tested with an in-memory context and no server. The root entry is
  types and two identity helpers only — a value re-export from shared would
  inline zod into every plugin bundle — with the manifest schema and constants
  on `./manifest`. Built in the workspace, versioned with the host, not on
  npm; route handlers are typed `PluginRequest` / `PluginReply`, the structural
  subset of Fastify's objects a handler reads.
- `dispatch plugin init <id> [--server|--client|--both]` scaffolds a standalone
  directory whose `package.json` links the SDK from the checkout that ran `dispatch`
  (`link:`, so the SDK's own workspace dependencies resolve from its real path),
  with the manifest, both Vite configs, a settings schema, a vitest test using
  `createTestContext`, and a `pnpm-workspace.yaml` allowing esbuild's build
  script. `pnpm install && pnpm build && pnpm test`, then `dispatch plugin add .`.
- `examples/plugins/hello-server` (dependency-free JS, every basic server
  seam; the host's own test fixture), `hello-slot` (a client half built with
  the preset, every slot once), `event-forwarder` (TypeScript server plugin:
  bus → signed POST in the webhook scheme, with a `createTestContext` test) and
  `contributions` (one of every contribution kind) build in CI and are the
  canonical references; the root `pnpm test` runs their tests.
- A bundled skill, `packages/server/skills/plugin-authoring/`, teaches an agent
  the whole thing with references per topic (manifest, server API, client
  host, contributions, external API, testing, publishing). Bundled skills are
  materialized once per checkout and never refreshed; after changing it,
  delete `.claude/skills/plugin-authoring/` in any checkout that has run a
  session.

## History

The layer shipped in six PRs during 2026-10-21 → 10-22, one per workstream of
the original plan (tracker issues #373–#379): host core (#384, with the
registry fix #388), tokens / external MCP / REST / channel attribution (#382),
outbound webhooks (#385), OAuth (#392), contributions (#394), the client host
(#393), and the authoring layer (#397 and the docs PR that followed). Each PR
body carries a "Deviations" section against the spec as first written; this
document has been corrected to what shipped.

Providers became a contribution in two later PRs: #408 opened the provider id
(it had been a closed `z.enum` that was also the persistence schema), and the
next moved Codex and goose out of the server into built-in plugins.

## Rules every change to this layer inherits

- Comments say *why*, naming the failure the code prevents.
- A new app-level setting needs the schema, the preserve line in the
  full-replace route or the `normalize()` carry, and a `SECTION_SLICE` entry.
- Nothing under `/api/` is reachable as a bare subresource when auth is on; use
  the authenticated fetch helpers. The OAuth endpoints are the one called-out
  exception, and they are shaped to need it as little as possible: browser
  navigations live outside `/api/`, and only the credential exchange itself
  (`register`, `token`, `revoke`) is exempt from the gate.
- A route an integration token should reach goes into the gate's fence
  (`isIntegrationApiPath`), not merely behind a `requireScope`.
- A per-chat composer control goes into the toolbar ladder, never a new row.
- Verify UI by looking at it: a screenshot in the PR, both themes for anything
  in the composer or settings.
- `pnpm test` does not run the client suites; run them when you touch the SPA.
- Materialized skills never refresh; delete the stale directory after changing
  a bundled skill.
- The `dispatch-` prefix is reserved, in every new place a name can be
  declared.
- Two green PRs can still break `main` together when one adds a case to a set
  the other makes exhaustive (`MANAGER_TOOL_EXTERNAL` did exactly that once);
  rebase before landing anything that touches the tool registry.
