# The server API — `activate(ctx)`

Types: `PluginContext`, `PluginModule`, `PluginRouter` in `@dispatch/plugin-sdk`
(re-exported from `packages/shared/src/plugin-api.ts`). The host implements them in
`packages/server/src/plugins/context.ts`; every member is a thin adapter over a
service the host already has.

## The module

```ts
import { definePlugin } from "@dispatch/plugin-sdk";

export default definePlugin({
  async activate(ctx) { /* register things */ },
  async deactivate() { /* optional; the host tears down what it owns regardless */ },
  // Optional cleanup lifecycle — for anything you made OUTSIDE the process.
  async onShutdown({ reason, deadline, signal }) { /* restart | stop | disable | uninstall */ },
  async reconcile({ chats, deadline, signal }) { /* chats that still exist; the rest were deleted */ },
});
```

The host accepts the `activate` function from the module namespace, from `default`, or
from an export named `plugin`. `definePlugin` is an identity function that types `ctx`
for you — a plain `export async function activate(ctx)` works just as well
(`examples/plugins/hello-server` is dependency-free JavaScript for exactly that reason).

**Runtime imports.** `server/index.js` is imported with `import(file://…)` from
`<configDir>/plugins/<id>/`. There is no `node_modules` there (`dispatch plugin add` does not
copy one), so the module may import Node builtins and nothing else. Write TypeScript
and build it with `dispatchServerBuild` from `@dispatch/plugin-sdk/vite`
(`examples/plugins/event-forwarder`), which inlines everything but `node:*`.

## Lifecycle, as it affects you

1. **Discovery** happens in the server's `start()`; your module is not touched.
2. **Activation** runs from `warm()`, AFTER the port is open, in id order, each
   `activate` awaited with a **30 s budget**. A throw or timeout marks the plugin
   `error`, files the message through the crash log, and moves on. Boot never waits on
   or fails because of a plugin. Until you are active, your route prefix answers 503.
3. Everything you register — bus listeners, routes, settings listeners, processes — is
   **owned** by the host under your id.
4. **Deactivation** (the toggle in Settings, uninstall, or server shutdown, reverse
   id order): `onShutdown({ reason })` if exported, then `deactivate()` if exported
   (10 s budget), then the host drops your listeners,
   empties your route table (404 from then on), stops your processes, and pulls your
   client bundle. Flipping the toggle back on needs a restart; the pane says so.

**Cleanup lifecycle** (docs/plugins.md → "Cleanup lifecycle"), for a plugin that makes
things outside the process — containers, remote sessions, tunnels:
- `onShutdown({ reason, deadline, signal })` — `restart | stop | disable | uninstall`.
  All plugins run in parallel on ONE shared 5 s budget; past it `signal` aborts and you
  are skipped. A Restart waits on this: INITIATE slow remote work, don't wait for it.
  Only `uninstall` should destroy everything; `disable` keeps it. Never runs on a crash.
- `reconcile({ chats, deadline, signal })` — after every successful activation,
  detached, 120 s budget. `chats` is every chat that exists; settle what you made
  against it. This, not `onShutdown`, is the guarantee.
- Both idempotent and bounded. Keep your own record of what you made (`ctx.kv`).

Do your slow work after `activate` returns (start it, don't await it), and keep
`activate` to registrations. A plugin that needs to talk to its own managed process
can: `autostart` processes are started BEFORE `activate` runs.

## `ctx`, member by member

Always present:

```ts
ctx.id        // the plugin id
ctx.dir       // absolute path of the plugin directory
ctx.version   // from the manifest
ctx.log.info(m) / warn(m) / error(m, err?)   // error() also files to the crash log
ctx.instance  // { id, role: "stable"|"dev"|"other", dataDirFingerprint, previousId?, reminted? } — see below
ctx.settings.get<T>()          // AppSettings.plugins[id].settings, or {}; synchronous (cached)
ctx.settings.onChange(fn)      // fires on every change — pane, your own set, the other instance (~2 s); returns unsubscribe
await ctx.settings.set(patch)  // merge patch: keys replace wholesale, null removes; schema-checked on the keys it changes (throws, stores nothing)
ctx.projects.list() / get(id)  // { id, name, repoPath, worktreeRoot?, defaultBranch? }
ctx.emit(payload, chatId?)     // publishes { type: "plugin-event", plugin: id, chatId?, payload } to every client
```

**Work you leave outside Dispatch is namespaced by `ctx.instance.id`.** That covers
sessions on a remote machine, files in a shared directory, and anything else an orphan
sweep might reap. Stable and dev share your settings and secrets, so nothing else tells
them apart.
- The id is re-minted when the data dir turns out to be a copy, so dev seeded from
  stable's data never answers to stable's id.
- The old id comes back as `previousId`, with `reminted.reason` set to `copied`, `moved`
  or `hostname`. Offer its leftovers to the owner, but **never adopt them
  automatically**: for a `copied` dir, `previousId` is a live instance.
- `role` is a label, not a namespace.
- If the member is absent (an older host, or an unreadable data dir), don't clean up
  at all. Never fall back to a guessed namespace.

docs/plugins.md → "Instance identity" has the full rules.

Gated by a capability (absent otherwise — optional on the type):

```ts
// events
ctx.bus.on("chat-status", (evt) => …)   // typed on WsServerEvent; returns unsubscribe (the host also records it)
ctx.bus.subscribe((evt) => …)           // every event

// routes — paths relative to /api/plugins/<id>/, find-my-way syntax (:param); call during activate
ctx.routes((r) => {
  r.get("/hello", async (req, reply) => ({ ok: true }));
  r.get("/chats/:chatId", async (req) => req.params.chatId);
  r.post("/echo", async (req) => req.body);
});

// kv — a per-plugin key/value table in the instance's state.db (JSON values; set(undefined) deletes)
await ctx.kv.get<T>(key); await ctx.kv.set(key, value); await ctx.kv.delete(key); await ctx.kv.list(prefix?)

// secrets — only names listed under secrets: (FOO_* = any name starting FOO_); unlisted → undefined + a warning in the log
await ctx.secrets.get("NAME"); await ctx.secrets.list()   // list() = the covered names that have a value, sorted
// secrets:write (declare secrets too) — GLOBAL store, encrypted, shared by both instances, survives updates.
// Throws for an uncovered/invalid name or an empty/>64 KiB value; resolves after consumers of ${secret:NAME} refreshed.
await ctx.secrets.set(`MY_PLUGIN_KEY_${slug}`, pem); await ctx.secrets.delete(`MY_PLUGIN_KEY_${slug}`)  // delete → boolean

// chats:read
await ctx.chats.list({ projectId?, status?, since?, archived?, limit? })   // PluginChatSummary[]
await ctx.chats.find({ query?, project?, status?, kinds?, since?, before?, limit?, hitsPerChat? }) // summaries with hits[]
await ctx.chats.read(chatId, "digest" | "messages" | "grep", { query?, kinds?, limit?, beforeId?, afterId?, full? }) // rendered text
await ctx.chats.state(chatId)   // { status, dormant, blockedOnHuman, prs, heldMessages, contextPercent?, … } | null
await ctx.attention.list()      // AttentionItem[]

// chats:write
await ctx.chats.send(chatId, text, { delivery?: "queue" | "interrupt", sender? })   // → { ok, refusal?, held?, woke? }
await ctx.chats.ask(chatId, question, { timeoutSeconds? (600), sender? })           // → { ok, askId, answered, answer?, reason? }
await ctx.chats.reply(askId, answer)                                                 // answer an ask AS the asked chat
await ctx.attention.answer(itemId, { optionId? | answer? | answers? } | { decline: true })  // question items only

// memory
await ctx.memory.recall(projectId, query?)   // the index, plus matching bodies
await ctx.memory.remember(projectId, { name, description, type, body })
await ctx.memory.forget(projectId, name)

// process (see contributions.md)
await ctx.processes.start(id) / stop(id) / list()   // [{ id, status, ports?, url? }]

// oauth (see external-api.md)
await ctx.oauth.connectUrl(name) / token(name) / disconnect(name)

// providers — an agent runtime chats can run on (docs/plugins.md → "Providers").
// `harness` implements Harness from @dispatch/shared; descriptor.id === harness.kind.
// Throws if the id is taken; the toggle unregisters it and calls harness.dispose().
ctx.providers.register(harness, descriptor)

// terminals — somewhere else for chats' managed shells to run (docs/plugins.md →
// "Terminal backends"). spawn is async and resolves to stdio (stdin/stdout/stderr,
// kill, on exit|error) with NO pid; reject or overrun spawnTimeoutMs and core brings
// up a LOCAL shell and says why — or, with fallback: "refuse", starts nothing and fails
// the run. Throws on "local" or a taken id; the toggle ends the backend's shells,
// withdraws its ports and calls dispose().
ctx.terminals.registerBackend({
  // "<your plugin id>/<name>" (qualified: can't collide, any other prefix throws) or a bare
  // "[a-z0-9][a-z0-9-]{0,47}". Persisted on chats/config — never change it; rename via label.
  id: "box", label: "My box", shell: "bash",
  spawn: async ({ chatId, projectId, name, cwd, repoPath, worktreePath, branch, signal }) => handle,
  // Optional, per command, only on shells you serve. Awaited BEFORE the write and NOT
  // charged to the command's timeout (own bound: runHookTimeoutMs, default 10 min).
  // runId: one per run, the same in its beforeRun and afterRun — key per-run state by it.
  beforeRun: async ({ runId, chatId, terminal, command, cwd, background, signal }) =>
    ({ notices: ["Synced 2 changes."] }),       // or { refuse: "why" } / throw → never written
  afterRun: async ({ runId, command, exitCode, durationMs, outcome }) =>
    ({ notices: ["Brought back: x"] }),         // a throw is a notice, not a failed run
  agentNote: ({ chatId }) => "what the agent can't infer (how code gets there, what isn't shared)",
  onChatIdle: ({ chatId }) => {},     // session retired by the idle sweep — shells are NOT killed by core
  onChatDeleted: ({ chatId }) => {},  // shells already gone — destroy what you made. AWAITED (60 s):
                                      // reject/timeout = persisted + retried until it resolves
})
const withdraw = ctx.terminals.publishPort("box", { chatId, remotePort: 5173, url: "http://127.0.0.1:53211" })
ctx.terminals.ports(chatId)
// Your OWN backends only (throws otherwise):
ctx.terminals.setStatus("box", { state: "offline", detail: "asleep", lastSeenAt })  // online|offline|degraded
ctx.terminals.updateBackend("box", { label: "Garage Mac" })  // in place: shells keep running
await ctx.terminals.unregisterBackend("box")                 // one backend, as deactivation does
```

Gotchas for a terminal backend:
- One backend per thing the human adds (a paired machine)? Qualify the id, `my-plugin/<slug>`.
  A qualified id this instance never saw registered is refused rather than run locally.
- Never put a `pid` on the handle — core strips it, because a remote pid names some
  unrelated local process. `kill()` has to end the remote shell AND its children.
- The selection is read when a shell OPENS (chat pin → project `defaults.terminalBackend`
  → local). Lifecycle hooks fan out to EVERY backend, so keep your own chatId → resource map.
- Tell the agent what only you know in `agentNote`. Core already says: run builds, tests
  and servers through the terminal tool, keep git local, open the forwarded URLs.
- Sync in `beforeRun`, not by sniffing stdin for the command vs core's probe: a refusal
  there means the command never runs (fail closed), and the sync's time is not the
  command's. Its signal aborts on a session interrupt or a closed terminal, and core
  does not wait after that — serialize your own sync if runs could overlap.
- The command write is WRAPPED so the command can't read the shell's pipe: bash gets
  `eval '<command>\n' </dev/null` (`'` → `'\''`), PowerShell a stdin-detach line before it.
  A `background` command gets a stdin that never ends instead (bash: `eval '…\n' ; ` with
  NO trailing newline — the probe finishes the line). Take the command from `beforeRun`'s
  `command`, never from the write. The probe is still a separate write (`__cm_ec=` for bash).
- Emit `exit` WITH a reason: `handle.emit("exit", null, { kind: "transport-lost", detail })`
  for a dropped connection (the in-flight command becomes an "outcome unknown" error),
  `kind: "killed"` for an idle stop. With no reason a lost connection reads as success.
- If your transport can tell "quiet" from "gone", emit `"stalled"` (`{ detail }`) and
  `"resumed"` on the handle: core pauses the command's timeout and shows the shell stalled.
- Report `setStatus("offline")` as soon as you know the far side is unreachable: core then
  fails a new shell at once (no 120 s spawn wait), cuts short a spawn already waiting,
  and refuses an agent's `location` pick of it with your detail. Running shells are untouched.
  Report `online` again when it is back: sessions already running accept picks of it from then on.
- Rename with `updateBackend`, never unregister + register: that ends every shell on it.
- Test with `createTestContext`: `t.terminals.spawn("box", { chatId })`, `t.terminals.chatIdle(...)`,
  `t.terminals.chatDeleted(...)`, `t.terminals.beforeRun("box", { chatId, command })`
  (→ `{ ran, refusal?, notices }`), `t.terminals.afterRun(...)`, `t.terminalPorts`,
  `t.terminalStatus` and `t.terminalUpdates`.

Working examples of `providers`: the built-in Claude, Codex and goose plugins,
`packages/plugins/{claude,codex,goose}` (`src/main.ts` is the whole entry;
`src/descriptor.ts` is the descriptor). No provider is compiled into the host
and there is no fallback: a chat whose provider is off shows "provider
unavailable" and does not run. A provider that wants Dispatch's own MCP tools
in-process declares `capabilities.managerTransport: "in-process"` and gets
plain `McpServer`s in `spec.managerMcp.servers` (Claude wraps them for the
Agent SDK in `manager-servers.ts`); any other transport gets an HTTP grant.

### Using another plugin: `ctx.dependencies` / `ctx.provides`

Full contract: `docs/plugins.md` → "Dependencies". The short version:

```ts
// provider, during activate — only then; the exports are sealed when activate resolves
ctx.provides!.serve("machines", 1, (caller) => makeApi(caller)); // once per consumer, synchronous
// consumer
const m = ctx.dependencies?.get<MachinesV1>("remote-host", "machines", 1); // undefined unless usable NOW
ctx.dependencies?.onLost("remote-host", () => …); // an OPTIONAL dependency is going down
```

- Each exists only when the manifest declares the key (`dependencies:` / `provides:`).
  `get` THROWS for an export `uses` does not list, `serve` for one `provides` does not
  declare — the Inspect report warns about both from the scan.
- **Call `get` where you use it, not once in `activate`.** It is checked live: the
  provider may be off, blocked, failed or going down, and the API object stops working
  when the link closes (its methods throw `PluginRevokedError`; everything else that
  crossed goes inert). Match errors with the SDK's `isPluginRevokedError` /
  `isPluginCallError`, never `instanceof`.
- `caller` carries the consumer's GRANTED `id`, `version`, `capabilities` and a
  `signal` that aborts when either side goes down — end what you made for it then.
- A required dependency that is not usable means you never activate (`blocked`, with
  the reason on your row). An optional one means you start without it and get `onLost`
  when it goes; your Proxmox lifecycle (or whatever) keeps running.
- **Breaking your export is a new major.** A provider update that drops a major a
  consumer uses is refused until the owner types the plugin's id; serve `[1, 2]` while
  consumers move across.
- Test with `createTestContext({ dependencies: { "remote-host": { machines: { 1: fake } } } })`
  (`t.revoke` / `t.lose` play it going away) or `{ provides: { machines: [1] } }`
  (`t.served`, `t.callAs`); `createTestHost([...])` runs a provider and consumer together.

### Routes

- Routes are a **table** the host consults per request behind one wildcard
  `/api/plugins/:id/*` — Fastify cannot add or remove routes on a listening instance,
  and plugins activate after listen. So `ctx.routes` works at any time during
  `activate`, and deactivate empties the table.
- **Auth-gated** like everything under `/api/`: the SPA reaches them through
  `host.api.fetch` (authenticated); `curl` needs a session bearer, or auth off. An
  integration token does NOT reach them — the gate fences `dsp_` tokens to
  `/api/integration/*` and `/api/mcp/integration/*`.
- Handlers get Fastify's request and reply. The SDK types them as `PluginRequest` /
  `PluginReply` — `params`, `query`, `headers`, `body`, `url`, `method`; `reply.code()`,
  `.header()`, `.type()`, `.send()` — the subset a handler reads, so the fake context can
  hand you the same shape. Cast to Fastify's types if you need more.
- Return a value to send JSON; or use `reply`.

### Sends and attribution

`ctx.chats.send` / `ask` go through the host's `ChatMessenger`, never the broker
directly: the broker dismisses every pending question card on a send, and a plugin's
message is not a human's dismissal. The row lands with `origin: "channel"` and
`channel: { name: <sender ?? plugin id>, askId? }`; the transcript renders it as a card
voiced `<NAME> → <provider>`, never the speech bubble, and the model gets a reminder
that the message came from an integration. `delivery: "queue"` (default) waits for the
target's current turn; `"interrupt"` injects into it; neither bypasses an open card
(`held: true` tells you it was parked). `woke: true` means the target had no subprocess
and one was started.

`ask` resolves when the asked chat calls `chat_reply` (or on timeout: `answered: false,
reason: "timeout"`). `reply(askId, answer)` lets a plugin answer a pending ask on the
asked chat's behalf.

### `plugin-event`

`ctx.emit(payload, chatId?)` publishes one wire event, `{ type: "plugin-event", plugin,
chatId?, payload }`, to every connected client. Your client half receives it through
`host.events.onPlugin(fn)`, already filtered to your id. The payload is your own
contract with yourself; keep it small (it crosses the WebSocket for every tab).

## Patterns

- **State that must survive a restart** goes in `ctx.kv`, not a file in `ctx.dir`
  (the directory may be a junction into a checkout, and `dispatch plugin add --force`
  replaces it wholesale).
- **Counters touched from bus events**: keep them in memory and write through; two
  events in one tick would otherwise both read the old value (see hello-server).
- **Configuration the owner edits** → `settings.schema.json`; **credentials** →
  `secrets:` + the secret card; **tokens from a provider** → `oauth.clients` and
  `ctx.oauth.token()` (the host refreshes them); **credentials the plugin MINTS**
  (a keypair per paired machine) → `secrets:write` + a `PREFIX_*` entry. Not kv:
  kv is per-instance plaintext; the secret store is encrypted and shared by both.
  Not a file in `ctx.dir`: an update replaces the directory.
- **Calling out**: use the global `fetch`. For durable delivery with retries, create a
  host webhook subscription (external-api.md) rather than re-implementing a retry loop
  (`examples/plugins/event-forwarder` shows the plugin side and says why it stops there).
