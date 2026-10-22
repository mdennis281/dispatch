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
4. **Deactivation** (the toggle in Settings, or server shutdown, reverse id order):
   `deactivate()` if exported (10 s budget), then the host drops your listeners,
   empties your route table (404 from then on), stops your processes, and pulls your
   client bundle. Flipping the toggle back on needs a restart; the pane says so.

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
ctx.settings.get<T>()          // AppSettings.plugins[id].settings, or {}; synchronous (cached)
ctx.settings.onChange(fn)      // fires on every PUT /api/plugins/:id/settings; returns unsubscribe
ctx.projects.list() / get(id)  // { id, name, repoPath, worktreeRoot?, defaultBranch? }
ctx.emit(payload, chatId?)     // publishes { type: "plugin-event", plugin: id, chatId?, payload } to every client
```

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

// secrets — only names listed under secrets:; unlisted → undefined + a warning in the log
await ctx.secrets.get("NAME"); await ctx.secrets.list()   // list() = the listed names that have a value

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
```

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
  `ctx.oauth.token()` (the host refreshes them).
- **Calling out**: use the global `fetch`. For durable delivery with retries, create a
  host webhook subscription (external-api.md) rather than re-implementing a retry loop
  (`examples/plugins/event-forwarder` shows the plugin side and says why it stops there).
