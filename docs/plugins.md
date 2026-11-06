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
                                # an entry ending in * is a prefix: VOICE_KEY_* covers VOICE_KEY_<anything>
capabilities:                   # declared for the consent card; see "Capabilities"
  - events
  - routes
  - chats:write
  - process
optionalCapabilities: [approvals] # granted where this host has them, ignored where not; see "Optional capabilities"
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
| `secrets` | `ctx.secrets.get/list` (only names listed under `secrets:`) |
| `secrets:write` | `ctx.secrets.set/delete` for the same names — see "Secrets a plugin writes"; requires `secrets` |
| `kv` | `ctx.kv` |
| `mcp` | `contributes.mcpServers` |
| `process` | `contributes.processes`, `ctx.processes` |
| `oauth` | `oauth.clients`, `ctx.oauth` |
| `ui` | a `client` entry |
| `providers` | `ctx.providers.register` — see "Providers" |
| `terminals` | `ctx.terminals.registerBackend/publishPort/ports` — see "Terminal backends" |
| `approvals` | `ctx.approvals.request` — see "Approval requests" |
| `runner` | `ctx.runner.list/reservedPorts` — see "Local ports" |
| `shared` | `ctx.shared` — values and leased locks every instance on the machine shares; see "Shared state and locks" |

A capability the manifest does not declare is simply absent from the context
object the plugin receives — the members are typed optional for that reason.
That is enforcement enough for code the owner chose to install; the point of
the list is the consent summary and the Settings row, not containment. A
contribution that needs a capability the manifest lacks (`mcpServers` without
`mcp`) is dropped with a warning on the row.

#### Optional capabilities

`optionalCapabilities` lists capabilities the plugin uses **where the host has
them**:

```yaml
capabilities: [routes, kv, terminals]
optionalCapabilities: [approvals]   # elevation needs it; everything else works without
```

- **A name this host knows is granted exactly like one under `capabilities`.**
  The same consent line and the same `ctx` member, with the same gate
  everywhere. The install card and the plugin's details mark it *optional*.
- **A name this host does not know is ignored**, and a note on the details
  and the install card names it. The same name under `capabilities` makes the
  whole manifest invalid. `capabilities` stays strict on purpose: it is what
  the plugin cannot run without.
- **Why it exists.** A plugin that adopts a capability newer than some of the
  hosts it runs on would otherwise be invalid on all of them. Hosts from before
  this key strip it as an unknown top-level key, so the plugin loads there
  without the capability.
- **Feature-detect the member.** `ctx.approvals` is `undefined` on a host that
  lacks it, exactly as if it were never declared. Say "needs a newer Dispatch"
  for the one feature, rather than failing the plugin.
- **An ignored name is granted later without asking again.** Nothing
  records what was granted at install: the grant is recomputed from the
  manifest on every boot. So once Dispatch is upgraded to a version that knows
  the name, the plugin gets it with no new consent card and no update diff,
  because nothing on disk changed. The install-time note says so, and
  installing past it is the consent. A plugin that wants a fresh card for a
  future capability should ship an update that declares it once the
  capability exists.
- A name in both lists counts as required. An optional `secrets:write` still
  needs `secrets`, because it widens `ctx.secrets`.
- **Testing.** `createTestContext({ capabilities, optionalCapabilities })`
  grants the known ones as the host does. Leave a name out of both lists to
  test the host that lacks it.

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
   module's `activate`, so it can talk to them. A plugin that activated is then
   `reconcile`d, detached — see "Cleanup lifecycle".
4. **Run.** Everything the plugin registered (bus listeners, route handlers,
   settings listeners, processes) is tracked against the plugin id so
   deactivate can undo it.
5. **Deactivate** on `services.dispose()` (reverse id order; an activation
   still in flight is not waited for — it tears itself down when it returns),
   when the enable toggle flips off, or on uninstall: `onShutdown` if exported
   (see "Cleanup lifecycle"), then `deactivate()` if exported (10 s budget),
   then the host drops the plugin's listeners, empties its route table (the
   prefix answers 404 from then on), stops its processes and stops serving its
   client directory. Fastify cannot remove a route from a listening instance,
   which is why plugin routes are a table and not registrations — see "Server
   API". Flipping the toggle on requires a restart; the pane says so.

`GET /api/plugins` returns, per plugin (`PluginInfo`): manifest summary, `dir`,
`status` (`active | disabled | error | invalid | incompatible`), `error`,
`enabled`, `needsRestart`, `capabilities`, `hasServer`, `clientUrl` (the entry
**module's** URL, `/plugins/<id>/<file>`, which the SPA imports as-is),
`settingsSchema`, `settings`, `settingsErrors` (stored values the schema
refuses — see "Plugin settings"), the declared `secrets` names, `oauth[]` (per
client: `connected`, `expiresAt`, `scopes`, `configError`), `warnings[]`
(non-fatal contribution problems, on the row rather than only in a server log),
`pendingCleanups` (failed per-chat cleanups still being retried — see "Cleanup
lifecycle"), `origin` (`url | local | linked | builtin | unknown`) and the
recorded `source` — see "Updating and uninstalling".
`PUT /api/plugins/:id/enabled` and the settings writes (`PATCH` / `PUT
/api/plugins/:id/settings`) are targeted, not settings-draft writes;
`POST /api/plugins/:id/reveal` opens the directory on the machine Dispatch runs
on (from a remote browser the pane also shows and copies the path).

### Plugin settings

`AppSettings.plugins[<id>].settings` lives in `<configDir>/config.json`, so both
instances share it and an update or reinstall keeps it. Three writers share it:

| writer | how |
|---|---|
| the generic form on the plugin's row | `PATCH /api/plugins/:id/settings { patch }` |
| the plugin's server half | `ctx.settings.set(patch)` |
| the plugin's browser half (its own `settingsSection`) | `host.settings.set(patch)` |

Every one is a **top-level merge patch**: each key replaces the stored value
wholesale (arrays and objects are not merged into), and `null` removes the key
(`undefined` too, in-process). Nothing writes a whole blob built from a copy
that may be stale. The form used to `PUT` its whole draft, and that erased
any key the plugin stored while the form was open. `PUT /api/plugins/:id/settings
{ settings }` still replaces the blob, for callers that predate PATCH.

**Validation.** The manifest's `settings` schema is compiled once at discovery
(zod's `fromJSONSchema`: types, enums, ranges, patterns, arrays of objects,
`required`, `additionalProperties`, `$ref`/`$defs`/draft-07 `definitions`). On
every write:

- an error on a key the write **changed** refuses the write — 400 `{ error,
  errors[] }` from the routes, a throw from `ctx.settings.set`, a rejection from
  `host.settings.set` — and nothing is stored;
- an error on a key the write left alone is **standing**: shown on the row as
  `settingsErrors` and never a reason to refuse. Settings stored before a
  plugin grew (or tightened) its schema keep working; the owner fixes them when
  they next touch them.

A schema the converter can't compile (`if`/`then`, for one) is not enforced at
all. The row's warnings say so, and writes are stored unchecked, as they were
before validation existed.

**Who hears a change.** Every change, from any writer, fires the plugin's
`ctx.settings.onChange` listeners and publishes `plugin-settings { plugin,
settings }` to every client. That event keeps `host.settings.get()` current and
updates an open Settings pane. A write that changes nothing fires nothing, so a
listener that writes back the same value does not loop. The OTHER instance's
writes are picked up by polling `config.json` every 2 s (`watchFile`, as the
secret store does), so `ctx.settings.get()` in stable sees a host list the dev
instance's plugin stored without a restart.

**A key the form can't render.** The generic form handles flat strings, numbers,
booleans and enums. Mark a property `readOnly: true` (JSON Schema's "managed by
the owning authority") and the form neither renders it nor lists it under "not
editable here". Your `settingsSection` owns it, editing through
`host.settings.get()/set()`, and the schema still validates it.

### Instance identity

Stable and dev run side by side on one machine. They share `config/`, so they
share every plugin's settings, secrets and code, but each has its own data dir.
A plugin that leaves work outside Dispatch, such as sessions on a remote
machine or files in a shared directory, has to know which instance owns it.
Otherwise dev's orphan sweep reaps stable's live work. That knowledge is
`ctx.instance`. It needs no capability, and the browser half gets the same
object as `host.instance`.

```ts
interface PluginInstance {
  readonly id: string;                  // namespace remote work by this
  readonly role: "stable" | "dev" | "other";
  readonly dataDirFingerprint: string;  // opaque; equality only
  readonly previousId?: string;         // the id before the last re-mint
  readonly reminted?: { at: string; reason: "copied" | "moved" | "hostname" };
}
```

- **`id`** stays the same for a data dir across restarts, and no two data dirs
  share it. It lives in `<dataDir>/instance.json`, next to a description of
  the directory it was minted for: the machine's hostname, the canonical path,
  and the volume and file id.
  - **A copy gets a new id.** At boot, the record is checked against the
    directory it is found in, so seeding dev's data by copying stable's, files
    and all, cannot make two instances answer to one id. A copy can never pass
    that check: it exists alongside its original, and two live directories on
    one volume never share a file id.
  - **These keep the id:**
    - a rename or move within the volume (same file id);
    - a restore in place (same path; two live directories can't share a path,
      so it isn't a copy).
  - **These re-mint it:**
    - a move to another volume;
    - a copy;
    - carrying the data to a machine with a different hostname, or renaming
      the machine.
- **`previousId` and `reminted`** say what the id was before and why it
  changed.
  - `copied`: the directory the id was minted for still holds that id. So
    `previousId` is the id of a running sibling, typically stable.
  - `moved`: that directory no longer holds it.
  - `hostname`: the record names another machine.

  Use `previousId` to show "work left by instance X" and let the owner adopt it
  or clean it up after checking it isn't live. **Never adopt it
  automatically**: for a copy, that hands dev stable's work.
- **`role`** is a label for display and policy, never a namespace, because two
  `dev` instances can run at once.
  - `stable`: this process serves the installed deployment's data dir, the line
    `installedRoots` draws.
  - `dev`: the server was started by `pnpm dev`.
  - `other`: anything else (a throwaway instance, a test, a payload launched
    against another root).
- **`dataDirFingerprint`** hashes the hostname, path, volume and file id. It
  changes on every copy, move, restore or rename, including the ones that keep
  `id`. Store it beside work you leave elsewhere to tell "my id, where I left
  it" from "my id, but the directory moved".

**Known limit:** "same host and same path" means "same directory" only within
one filesystem namespace. Suppose two containers share a hostname (host
networking) and each mounts a different directory at the same path. Copying
one directory into the other keeps the original's id. Dispatch ships no
container deployment. One that adds it should give each container its own
hostname.

`ctx.instance` is read once per process, on first use. If it can't be read
(an unreadable data dir), the member is absent rather than invented. A plugin
that namespaces by it should refuse to clean anything up rather than fall back
to a guess. It is typed optional for hosts before it. The browser half's copy
is read once by the plugin loader (`GET /api/plugins/instance`), in parallel
with the plugin list.

### Cleanup lifecycle

A plugin that makes things **outside** the Dispatch process (a container per
chat, a remote session, a tunnel) needs to clean them up, and the moment it is
told to is not always the moment it can. Three optional hooks cover it, all on
the module next to `activate`:

```ts
export default definePlugin({
  activate(ctx) { /* … */ },
  /** The plugin is going down, and why. Initiate, don't wait. */
  async onShutdown({ reason, deadline, signal }) {
    if (reason === "uninstall") await destroyEverything({ signal });
    else if (reason === "disable") { /* keep it — it is wanted again when switched back on */ }
    else await stopRunningContainers({ signal }); // restart | stop: SEND the stop, don't poll for it
  },
  /** Settle what you made against what still exists. */
  async reconcile({ chats, signal }) {
    const live = new Set(chats.map((c) => c.id));
    for (const made of await myRecords()) if (!live.has(made.chatId)) await destroy(made, { signal });
  },
  deactivate() { /* in-process resources only */ },
});
```

**`onShutdown({ reason, deadline, signal })`** — `reason` is exact on every path:

| reason | when | what to do |
|---|---|---|
| `restart` | Settings → System → Restart; this process exits 75 and the supervisor starts a new one | stop what costs money while nobody is driving it, or leave it for the next process's `reconcile` |
| `stop` | Stop, `pnpm app:stop`, Ctrl-C, the desktop shell closing — no restart promised | same |
| `disable` | the owner switched the plugin off | keep what you made; switching back on (after a restart) reconciles it |
| `uninstall` | Settings → Plugins → Uninstall | destroy EVERYTHING — nothing will ever reconcile it again |

On a server shutdown every active plugin's hook runs **in parallel** on one
shared budget, `PLUGIN_SHUTDOWN_BUDGET_MS` (5 s), alongside the shell reap and
before `app.close()` — it is `installShutdown`, not `dispose()`, that asks,
because only it knows a restart from a stop. Past the budget `signal` aborts,
the host logs `plugin "<id>" onShutdown(<reason>) overran its 5s budget —
moving on without it`, and teardown carries on. A Restart waits on this, so:

- **Initiate, don't wait.** A Proxmox `stop` takes 30 s or more; send it and
  return. Pass `signal` to `fetch` so a request that overruns is cancelled
  rather than leaked.
- **Idempotent.** It can run for state that is already gone.
- **Never load-bearing.** It does not run on a crash, a hard kill or a power
  cut. Correctness comes from `reconcile`.

After `onShutdown`, `deactivate()` runs as before. A plugin that is not active
(switched off, failed to activate) gets no `onShutdown` — including on
uninstall, so uninstalling a plugin while it is switched off cannot run its
cleanup. Switch it on and restart first if it holds anything remote.

**`reconcile({ chats, deadline, signal })`** — after every successful
`activate` (every boot, and the first boot after a re-enable — re-enabling
needs a restart anyway), detached: boot and the next plugin's activation do
not wait. Budget `PLUGIN_RECONCILE_BUDGET_MS` (120 s); `signal` aborts at the
deadline or when the plugin goes down first, and a reconcile is never started
on a plugin that has already had its `onShutdown`. `chats` is every chat in
this instance (archived ones flagged), each with `terminalBackend` when its
DEFAULT terminal location — pin, else project default — is a backend. Per-
terminal picks are not persisted, so a backend that must know every chat it
served keeps its own record (`ctx.kv`). A chat missing from `chats` was
deleted: anything held for it is an orphan from a delete the plugin never
heard about. This is the guarantee the shutdown hook cannot be.

**Durable per-chat cleanup.** A terminal backend's `onChatDeleted` is awaited
(60 s, `TERMINAL_CHAT_HOOK_TIMEOUT_MS`) without holding the delete open. A
rejection or a timeout is written to `plugin_cleanup` in `data/state.db`, keyed
by plugin + backend + hook + chat, and retried:

- with backoff while the server runs (1 min, 5 min, 15 min, 1 h, then every
  6 h);
- right after the plugin's next activation, once its `reconcile` has run;
- on demand from the plugin's row in Settings → Plugins (**Retry now**).

A hook that was only slow still counts: when it resolves after its timeout the
retry is withdrawn. A row whose backend is not registered (the plugin is off)
waits without spending an attempt. **Forget** drops the rows without running
them, for when the owner has cleaned up by hand; uninstalling the plugin drops
them too. While rows are pending the row shows how many, since when, the last
error and the chats concerned (`PluginInfo.pendingCleanups`;
`POST /api/plugins/:id/cleanups/retry`, `DELETE /api/plugins/:id/cleanups`,
both owner-only).

So `onChatDeleted` must resolve only once the destroy was **accepted**, reject
when it was not, and be idempotent: a retry may arrive for a chat already
cleaned up, or for one this backend never served.

**Testing it.** `createTestContext()` plays the host's side:
`t.lifecycle.shutdown(mod, reason, { budgetMs? })` calls `onShutdown` then
`deactivate` and returns `{ overran, error?, elapsedMs }`;
`t.lifecycle.reconcile(mod, chats)` calls `reconcile`; `t.terminals.chatDeleted`
rejects when the hook does. The budgets are exported from
`@dispatch/plugin-sdk/manifest`.

### Install and the CLI

```
dispatch plugin init <id> [--server|--client|--both] [--name <n>] [--dir <parent>] [--sdk <path>]
dispatch plugin add <path | git-url | tarball>   validate in the source, copy into plugins/<id>, print the consent summary
        [--plugin <path|id>]... [--all]          pick from a collection (see "Several plugins in one repository")
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
  and a declared capability nothing uses. A literal `ctx.secrets.get("X")` (or
  `set`/`delete`) for an unlisted `X`, a `secrets:` prefix entry, and a bare npm
  import in a built entry, are warnings.

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

### Several plugins in one repository

A **collection** is a directory without its own `plugin.yaml` that holds plugin
directories below it — a repository of plugins, or `examples/plugins` in this
one. Pasting its URL answers with a `PluginCollectionInspection`
(`packages/shared/src/plugin-collection.ts`) instead: the collection's identity
and, per member, the **full** single-plugin report its own URL would give. The
pane renders that as a pick list (verdict, capability chips, warning count per
row; the whole report one click away), and **Install N** posts
`POST /api/plugins/install { url, sha, subdir }` once per ticked row.

Membership is `dispatch-plugins.yaml` at the collection root when there is one,
otherwise every directory with a `plugin.yaml`, outermost first (a plugin that
vendors an example plugin is one plugin):

```yaml
# dispatch-plugins.yaml — optional
name: Home lab
description: Plugins for the boxes in the closet
plugins:
  - plugins/hass
  - path: plugins/proxmox
```

It lists paths and nothing else on purpose: name, version and capabilities live
in each `plugin.yaml`, and a second copy would drift from the one the host reads.
A broken manifest does not hide the collection — the listing falls back to the
scan and says why. A `plugin.yaml` at the URL's own directory always wins: that
URL has always meant "this plugin".

Rules that keep it as safe as one plugin:

- **`subdir` is checked server-side** (`memberSubdir`): normalised, no `..` or
  reserved names, and at or under the directory the URL names. A client cannot
  install a directory the owner was not shown.
- **Nothing is pre-selected**, and each install is the ordinary single-plugin
  path — re-fetch the sha, re-run the report, refuse unless installable — so a
  batch is N independent installs, and one failure leaves the others standing.
- **The first fetch is soft.** A monorepo blows the caps long before its last
  `plugin.yaml` streams past, so collection discovery stops *writing* at a cap
  (`extract.overflow`) and keeps reading, still keeping every manifest (256 KB
  each, 64 at most). If it overflowed, a second, strict fetch of the same commit
  keeps only the members' directories, with the file and byte caps scaled by the
  member count (up to ×10). A single plugin that overflowed is refused with the
  cap it crossed, exactly as before.
- **The recorded source is the collection URL plus the member's `subdir`.**
  Update already follows `source.subdir`, so a member updates on its own and
  nothing in the update path knows collections exist.

`dispatch plugin add <collection>` refuses to guess and lists the members; pick
with `--plugin <path|id>` (repeatable) or `--all`. Each pick is its own add.

### Catalogs

A **catalog** is a collection URL the host remembers, so Settings → Plugins can
list what there is to install without anyone pasting a URL
(`packages/shared/src/plugin-catalog.ts`, `PluginCatalogService` in
`packages/server/src/plugins/inspect/catalogs.ts`).

- **The built-in catalog** is `https://github.com/mdennis281/dispatch-plugins`
  (`BUILTIN_PLUGIN_CATALOG`). It is always listed and can be switched off, but
  never removed — it is not stored, only whether it is off.
- **Added catalogs** live in `AppSettings.pluginCatalogs` (`config/`, shared by
  both instances like `plugins`). An add READS the URL first and is refused
  with the inspector's reason if it holds no plugin, so a typo is never saved as
  a row that fails every six hours. The same URL twice is a 409.
- **A refresh is `PluginInspector.inspect`** — the same tarball fetch and full
  per-member report Inspect from URL produces — run per catalog on Refresh,
  Refresh catalogs, and every `DISPATCH_PLUGIN_UPDATE_HOURS` (first pass 3 min
  after boot, after the update watcher's). A failed refresh keeps the last good
  listing and shows why.
- **The listing is cached** in `<dataDir>/plugin-catalogs.json` (per instance,
  one writer), so the browse list is there immediately after a restart. Each
  report's `installed` block is recomputed on every read (`installedState`):
  the listing may be hours old, the install state never is.
- **Installing from a catalog is the ordinary install**
  (`POST /api/plugins/install { url: <catalog url>, sha, subdir }`), so the
  recorded source, updates and uninstall know nothing about catalogs, and
  removing a catalog uninstalls nothing.

Routes are under their own prefix, `/api/plugin-catalogs` (not
`/api/plugins/catalogs`, which a plugin with the id `catalogs` would own), and
all of them are owner-only. "Catalog", because "provider" is an agent runtime
here and `PluginSource` is one install's origin.

### The Settings pane

Settings → Plugins is a list with a page per plugin:

- **Installed**: one row each, showing status, version, and an update badge
  (from a Check, the background pass, or a catalog listing a newer version).
- **Available**: grouped by catalog, showing what each enabled catalog lists
  that is not installed.
- **Catalogs**: add, switch off, refresh or remove a catalog.
- **Inspect from URL**.

Clicking an installed row opens the full card. It has the enable toggle, status,
error text, capability and secret chips, and warnings. It renders a generic
settings form from the JSON schema (string / number / integer / boolean / enum).
It also has Connect / Disconnect per declared OAuth client, the source line,
copy path, "open folder", Check for updates and Uninstall. When a catalog lists
the plugin, that catalog's full report follows the card. Its InstallBar offers
"Update to X" when the catalog is ahead, and that is also how a copy installed
from an old URL is re-pointed at its catalog. Clicking an available row opens
the same report a pasted URL would give, with Install.

### Updating and uninstalling

**The recorded source.** Every URL install — the pane's Install, and `dispatch
plugin add <git-url>` — records `AppSettings.plugins[id].source` =
`{ type: "git", url, cloneUrl, ref, refKind: branch | tag | sha, subdir, sha,
installedAt, contentHash }` in `config.json`; `add <path | tarball>` records `{ type: "local",
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

**Check for updates** (`POST /api/plugins/:id/check-update`, per row, "Check all
for updates", and the background pass below) resolves the record against one `git
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

**A moved ref is not an update until the plugin's own files change.**
`contentHash` is a sha256 over the installed files (`hashPluginTree` in
`packages/cli/src/core/plugins.ts`: sorted relative paths and each file's sha256,
`.git`/`node_modules` skipped, no links followed), recorded by every install and
update. When the ref points somewhere new, the fetched directory is hashed. If it
matches, the check answers `up-to-date` ("main moved to abc1234, but nothing in
plugins/x changed") and **fast-forwards the record** to the new commit, so the
next check is one `ls-remote` again rather than another tarball. In a repository
of several plugins (see "Several plugins in one repository") most pushes are to a
sibling, and without this every one of them read as an update to all the others.
A record from before `contentHash` falls back to hashing the installed directory
and fills it in. `dispatch plugin update` does the same; `--check` stays read-only.

**Background checks** (`PluginUpdateWatcher`, `packages/server/src/plugins/inspect/watcher.ts`)
run that same `checkUpdate` for every `url` plugin two minutes after boot and then
every `DISPATCH_PLUGIN_UPDATE_HOURS` (default 6; `0` turns them off), on unref'd
timers like the release poller. What a pass does with an answer is the plugin's
`AppSettings.plugins[id].autoUpdate` (`PUT /api/plugins/:id/auto-update`, the
row's **Updates** picker):

- `notify` (the default) — an available update becomes a `notice` toast, **once
  per commit** (not once per pass), and shows on the row the next time the pane
  opens.
- `auto` — an update that asks for **nothing new** (no escalation in the diff),
  is installable, and keeps its id, is installed through the same `update` path.
  It is files on disk plus `needsRestart`, **never a restart**: stopping the
  server tree-kills every subApp and cuts every running chat, and when that
  happens is the owner's call. An update that escalates, or one `update` refuses
  (the ref moved mid-pass), is announced like `notify`.
- `off` — skipped; the row's Check for updates still works.

`GET /api/plugins/updates` returns the latest answers and what was auto-installed
since boot (memory only — a restart is exactly when an applied update stops being
news). The pane seeds each row's check from it, but only while the answer was
computed against the commit still installed, so an update that already happened
is never offered again.

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
and the global secrets its manifest lists — a `PREFIX*` entry expanded against what
is stored — except any another installed plugin also covers, which are kept and named. kv rows and OAuth tokens are per instance (they
live in `state.db`); the CLI reaches them only with `--data-dir`. A browser bundle an
open tab already imported has no unload hook, so the result says those tabs keep it
until they reload.

**Built-in plugins** get none of this: no Update ("Built-in, updates with
Dispatch"), no Uninstall, and Install refuses their ids. The enable toggle stays.
All six routes (check, update, uninstall preview and uninstall, auto-update,
updates) are owner-only, like inspect and install: the policy decides whether code
gets installed unattended.

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
  readonly instance?: PluginInstance;   // which instance this is; see "Instance identity"

  bus?: {
    on<T extends WsServerEventType>(type: T, fn: (evt: Extract<WsServerEvent, { type: T }>) => void): () => void;
    subscribe(fn: (evt: WsServerEvent) => void): () => void;
  };
  /** Add handlers under /api/plugins/<id>/ — a TABLE the host's wildcard consults; see the rules below. */
  routes?(define: (r: PluginRouter<Req, Reply>) => void): void;
  settings: {
    get<T = Record<string, unknown>>(): T;
    onChange(fn: (next: unknown) => void): () => void;   // every change, from any writer or instance
    set?(patch: Record<string, unknown>): Promise<Record<string, unknown>>;   // merge patch; schema-checked; see "Plugin settings"
  };
  secrets?: {
    get(name: string): Promise<string | undefined>;
    list(): Promise<string[]>;                         // covered names that have a value, sorted
    set?(name: string, value: string): Promise<void>;  // secrets:write
    delete?(name: string): Promise<boolean>;           // secrets:write; true when there was a value
  };
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
  approvals?: {
    request(chatId: string, req: PluginApprovalRequest): Promise<PluginApprovalResult>;   // see "Approval requests"
  };
  shared?: { get; entry; set; compareAndSet; delete; list; lock; holder };   // see "Shared state and locks"
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

#### Secrets a plugin writes

Some credentials are not typed in by the owner but MINTED by the plugin — an SSH
keypair per paired machine, say. Nothing else a plugin can write is all three of
shared by both instances, encrypted at rest, and untouched by an update: `kv` is
per-instance plaintext in `state.db`, and the plugin directory is replaced
wholesale by an update. So `secrets:write` adds `ctx.secrets.set(name, value)` and
`ctx.secrets.delete(name)` to `ctx.secrets`:

- **Same names as reading.** Only what `secrets:` covers. An entry ending in `*`
  is a **prefix** (`REMOTE_HOST_KEY_*` covers `REMOTE_HOST_KEY_cvx_mac`), for a
  plugin that mints one secret per thing it manages and cannot list the names up
  front. The part before the `*` is required — a bare `*` is refused. A prefix
  works for every reader of the list: `ctx.secrets`, `${secret:…}` in `mcp.yaml`
  and in `oauth.clients`, the inspector and uninstall.
- **Global scope, the one store.** `<configDir>/secrets.json`, AES-GCM under the
  DPAPI-wrapped key, exactly what the Secrets pane writes. The other instance sees
  the value on its next read and refreshes its own consumers.
- **Refusals throw**: a name `secrets:` does not cover, a name the store would
  refuse (`[A-Za-z_][A-Za-z0-9_]{0,63}`), an empty value (use `delete`), a value
  over 64 KiB. (`get` of an uncovered name still warns and returns `undefined`.)
- **Consumers refresh.** `set`/`delete` resolve after every MCP server and
  sub-app that references `${secret:NAME}` has been refreshed — the same
  `SecretRefresher` pass a save from the Secrets pane runs. That covers project
  config servers and sub-apps, and plugin-contributed servers (including the
  plugin's own) in every live chat; a runtime that can't swap servers
  mid-session picks the value up on its next session. A refresh failure is
  logged, not thrown: the value is stored.
- **Consent.** `secrets:write` is its own capability with its own line on the
  consent card, and it requires `secrets` (a manifest declaring only
  `secrets:write` is invalid). Adding it in an update is an escalation, as is a
  new `secrets:` entry; a new prefix entry is shown as the family it covers. The
  inspector flags a literal `ctx.secrets.set("X")` for an uncovered `X`.
- **Uninstall with purge** expands a prefix against what is stored, so the keys a
  plugin minted go with it — unless another installed plugin's `secrets:` also
  covers them.
- **`kv` is a table** (`plugin_kv(plugin, key, value, updated_at)`) in the
  per-instance state database, not a JSON file. Same reason runner state moved.
  Values are JSON; `set(key, undefined)` deletes.
- **No runtime npm imports in `server/index.js`.** It is imported from the
  plugin directory, where there is no `node_modules`. Write TypeScript and
  bundle it with the SDK's `dispatchServerBuild`, or write dependency-free
  JavaScript (`examples/plugins/hello-server`).

#### Shared state and locks

`ctx.kv` is per INSTANCE: stable and dev each have their own `state.db`. A
plugin that does work OUTSIDE Dispatch which either instance could do (one
agent per remote machine, one upgrade at a time, one elevation per machine)
needs a record both agree on. `shared` adds `ctx.shared`, kept in
`<configDir>/plugin-shared.db`: every instance on the machine sees the same
values and locks, and a plugin update keeps them.

```ts
await ctx.shared?.set("agent/cvx-mac", { version: "1.3.0" });   // → new version
const e = await ctx.shared?.entry("agent/cvx-mac");              // { value, version, updatedAt, updatedBy? }
const r = await ctx.shared?.compareAndSet("agent/cvx-mac", e.version, next);  // { ok: true, version } | { ok: false, current? }
// get / delete / list(prefix) as with kv

const lock = await ctx.shared?.lock("upgrade:cvx-mac", { ttlMs: 30_000, waitMs: 10_000 });
if (!lock) return;                       // someone else has it, and kept it past waitMs
try { /* … */ } finally { await lock.release(); }
await ctx.shared?.holder("upgrade:cvx-mac");   // { instanceId?, role?, mine, acquiredAt, expiresAt } | undefined
```

- **Per plugin.** Keys and lock names are scoped to the plugin id, so one
  plugin cannot read or take another's.
- **Values** are JSON, at most 1 MiB each. Keys are 1–256 characters.
- **Versions.** Every write bumps a version. `compareAndSet(key, version, value)`
  writes only if nobody wrote in between, and `null` means "only if absent".
  It is atomic across BOTH instances: each write takes SQLite's write lock up
  front.
- **Locks are leases.** The default is 30 s (1 s to 1 h). A lease is
  auto-renewed every third of its TTL while held, unless you pass
  `autoRenew: false`, and is recorded with the holder's `instance.id` and
  role. An instance that dies without releasing frees the lock when its lease
  runs out, so a lock never needs a human to clear it.
  - If a renewal finds the lease expired or taken, the lease is `lost`:
    `renew()` returns false, `onLost` fires once, and `release()` leaves the
    new holder alone. Stop acting as the holder.
  - Locks are not re-entrant. A second `lock()` of a name you hold waits like
    anyone else's.
  - `signal` stops a wait.
- **Teardown.** Deactivation releases every lease the plugin still holds, so
  the other instance does not wait out a TTL for a holder that is certainly
  gone.
- **Uninstall with purge** removes the plugin's shared rows for EVERY instance,
  and the confirm dialog says so. The CLI's `dispatch plugin uninstall --purge`
  does the same.
- **Mixed versions are the norm.** Stable and dev are different builds opening
  one file, so its schema is additive-only. An older build keeps working
  against a file a newer one has touched.
- **Testing.** `createTestSharedStore({ now? })` is the shared root. Hand one
  to two `createTestContext({ instance: { id }, sharedStore })` calls to play
  stable and dev, and move `now` to let a lease run out.

#### Approval requests

`approvals` adds `ctx.approvals.request(chatId, req)`: the plugin puts ONE
decision in front of the human — "run `sudo installer -pkg …` on CVX Mac?" — and
waits for it. It exists for a plugin that is itself the gate on something the
agent must not do alone (remote-host's elevation: the plugin holds the key that
can run a command as root, and runs it only on a yes).

```ts
const r = await ctx.approvals?.request(chatId, {
  title: "Run a command as root",            // required, ≤ 200 chars
  command: "sudo installer -pkg /tmp/x.pkg -target /",   // shown verbatim, ≤ 8000
  cwd: "/Users/dispatch/repo",
  machine: "CVX Mac",
  detail: "Requested by the agent's dispatch-elevate call.",   // ≤ 4000
  timeoutSeconds: 300,                       // default 300, at most 3600
  signal,                                    // abort → the card is withdrawn
});
// r: { decision: "approved" | "denied" | "timeout" | "cancelled"; by?: string; at: number }
if (r?.decision !== "approved") return refuse();
```

- **The same card as a tool-call permission.** Same Attention Queue entry (kind
  `permission`, summary `<plugin name>: <title>`), same push notification and
  notifier webhooks, same `awaiting-input` status, so the chat reads as
  blocked on the human. The card names the plugin from its MANIFEST — a plugin
  cannot ask in another's name — and shows the command in full. It has
  **Approve once** and **Deny** and nothing else: no Edit (approving an edited
  command approves something the plugin never asked for) and no "Always allow".
- **Only the owner answers it.** The one path that settles it is the card's
  button over the app's socket, from the owner's signed-in session (on an
  install without sign-in, whoever reaches the app is the owner). Refused, in
  both directions: another user's session, `ctx.attention.answer` (any
  plugin's, the requester's included), an integration or OAuth token (REST
  `attention/:id/answer` and MCP `attention_answer` answer 409, as for any
  permission), and the socket's question actions naming the same id.
- **Every ending without a person is a no.** `timeout` after `timeoutSeconds`;
  `cancelled` when `signal` aborts, when the chat's session ends (Stop,
  interrupt, teardown), or when the plugin goes down (disable, uninstall,
  restart). `by` is set only on `approved`/`denied`, and only when sign-in is
  on. Anything but `approved` must be treated as denied.
- **It leaves a record.** Every decision writes a `notice` into the chat's
  transcript ("Approved by Michael: `sudo …` on CVX Mac (asked by Remote
  hosts)"), a resolved permission row whose `input.outcome` is the decision,
  and a row in the instance's `approval_audit` table, which outlives the chat
  and the plugin.
- **It rejects when nobody can be asked.** No title, an over-long field, a
  timeout out of range, an unknown chat, or a chat with **no live session** to
  ask through: the promise rejects rather than inventing an answer. The card
  rides the session's permission channel, so the chat must be running — which
  it is when the request comes from a command the agent ran. A request from
  outside any chat (a Settings pane button) has no card to put it on; the
  owner clicking the button is the consent there.
- **Feature-detect it.** `ctx.approvals?.request` is absent on hosts before
  it; a plugin that guards something with it must refuse — loudly — when it is
  missing, never fall through to "approved".
- **Testing.** `createTestContext({ approve })` plays the human: return a
  decision, `{ decision, by }`, or a promise of one (a promise that never
  settles is a card nobody answers, which the request's `signal` withdraws).
  The default is `timeout`. Every request is recorded in `t.approvals` with its
  result, and the host's refusals reject there too.

#### Local ports

`runner` adds a read-only view of this machine's ports: what is running and
holding which, and which ports a plugin must never bind or expose. It is for a
plugin that binds or exposes local ports on someone else's behalf —
remote-host forwards a listener on a paired Mac to the SAME port number here
when it can, so OAuth redirects and CORS origins survive the trip.

```ts
const running = await ctx.runner?.list();
// [{ id, owner: { kind: "sub-app", projectId, chatId?, subAppId, branch? }
//            | { kind: "plugin", pluginId, processId },
//    status: "starting" | "running" | "stopping", ports: [5173], url?, adopted? }]

const reserved = await ctx.runner?.reservedPorts();
// [{ port: 4318, owner: "dispatch", reason: "the installed Dispatch instance's default port" },
//  { port: 8765, owner: "plugin:voice", reason: "declared by plugin \"voice\" for its process \"whisper\"" }, …]
```

- **`list()` is what holds a port now.** Every live sub-app and plugin
  process, any project, with whoever owns it. Stopped rows are left out.
- **`reservedPorts()` is the deny-list, and it is about ownership, not
  occupancy.** A port can be free only because its owner is down: a forward
  parked on 4319 while `pnpm dev` is stopped keeps the dev instance from
  starting (or, on Windows, lets both bind it and answer half the requests
  each). So it includes, whether bound or not: this instance's port, the
  installed instance's (read from its `runtime.json` — the launcher scans up
  from 4318 when that is taken), 4318, 4319, the dev live-reload socket 24678,
  every installed plugin's declared `processes[].ports` (enabled or not), and
  every port a plugin process actually holds (the allocator moves past a busy
  declared one). One row per port; Dispatch's reason wins, so a plugin that
  declares 4319 does not make it the plugin's.
- **Sub-apps are not reserved.** They are in `list()`; their ports move with
  the allocator, and refusing a port a user's dev server might want later
  would refuse most of them.
- **A reverse forward must refuse every reserved port.** Exposing a Dispatch
  port to another machine hands its API — create chats, run commands here —
  to every process over there.
- **Feature-detect it.** `ctx.runner` is absent on hosts before it, and on a
  host with no runner. A plugin that guards a forward with it should treat
  "absent" as "the defaults are reserved", not as "nothing is".
- **Testing.** `createTestContext({ capabilities: ["runner"] })` serves
  `t.runnerProcesses` from `list()` and `t.reservedPorts` from
  `reservedPorts()`; push to them. `t.reservedPorts` starts with 4318, 4319
  and 24678, as a real host's always does.

### The `plugin-event` wire event

One member of `WsServerEventSchema`:

```ts
{ type: "plugin-event", plugin: string, chatId?: string, payload: unknown }
```

The server publishes it from `ctx.emit`; the client host delivers it to the
owning plugin's `host.events.onPlugin`. One generic event instead of a schema
per plugin keeps the wire closed and typed; what a plugin puts in `payload` is
its own contract with its client half.

A second, host-owned member carries settings changes:

```ts
{ type: "plugin-settings", plugin: string, settings: Record<string, unknown> }
```

It is published after every change to a plugin's stored settings (see "Plugin
settings") and feeds `host.settings`. The payload is the whole blob, which any
signed-in client can already read from `GET /api/plugins`.

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

An agent runtime — what a chat actually runs on — is a plugin contribution,
and **no runtime is compiled into the host**. Claude, Codex and goose are all
built-in plugins: `packages/plugins/claude`, `packages/plugins/codex` and
`packages/plugins/goose`. The Claude Agent SDK is a dependency of the Claude
plugin and of nothing else, so an install with that plugin switched off spawns
no `claude` process and sends nothing to Anthropic (#422, #428).

There is **no fallback provider and no default one**. A chat whose provider is
disabled, uninstalled or not installed shows "provider unavailable" and does
not run; it is never moved to another provider. Titles and commit messages run
on the app's default provider through `Harness.generateText`, and are skipped
(or the button says why) when there is none.

A provider plugin declares the `providers` capability and calls, from
`activate`:

```ts
ctx.providers.register(harness, descriptor);
```

- `harness` implements `Harness` (`@dispatch/shared` → `harness.ts`): the
  session factory, the model list, limits, and optionally `probeLogin(exe, env)`.
  A harness without `probeLogin` is shown as "login not checked" — the host no
  longer guesses by provider id. With one, the host probes each registered
  provider's login in the background (cached per account for five minutes,
  `services/provider-logins.ts`), and a chat whose account last probed
  `checked: true, loggedIn: false` shows "provider unavailable" with reason
  `logged-out` instead of failing mid-turn. A probe that could not run
  (`checked: false`) or reports `notRequired` never refuses a turn.
- Optionally `startLogin(exe, env)` → `HarnessLoginFlow`: run the runtime's own
  sign-in for one account (`env` carries that account's overlay). With it,
  Settings → Accounts offers **Log in** on that provider's accounts. The flow
  reports `{ url, userCode?, awaitingCode?, hint? }` through `onProgress`, and
  takes a pasted code through `submitCode` if it has one. Its `done` settles when
  the CLI exits, and the host then re-probes that account so the `logged-out`
  banner clears at once. The host never sees a credential, only the URL and the
  one-time code it relays to stdin. Claude drives `claude auth login`, a
  paste-code flow that works from any browser. Codex drives `codex login`,
  whose localhost callback only completes in a browser on the host, and its
  `hint` says so. goose has no login and leaves `startLogin` out. Routes:
  `POST|GET|DELETE /api/subscriptions/:id/login` and `POST …/login/code`, all
  owner-only (`server/src/services/account-login.ts`).
- `descriptor` is the `ProviderDescriptor` every surface labels, picks and
  accounts it by (label, seed models, efforts, skills dir, how an account is
  selected). Its `id` must equal `harness.kind` and match
  `^[a-z][a-z0-9-]{0,39}$`; it is what chats, projects and subscriptions store.
- Registering an id that is already taken throws, so nothing can shadow
  another plugin's provider. Deactivation (the toggle) unregisters it and calls
  `harness.dispose()`; a chat pinned to it then shows "provider unavailable"
  and recovers by itself when the plugin comes back. `dispose()` may end
  sessions in flight — switching Codex off tears down its shared app-server, so
  a Codex turn running at that moment errors rather than finishing.
- Chats written before provider selection existed were backfilled once to
  `"claude"`, which is why the Claude plugin's id must stay `claude`.

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
  and refuse to run. One that declares managed processes still waits for
  `warm()`, behind the runner reconcile.
- They own their ids. An installed plugin with a built-in's id is ignored (and
  logged), and Settings → Plugins → Inspect refuses to install one.
- They are workspace packages, so they resolve the host's own
  `@dispatch/shared` and may import its values freely — unlike an installed
  plugin, whose server module must be self-contained. Under `pnpm dev`, a
  built-in whose `server/` output is missing loads its `src/` through tsx, so
  it hot-reloads with the server instead of running a stale build.

The Settings row shows a `built-in` chip; the toggle works as for any plugin.

**A few surfaces are Claude's alone** and follow the Claude plugin rather than
living in it: the Claude Code auto-memory editor (Memory → Claude, and
`/api/projects/:id/claude-memory`), the "Claude compaction window" setting, and
the boot warning about stale tool names in `.claude/settings*.json`. Each is
hidden or skipped while Claude is not registered. Server suites that need a
Claude turn use `claudeOnlyRegistry(query)` (`server/src/harness/registry.testkit.ts`),
which puts a scripted SDK `query` behind the plugin's real adapter — build the
plugins first, since `@dispatch/plugin-claude/harness` resolves to the built
`server/` output. `DISPATCH_FAKE_SDK=1` puts an echo behind the same adapter
(`createClaudeHarness` in the plugin's `main.ts`) for E2E and screenshots.

## Terminal backends

A chat's managed terminals — `mcp__dispatch-workspace__terminal` and the
Terminals panel — are local `powershell`/`bash` children of the server. A
plugin declaring `terminals` can supply somewhere else for them to run (a
container, a VM, another machine) without core knowing what that is. The first
one is `proxmox-terminal`, a per-chat Proxmox LXC. It is optional and lives
outside this repo, at `plugins/proxmox-terminal` in the
[`mdennis281/dispatch-plugins`](https://github.com/mdennis281/dispatch-plugins)
collection (see "Several plugins in one repository").

```ts
ctx.terminals.registerBackend({
  id: "proxmox",            // or qualified, "<your plugin id>/<name>" — see "Ids" below
  label: "Proxmox container",
  shell: "bash",            // the dialect of the sentinel probe core appends
  spawnTimeoutMs: 180_000,  // default 120 s, capped at 10 min
  fallback: "local",        // or "refuse" — see "Failure" below; default "local"
  async spawn({ chatId, projectId, name, cwd, repoPath, worktreePath, branch, signal }) {
    // provision, connect, then hand back stdio
    return handle;          // TerminalBackendHandle — see below
  },
  // Optional, per command — see "Run hooks" below.
  async beforeRun({ runId, chatId, terminal, command, cwd, background, signal }) {
    // bring the far side up to date; fail closed when it can't be
    return { notices: ["Synced 2 local changes."] };   // or { refuse: "why" }
  },
  async afterRun({ runId, chatId, terminal, command, exitCode, durationMs, outcome }) {
    return { notices: ["Brought back: pnpm-lock.yaml"] };
  },
  agentNote: ({ chatId }) => "How your local edits reach the container: …",
  onChatIdle: ({ chatId }) => { /* stop what you made, maybe */ },
  onChatDeleted: ({ chatId }) => { /* destroy what you made */ },
  dispose: () => { /* close connections */ },
});
```

**Ids.** A backend id is `[a-z0-9][a-z0-9-]{0,47}`, never `local`, and may be
**qualified** by your plugin's id: `<pluginId>/<name>`, e.g.
`remote-host/cvx-mac` (`TERMINAL_BACKEND_ID_PATTERN`). Prefer the qualified
form, above all for a plugin that registers one backend per thing the human
adds, like a machine they pair. A bare id is first come, first served across
every plugin, while a qualified one cannot collide. The host refuses a prefix
that is not the registering plugin's own id, so no plugin can claim another's
namespace and capture the chats pinned to it. Bare ids stay valid, and the
published `proxmox-terminal` registers `proxmox`. Ids are persisted on chats,
in app settings and in project.yaml, so keep one stable for the life of the
thing it names. Rename with `label` or `updateBackend`, never by changing the
id. A qualified id this instance has never seen registered fails closed (see
"The policy outlives the plugin" below). The location pickers list backends
under the plugin that registered them.

**The handle** is the stdio shape TerminalService already drives: `stdin`
(`write`, optional `end`/`on("error")`), `stdout` and `stderr` emitting
`data`, `kill()`, and `on("exit" | "error")`. A Node `ChildProcess` satisfies
it; so does an ssh2 exec channel with a few lines of adapter. The sentinel
protocol, scrollback, background runs and transcripts are core's and work
unchanged over any transport that carries a line each way. It has **no
`pid`**: core reads a pid as a local process it may tree-kill and walk the
process table under, so it strips one if present. `kill()` must take down the
remote shell *and what it started* — it is the only teardown core can ask for.

**Say why a shell ended.** Pass a `TerminalExitReason` as the second argument
of `exit`, `{ kind, detail? }`:

| `kind` | Use it when | A command in flight gets |
| --- | --- | --- |
| `exited` | the shell ended on its own (`exit`, a crash) | what it always got: `exit=n/a`, not an error |
| `transport-lost` | the connection carrying it dropped | an **error**: the outcome is unknown, so check before re-running |
| `killed` | you stopped it on purpose (idle stop, shutdown) | an **error**: it did not finish |

With no reason, core can only assume `exited`, so a dropped SSH session reads
as a command that finished without an exit code, and the agent believes it.
`detail` is one short line ("ssh: connection reset"). It shows up in the
result, as a `[dispatch]` line in the transcript, and as `TerminalInfo.exitReason`.
The Workspace view labels the exited row "connection lost" or "stopped"; the
Terminals panel lists only live shells, so it never shows an exited one.
`afterRun` gets the reason as `exitReason`. Only an object with a `kind`
counts: a real `ChildProcess` passes its signal name there, which core ignores.

An `error` from a backend's handle, or from its `stdin` (an EPIPE), is read as
`transport-lost` with the error's message. Transports usually error BEFORE
they exit, and the first event ends the shell. A reason that only arrives
after the shell has already ended can't change a result that has already
been returned, but it is still recorded for the panel and the respawn notice.

Whenever a name is reopened because its shell ended (whatever the reason), or
because it was closed or Dispatch restarted, the first result from the new shell
says it is a NEW shell whose cwd and environment started over. That applies to
local shells too.

**Stalls.** If your transport can tell "quiet" from "gone" (keepalives
unanswered, but not yet given up), have the handle emit `"stalled"` (optionally
with `{ detail }`) and later `"resumed"`, through the same `on` core already
listens on. While stalled:
- the running command's timeout is PAUSED, and resumes with whatever was left.
  The pause is capped at 10 min of stall per command, in total. After that the
  clock runs again even while stalled, so a backend that says `stalled` and
  never follows with `resumed` or `exit` cannot hang a call. Still emit `exit`
  (`transport-lost`) once you give up: that is what tells the agent the
  outcome is unknown;
- `TerminalInfo.location.state` is `stalled` (an amber chip and strip in the
  panel), with `stalledSince` and `stalled` (the detail);
- the transcript gets a `[dispatch]` line for each change.

A command that waited one out says so in its result's `notices`. `exit` while
stalled ends the stall. The events are not typed as `on` overloads on purpose:
an added overload would break handle adapters that cast an `"exit" | "error"`
function to `TerminalBackendHandle["on"]`, which is how backends are written.

**Spawn info.** Besides the chat, the terminal's `name` and the LOCAL `cwd` it
would have started in, `spawn` gets `repoPath` (the project's primary
checkout), `worktreePath` (the chat's own worktree, absent for a chat in the
primary checkout) and `branch` (what git has checked out at the chat's root
when the shell is asked for; absent on a detached HEAD). Both new fields are
read only for a shell headed to a backend.

**Run hooks.** `beforeRun` and `afterRun` are optional, and called only for
shells this backend is actually serving: never for a fallback, never for a
local shell, and never for a shell opened with no command.

- `beforeRun` is **awaited before the command is written**. Answer `{ refuse }`
  (or throw) and core never writes it: the run's result is an error carrying
  your text verbatim (the agent sees it as `NOT RUN: …`), and the terminal's
  transcript says `[dispatch] Not run: …`. Answer `{ notices }` to tell the
  agent something with the result. This is where a sync belongs, and where a
  sync that fails or a conflict refuses the run instead of letting it execute
  against a stale tree.
- `afterRun` is called once core stops waiting on a command it wrote, with
  `exitCode`, `durationMs` (from the write; `beforeRun` is not in it) and
  `outcome`: `finished`, `timed-out` or `shell-exited`. Only `finished` means
  the command is over. Core awaits it before returning the result, keeps the
  shell busy meanwhile, and appends its notices. A throw or overrun becomes a
  notice, never a failed run: the command already ran.
- **Pairing.** Every run has a `runId`, the same in its `beforeRun` and its
  `afterRun` and never reused. Key per-run state by it (a lock, the files a
  run touched): `chatId` + `terminal` is not unique, because a background
  run's `afterRun` arrives after other runs in the chat have come and gone.
- **Timing.** Neither hook's time is charged to the command's timeout. Both
  share their own bound, `runHookTimeoutMs` (default 10 min, capped at 1 h).
  A `beforeRun` that overruns refuses the command.
- **Cancellation.** Each hook gets a `signal`, aborted when core stops waiting:
  a session interrupt, the terminal closed or its shell gone (`beforeRun`
  only), or the bound. Core does not wait for a hook that ignores it, so a hook
  that keeps working may overlap the next run's. Serialize your own sync if
  that matters.
- **Fire-and-forget cases.** For a `background` command, `beforeRun` gates the
  start as usual, but `afterRun` comes when the command finally ends, long
  after its result went back. For a run cancelled mid-command, `afterRun` is
  still called with `outcome: "cancelled"`. In both cases its notices go only
  to the transcript.
- Notices also land in the transcript as `[<label>] …` lines, so the human
  watching the Terminals panel reads what the agent reads.

**Runs in flight everywhere (`runs` / `onRun`).** A backend's hooks only ever
tell it about its own shells. A lock that spans more than that — a checkout's
foreground lock, which a `pnpm install` in a LOCAL shell on the same worktree
must respect as much as a remote run — needs to see the rest:

```ts
ctx.terminals.runs?.({ chatId?, projectId?, backend? })   // → TerminalRunInFlight[], oldest first
const off = ctx.terminals.onRun?.((e) => { /* e.kind: "started" | "ended"; e.run; e.at */ });

// TerminalRunInFlight:
// { runId, chatId, projectId?, terminal, backend, cwd, command?, background, startedAt }
```

- **Every location.** This plugin's backends, other plugins', and `local`. A
  shell that fell back to this machine reports `backend: "local"`, because
  that is where its command runs.
- **In flight until it is over.** A run starts when the shell takes it, so
  before `beforeRun`. It ends when the shell has let go of it AND any
  `afterRun` has settled. That includes the detached `afterRun` of a
  backgrounded or cancelled command, which runs after the shell is free (and
  maybe busy with the next run): the run stays listed until its changes are
  back. A shell that dies or is closed ends its runs, except one whose
  `afterRun` is still syncing. A lock built on these events is never left held by
  a shell that is gone.
- **Same `runId` as the hooks**, so `runs()` and a backend's own `beforeRun` /
  `afterRun` pair up.
- **Counted, not shown.** `command` is present only for runs on this plugin's
  own backends. A run elsewhere is reported (a lock has to count it) without
  what it runs: `terminals` is consent to see the commands run on YOUR
  backends.
- `runs` is synchronous. A listener that throws is ignored. Deactivation
  unsubscribes for you.
- **Feature-detect.** Both members are optional; hosts before them lack them.
- **Testing.** `t.terminals.startRun({ chatId, backend?, … })` and
  `t.terminals.endRun(runId)` play core's side, with the same visibility rule.

Before these hooks existed a backend had to sniff stdin to tell the command
from core's probe (the probe line starts `__cm_ec=` for bash). That still
works, since core still sends the command and the probe as two separate writes,
but a sync done that way eats the command's own timeout and can only warn when
it fails. Don't parse the command out of the write either (see "Stdin" below):
`beforeRun` has it verbatim as `command`.

**Stdin.** A command never reads the shell's own input, on every shell, local
or yours. Core writes the command, its probe and the next command down the one
pipe the shell reads. Anything the command started used to inherit that pipe,
so a command that read stdin (`cat`, `ssh`, a credential prompt, bash's `read`)
ate the probe and the line after it. The run sat out its timeout and the next
command became that program's input. Nothing in Dispatch feeds a running
command, so the write cuts it off.

A foreground command reads EOF:

- bash/sh: `eval '<command>\n' </dev/null\n`, with each `'` in the command
  written `'\''`. `eval` is a builtin, so `cd` and `export` persist and `$?`
  is the command's. It parses one command at a time, as the shell reading
  lines did, so a `shopt` on one line still governs the next. A syntax error
  is exit 2 rather than the end of the shell;
- PowerShell: a line before the command points the process's stdin handle at
  `NUL` (a small `Add-Type` helper, compiled on the shell's first command), and
  the probe restores it. Where the helper can't compile (constrained language
  mode) or doesn't apply (PowerShell on Linux), the command runs as before.

A `background` command reads a stdin that never ends and never carries
anything. EOF is what tells a watcher like `esbuild --watch` to quit, so
giving it EOF killed the dev loop `background` exists for.

- bash/sh: `eval '<command>\n' ; ` with **no trailing newline** and no
  redirect. The probe, the next write, finishes that line. bash reads a whole
  line before running any of it, so the probe is out of the pipe before the
  command starts, and core writes nothing more while the run holds the shell.
  A transport that forwards each write in order needs nothing new;
- PowerShell: the line before the command points stdin at a pipe whose write
  end the shell holds and never writes to.

PowerShell's own `Read-Host` still reads from the shell's pipe; nothing a piped
shell offers can isolate it.

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

**Failure is loud, and the backend decides what happens next.** A spawn that
rejects or does not settle within `spawnTimeoutMs` fails. So does a pin to a
backend that is not registered because its plugin is uninstalled or switched
off; that pin is never quietly read as local. During boot, a chat pinned to an
installed plugin's backend waits for that plugin to activate before deciding it
is missing. What happens next is the backend's `fallback`:

- **`"local"`, the default, falls back.** A LOCAL shell comes up instead. The
  reason lands in three places: a `[dispatch]` line in the terminal, a `notice`
  in the chat, and the next tool result. The row's location badge turns amber,
  with the reason in its tooltip. This suits a Linux container standing in for
  a Linux-ish host, where the command still means the same thing.
- **`"refuse"` starts nothing.** Use it when the far side is a different OS or
  toolchain: a Mac's `xcodebuild`, or a POSIX `rm -rf`, must never reach
  PowerShell on the Dispatch host.
  - The run fails with `isError`. Its error names the backend and the reason,
    and says nothing ran. Every run queued behind the failed spawn fails the
    same way.
  - The terminal ends as exited, with `location.state: "failed"` and the reason
    in `location.error`. The same `[dispatch]` line and chat notice appear, at
    error level.
  - The Terminals panel keeps the shell listed, with a red "not started" chip,
    the reason, and a Retry button.
  - The next command on that name opens a fresh shell, which asks the backend
    again. The agent note tells the agent that commands here fail rather than
    run locally.

**The policy outlives the plugin.** A pin to a missing backend is the case
`fallback` matters most for, and in that case nothing is registered to ask. So
the registry remembers what each backend declared, along with its label and
owning plugin, in the instance's `terminal_backend` table (state.db migration
16). That row is written on every registration. Nothing deletes it: uninstalling
the plugin does not make its pinned chats run locally. Clear the pin, in the
Terminals panel or Settings → Chat defaults, to move them. An id this instance
has never seen registered has no remembered policy. A bare one reads as
`"local"`, which keeps today's behaviour for a project default naming a plugin
that never ran here. A **qualified** one reads as `"refuse"`. Qualified ids
postdate the policy, and the plugin that introduced them refuses, so guessing
`local` would run a command meant for that machine on this one. `data/` is per
instance, so the dev instance learns the policy the first time the plugin
activates there.

Qualified ids need the other instance to have "Ids from a newer version" (next
paragraph). One that predates it fails the whole settings file or project.yaml
on reading one. Run a build with it on both instances before a qualified id
reaches shared config.

**Ids from a newer version.** A backend registers with an id matching
`TERMINAL_BACKEND_ID_PATTERN`. Places that store an id (a chat's pin, app
settings' `terminalLocations`, project.yaml `defaults`) accept any id-shaped
string (`TERMINAL_BACKEND_REF_PATTERN`). That is because `config/` is shared by
the stable and dev instances, and either may be the newer. A strict read made an
older instance fail the whole file when it met an id format it had never seen:
every settings read threw, or the project manifest went invalid. Dropping the id
instead would have erased it on that instance's next save. So an id this version
cannot read (`isReadableTerminalBackendId`) is kept as written. It is listed as
unavailable, and a terminal sent there is **refused**, never run locally, because
its policy cannot be known. It is also flagged where a human looks: "needs a
newer Dispatch" in the location pickers, and a load error in Project config.

**Status.** A backend that lives on a machine that can be asleep, unplugged or
off the network says so, so nobody waits two minutes to find out:

```ts
ctx.terminals.setStatus("cvx-mac", {
  state: "offline",             // "online" | "offline" | "degraded"
  detail: "asleep",             // one short line for pickers and refusals
  lastSeenAt: Date.now() - 4 * 60_000,
});
```

- **`offline`.** The backend cannot be picked right now. An agent allowed to
  choose it still sees it in the terminal tool's `location` and in its prompt,
  marked unavailable with the reason. A pick of it is refused with that reason
  until it is back, and accepted after that, in a session that was already
  running. The pickers mark it too.
  It can still be pinned, since a pin is a preference. A shell asked of it fails
  at once under its `fallback` policy ("cvx-mac is offline (asleep), last seen
  4m ago"). `spawn` is never called. A spawn already waiting on it when it goes
  offline is cut short, its `signal` aborts, and a handle that lands late is
  killed. Shells already RUNNING there are left alone; their own transport
  reports trouble (`stalled`, `exit`).
- **`degraded`.** The backend is still offered, and its picker row and the
  agent's options carry the detail.
- **`online`, or no status ever reported.** This is how a backend behaved before
  statuses existed.

The host stamps `since` when the state changes. A report that changes only
`lastSeenAt` is kept but broadcasts nothing, so a heartbeat does not wake every
client. Status is runtime-only and resets when the backend registers again.

**Renaming, in place.** `ctx.terminals.updateBackend(id, { label?, agentNote? })`
changes a registered backend without re-registering it. Re-registering would end
every shell on it, and a renamed machine is the same machine. Shells on it keep
running, and their panel rows and later results take the new label. The new
label is remembered for when the plugin is off (see above). A key you pass
replaces that field, and `agentNote: undefined` removes the note. The id, shell,
spawn and `fallback` are fixed for the registration. The host never writes to
the object you registered: overrides live on the registry entry, so a
class-based backend keeps its prototype methods. A replaced `agentNote` is still
called with your backend as `this`.

**Removing one.** `await ctx.terminals.unregisterBackend(id)` does for one
backend what deactivation does for all of them: its shells end, its ports are
withdrawn, and `dispose()` runs. Pinned chats then fall back or are refused, per
`fallback`. The id is free to register again. Like `publishPort`, all three
calls throw for a backend this plugin did not register. After
`unregisterBackend`, the plugin's own teardown no longer touches that id, so a
backend another plugin registers there later survives the first plugin
switching off.

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
made. `onChatIdle` is fire-and-forget, contained, and bounded at 60 s.
`onChatDeleted` is awaited on the same bound, and a failure is persisted and
retried until it succeeds — see "Cleanup lifecycle".

**Ports.** A remote listener is useless to a browser on the Dispatch host until
the backend forwards it. The backend owns the transport, so it does the
forwarding and then announces it:

```ts
const withdraw = ctx.terminals.publishPort("proxmox", {
  chatId, remotePort: 5173, url: "http://127.0.0.1:53211", label: "vite",
});
```

Every forward has two URLs. `url` is the forward on the Dispatch host.
`remoteUrl` is the same listener as a browser on the backend's own machine
reaches it. That browser includes the MCP servers placed there (see "Hosting
processes"); for them the forward is a port on the wrong machine.

- If you omit `remoteUrl`, the host fills it in: `url` with the host swapped
  for `localhost` and the port for `remotePort`, keeping the scheme and path.
  `http://127.0.0.1:53211` becomes `http://localhost:5173`.
- Pass it yourself when that guess is wrong, for example a listener bound to
  one interface, or a dev server that only answers to one hostname.

Published ports appear in the terminal tool's results ("Forwarded ports", as
`here: <url> · there: <remoteUrl>`), in `terminal_output`, and in the
Terminals panel. A plugin may publish only for
backends it registered. Publishing the same chat + remote port again replaces
the entry, and a stale `withdraw` does not remove its replacement.

**Deactivation** unregisters every backend the plugin registered. Its shells
end with a `[dispatch]` line saying why, its ports are withdrawn, and
`dispose()` is called. The next command on one of those names re-resolves.
The pin still names the gone backend, so it comes up local, with a warning, or
under `fallback: "refuse"` it fails.

**What does not change with no backend plugin in use** (none registered, and
no chat or project naming one): TerminalService takes its original synchronous
spawn path, `TerminalInfo` has no `location`, no `terminal-backends` event is
ever published, no prompt section is written, and the panel shows no picker or
badge.

`createTestContext` records `terminalBackends`, `terminalPorts`,
`terminalStatus` (the latest `setStatus` per id) and `terminalUpdates` (the
merged `updateBackend` patches; the registered object is left as is), and
`t.terminals.spawn(id, { chatId })` / `chatIdle` / `chatDeleted` play the
host's side, so a backend can be unit-tested with no server.
`t.terminals.beforeRun(id, { chatId, command })` reports what core would do
(`{ ran, refusal?, notices }`, a throw counted as a refusal), and
`t.terminals.afterRun(id, { chatId, command, exitCode? })` returns the notices.

### Hosting processes (MCP servers on the machine)

A backend may also host long-lived **stdio processes**: today, the MCP
servers a chat's agent talks to. Implement the optional
`spawnProcess(info): Promise<TerminalProcessHandle>`. A backend without it is
never asked.

**Which servers go where.** Core decides per session, and the backend never
has to:

| Setting | Values | Default |
| --- | --- | --- |
| `browser.location` (project.yaml) | `terminal` · `local` · a backend id | `terminal` |
| `mcpServers.<name>.location` | same | `local` |
| `Chat.mcpLocations[<name>]` (`PUT /api/chats/:id`) | same; beats both above | — |

- `terminal` means the chat's default terminal location (its pin, else the
  project's `defaults.terminalBackend`). So a chat working on a Mac drives a
  browser ON the Mac, where the dev server it started answers on `localhost`.
- A server that **follows** the terminal to a backend without `spawnProcess`
  stays local, quietly.
- A server that **names** a backend is never run locally instead. Every call
  fails with the backend's reason until it can run there: a browser on the
  wrong machine sees the wrong `localhost`.
- Only stdio servers are placed. A change applies to the chat's next session.

**What you are told** (`TerminalProcessSpawnInfo`):
- `chatId`, `projectId`, `purpose: "mcp"`, `name` (the server's name), `cwd` /
  `worktreePath` (LOCAL; map them as for a shell) and `signal`.
- **`bundled`**, for the two browser servers Dispatch ships: `{ server,
  package, version, bin, args, env? }`. Run that package at that **exact**
  version with your own runtime; the tool list the agent sees was taken from
  it.
  - The `args` are path-free. Choose the output directory, profile and
    downloads yourself (per chat), because the Dispatch host's paths mean
    nothing on your side.
- **Otherwise `command` / `args` / `env`**, a configured server, to run as
  written.

**The handle** is a `TerminalBackendHandle` minus `cwd`: newline-delimited
JSON-RPC on `stdin`/`stdout`, `kill()`, `on("exit" | "error")`. A
`ChildProcess` satisfies it.

**The reconnect contract.** Core's relay enforces the half the agent's runtime
sees. Yours is three events:

| You emit | When | Core does |
| --- | --- | --- |
| `stalled` (`{ detail? }`) | the link dropped; the process is believed alive; you are re-attaching | Answers every call in flight with a JSON-RPC error that names the machine. Fails new calls AT ONCE, never queuing them. Drops any half line it held. |
| `resumed` | re-attached to the **same** process, still initialized | Carries on. Sends NO second `initialize`. Drops late replies to the calls it already failed. |
| `exit(code, reason?)` | the process is gone, or you gave up (`{ kind: "transport-lost" }`) | Fails what is waiting. Starts a NEW one on the next call, replaying the client's `initialize`, and tells the agent in that call's result that the old pages are gone. |

So keep the process running across a dropped link, and resume stdout at a line
boundary. Why this matters (measured 2026-11-06): when a stdio MCP server exits,
- Claude Code respawns it, losing every open page silently;
- Codex never respawns it, so its tools are dead for the rest of the thread.

The local half is the same `lazy-browser-shim.mjs` that fronts the local
browsers, in relay mode:
- It answers `initialize` and `tools/list` from a cached manifest, so nothing
  starts on your side until a tool is CALLED.
- It never exits when the relay drops.

**The frames are yours to rewrite.** You own the handle, so you see every line
both ways. That is where a backend maps what crosses machines:
- `roots/list` answers, so local paths become your paths;
- file paths in results, fetched back or inlined;
- files an upload call names, which must be on your side first.

**Lifetime.**
- One process per chat + `name`.
- A session ending does not end it: with no session attached for 60 s, core
  closes its stdin, then calls `kill()` 5 s later. A session restart inside
  that window keeps the browser.
- Deleting the chat, or unregistering the backend, kills it at once.
- The spawn is bounded by your `spawnTimeoutMs`, like a shell. A handle that
  arrives late is killed.

**Testing.** `t.terminals.spawnProcess(id, { chatId, … })` starts one through
your backend and returns core's side of the line protocol:
- `request(method, params)` and `notify`;
- `fromProcess` (what it sent the client);
- `garbage` (non-JSON stdout);
- `events` / `next("stalled" | "resumed" | "exit")`.

Assert that a re-attach emits `stalled` → `resumed` and answers the next
request with no second `initialize`.

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
  readonly instance?: PluginInstance;   // the server half's ctx.instance; read once by the loader
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
  settings?: {                  // this plugin's own settings — see "Plugin settings"
    get<T = Record<string, unknown>>(): T;                                   // synchronous; kept current by plugin-settings
    set(patch: Record<string, unknown>): Promise<Record<string, unknown>>;  // PATCH …/settings; rejects with the schema's reasons
    onChange(fn: (next: Record<string, unknown>) => void): () => void;
  };
}
```

`host.settings` replaces the undocumented `host.api.fetch("settings", { method:
"PUT" })`. That path resolves to the host's own settings route, so it worked by
accident, and it replaced the whole blob.

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

**Scopes:** `chats:read`, `chats:write`, `chats:create`, `attention:read`, `attention:answer`,
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
`chat_reply`, `chat_state`, `chat_summarize`, `chat_stop`, `chat_archive`, `persona_list`, `events_poll`, `chat_tree`, `attention_list`, `attention_dismiss`, `attention_answer`, `wait_for_chat`, `project_info`, `project_list`, the
memory tools, the issue tools, `mode_list`, `config_list` and `config_read` are
external; `wait`, `context_usage`, `compact_context`, the workspace tools, the
PR tools, the confirm tools, the secrets tools, `chat_set_mode`,
`chat_set_persona`, `mode_read`, the `mcp_*` editors and every
`*_write`/`*_delete` are not. `spawn_chat` binds only for a token holding
`chats:create`: there is no parent session to put a consent card in, so the
owner's grant of that scope IS the consent. It runs through
`ChannelChatService` (not `broker.spawnChat`): the chat runs in the project's
default mode, a named mode that resolves to `bypassPermissions` is refused, the
brief lands as a `channel` row in the token's name, and no completion notice is
promised. `chat_summarize` runs a model on the summarized chat's OWN provider
and account (`ChatSummaryService`), cached until a new row lands, one call in
flight per chat, and rate-limited to 30 model calls per caller per hour (cache
hits are free). `chat_stop` binds wherever `chat_send` does (interrupting a turn
is already in reach via its "interrupt" delivery): it
interrupts the chat's running turn, and with `archive: true` also releases its
session and archives it — allowed only for a chat that token started, because
an archived chat leaves the sidebar and the SPA has no control to bring it back.
`chat_archive { chatId, archived }` (`mcp/chat-archive-tool.ts`, beside
`chat_stop`) flips ONLY the flag — no interrupt, no release
(`ChannelChatService.setArchived`). Archiving keeps that same own-chats rule;
restoring is allowed for any visible chat, since putting a chat back in front of
the owner is not the harm the rule guards. `chat_state` reports `archived`, and
its times (like `chat_find`'s) are zone-labelled local time (`formatLocalTime`,
e.g. `2026-10-29 14:03 CDT`) rather than unlabelled local in one and UTC ISO in
the other. `chat_read { fullText: true }` prints user and assistant messages
whole, where every row used to be cut to a 600-character preview even under
`full: true`; tool payloads stay clipped.
`events_poll` reads the integration event feed (`EventFeedService`, below) and
binds only for a token holding a read scope some event type falls under.
`chat_tree` (`services/chat-tree.ts`) walks the sidebar's own two parent edges —
`parentChatId` (and its legacy purpose sentence) and `reviewOf` → the PR's author
chat — within one project, so its nodes never leave the asked chat's project;
`chat_state` carries the direct `parent` / `children` from the same code —
live children only (newest 20, then a count), archived ones as
`archivedChildren`, with the project listing memoized for 5s because
`chat_state` is the read connectors poll.
`attention_list` (binding and tools in `mcp/attention-tools.ts`) binds for
`attention:read`; it and `GET attention` return the same enriched entries
(`buildAttentionEntries`): chat title, `createdAtLocal`, `dismissible`, and for
a pending question its `questions[]` (text, header, multiSelect, option labels)
read off the broker's permission snapshot. `attention_dismiss` (and
`POST attention/dismiss`) needs `attention:answer`: named ids go whatever their
kind, a sweep defaults to idle/done/review (`AttentionQueue.dismiss`), anything
outside the allowlist is reported `missing`, and each removal is broadcast as
`attention-resolve`. Dismissing never answers or denies. `attention_answer`
(`attention:answer`) and `POST attention/:id/answer` share `answerAttentionItem`:
a question goes through `broker.answerQuestion` / `declineQuestion` exactly as a
click would, an empty answer is a 400, and a PERMISSION card is refused by name —
a bearer token approving tool calls would be a way around the prompt. Memory and issue tools bind
only when the token names exactly one project. A category is offered only when
the token holds `tools:<category>`; the mount is authenticated by the gate (it
does NOT ride the per-chat bridge's gate exemption), and the external context
enforces `projectIds` itself, reporting anything outside them as unknown.

**REST**, under `/api/integration/`, a curated surface rather than scope checks
sprinkled over the SPA's routes:

| route | scope |
|---|---|
| `GET chats?projectId&status&blockedOnHuman&unmerged&since&before&q&limit&archived&cursor` (each chat's `prStatus[]`: state, CI, review — `shared/chat-pr-status.ts`) (→ `nextCursor` when the scan budget stops it; an unknown `status`, a bad boolean or `before ≤ since` is a 400 naming the valid values) | `chats:read` |
| `GET chats/:id` (digest) · `GET chats/:id/messages?kinds&before&after&limit&fullText` | `chats:read` |
| `POST chats/:id/messages { text, delivery?, sender? }` | `chats:write` |
| `POST chats { projectId, text, title?, modeId?, provider?, model?, effort? }` → 201 | `chats:create` |
| `GET chats/:id/summary?focus` (429 + `Retry-After` past the limit) | `chats:read` |
| `POST chats/:id/stop { archive? }` (archive: own chats only, else 403) | `chats:write` |
| `POST chats/:id/archive { archived }` — flag only, no interrupt (archive: own chats only, else 403; restore: any) | `chats:write` |
| `GET attention` · `POST attention/:id/answer { optionId \| answer \| answers \| decline }` | `attention:read` / `attention:answer` |
| `POST attention/dismiss { ids? \| kinds?, chatId?, projectId? }` → `{ dismissed, missing }` | `attention:answer` |
| `GET projects` | `projects:read` |
| `GET projects/:id/personas` → `{ personas: [{ id, name, scope }] }` | `projects:read` |
| `GET events?cursor&since&limit&types&projectId&chatId` → `{ events, nextCursor, hasMore, gap? }` | per event type (below) |
| `GET openapi.json` | any |

Token `projectIds` filter every route (a chat outside them is a 404).

**The event feed** (`services/event-feed.ts`, contract in
`shared/integration-events.ts`) is the pull-side twin of the webhooks, for a
connector that can only make tool calls. A bus consumer derives six facts and
appends each to `integration_event` in state.db: `chat.settled` (the shared
settle rule in `chat-settle.ts`, not the raw `idle` edge), `pr.opened` /
`pr.merged` / `pr.closed` (state TRANSITIONS, seeded from the PR registry on
start so a boot never re-announces open PRs), and `attention.raised` /
`attention.resolved` (deduped by item id). `id` is an AUTOINCREMENT `seq`, so a
cursor survives restarts and is never reused after a prune; 7 days / 10k rows
are kept, and a cursor older than the oldest row gets `gap: true`. No cursor →
the newest page. Each type needs its subject's read scope (`chat.*` →
`chats:read`, `pr.*` → `projects:read`, `attention.*` → `attention:read`).
Every event carries `ts` (epoch ms) and `tsLocal` (`2026-10-29 14:03:12 CDT`,
the server's zone, labelled).

### Attribution

A row sent through the integration surface or `ctx.chats.send` carries
`origin: "channel"` and `channel: { name, askId?, trust? }` (`ChannelSender`, beside
the peer sender in `shared/src/messages.ts`; the broker stamps it instead of
`peer`). `UserRow` renders it as a `ChannelCard` with the voice
`<NAME> → <provider>` in info-blue — a third author that borrows neither the
peer's violet nor Dispatch's amber — never the speech bubble, including when
memory surfacing hands the row `parts`; the model receives a `channelReminder`
in the style of the peer one: this came from an external integration, the
human in the app may not have seen it. Resume snapshots carry `channel` the way
they carry `peer`.

`trust: "owner"` changes both halves: the reminder says the owner authorized
this integration to speak for them (in settings, not in the message) and to
treat its instructions as theirs, and the card's subtitle reads "Relayed for
you". It is the sending TOKEN's level (or its OAuth grant's), stamped by the
server at send time — never anything the caller wrote — and a plugin's
`ctx.chats.send` is always `external`.

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
