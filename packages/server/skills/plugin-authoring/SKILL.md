---
name: plugin-authoring
description: Build, change or debug a Dispatch plugin, or connect an outside program to Dispatch. Use whenever the task is a plugin (a server module under <configDir>/plugins/<id>/, a client bundle in the SPA), adding a composer control, a settings section, a right-panel tab, a chat badge, a dictation or TTS engine, contributing a mode / skill / instruction / persona / MCP server / managed process from outside the repo, wiring an external bot or connector (integration tokens, scopes, the external MCP mount, the REST surface, outbound webhooks, OAuth as server or client), running `dispatch plugin init|add|link`, or a plugin that is listed as invalid / incompatible / error in Settings → Plugins. Covers `@dispatch/plugin-sdk`, `plugin.yaml`, `PluginContext`, `ClientHost`, `createTestContext`, and verifying on a throwaway instance.
---

# Writing a Dispatch plugin

A plugin is a directory under Dispatch's **config root** — `<configDir>/plugins/<id>/` —
with a `plugin.yaml` and up to two code halves: a **server module** that runs inside the
Dispatch server process (`activate(ctx)`) and a **client module** the SPA imports in the
browser (`activate(host)`). It may also **contribute** files Dispatch already understands
(modes, skills, instructions, personas, MCP servers, long-running processes) with no code
at all. Plugins are global: the stable and dev instances share the config root, so one
install is seen by both and survives every upgrade. Nothing hot-reloads — **changing a
plugin means restarting Dispatch.**

## First decide what you are building

| You want… | Build | Read |
|---|---|---|
| A bot, script or another assistant to read/queue chats, answer questions, get called back | **No plugin.** Mint an integration token or use OAuth; use the REST surface, the external MCP mount and a webhook subscription | [references/external-api.md](references/external-api.md) |
| Code that reacts to events, serves routes, talks to chats, keeps state | A **server** plugin | [references/server-api.md](references/server-api.md) |
| A composer control, settings section, panel tab, chat badge, toast, dictation/TTS engine | A **client** plugin (usually with a server half for anything secret or persistent) | [references/client-host.md](references/client-host.md) |
| A mode, skill, instruction, persona, MCP server or managed process shipped as a unit | A **contributions-only** plugin | [references/contributions.md](references/contributions.md) |

Everything else: [manifest.md](references/manifest.md) (every `plugin.yaml` field and
why the validator refuses what it refuses), [testing.md](references/testing.md) (unit
test with a fake context, then a throwaway instance), [publishing.md](references/publishing.md)
(`dispatch plugin add|link`, versioning, the restart rule).

## The fast path

```bash
dispatch plugin init my-plugin --both        # or --server / --client; from the Dispatch checkout
cd my-plugin
pnpm install                           # the SDK is link:ed from the checkout that ran dispatch
pnpm build                             # src/server.ts → server/index.js, src/client.tsx → client/index.js
pnpm test                              # activate() under @dispatch/plugin-sdk/testing, no server
dispatch plugin add . --config-dir <dir>     # validates, copies in; or `dispatch plugin link .` while developing
# restart Dispatch → Settings → Plugins
```

`dispatch` is `node packages/cli/dist/index.js` in a checkout (`pnpm dispatch …`), or on PATH in an
installed app. `--config-dir` is where the running server keeps `config.json`
(`DISPATCH_CONFIG_DIR`; a source checkout's default is `<repo>/.data`). The scaffold
links `@dispatch/plugin-sdk` from the checkout that ran `dispatch`, so its types match the host
you are installing into.

Start from the scaffold even for a tiny plugin: it has the manifest rules already
satisfied, the two Vite presets wired, and a passing test.

## Rules that are not negotiable

- **Server modules import no npm package at runtime.** `server/index.js` is imported
  straight from the plugin directory, where there is no `node_modules`. The SDK's
  `dispatchServerBuild` inlines everything but `node:*`; a hand-written module must be
  dependency-free (see `examples/plugins/hello-server`).
- **Client bundles never carry their own React.** `react`, `react-dom`,
  `react/jsx-runtime`, `zustand`, `lucide-react` resolve to the host's copies on
  `window.__dispatch.deps`; the SDK's `dispatchClientBuild` does that. A second React
  breaks every hook with "Invalid hook call".
- **The `client` entry sits in its own directory and that directory is served publicly**
  (`/plugins/<id>/`, no auth). The manifest refuses a layout that puts anything else there.
- **No raw `<button>` in plugin UI.** Use `host.ui.*` (Button, IconButton, Select,
  MenuItem, Dialog, Tooltip, Toggle, Field). A composer control's `menu` is rows, never
  a popover (on a phone the menu is a sheet).
- **A capability you did not declare is absent from `ctx`.** `ctx.kv` is `undefined`
  unless `capabilities:` lists `kv`. Declare what you use; the list is the consent card.
- **Sends go through `ctx.chats.send/ask`**, which stamp the row `origin: "channel"`.
  There is no other way to write into a chat, by design.
- **Secrets stay on the server half.** `ctx.secrets.get(name)` only for names under
  `secrets:`; the client host has no secrets API. Values arrive through
  `mcp__dispatch-secrets__secret_request`, never through chat text or the manifest.
- **The `dispatch-` prefix is reserved** for plugin ids and for contributed MCP server
  names.
- **Comments say why.** Name the failure a line prevents, like the host does.

## Where things are in the Dispatch repo

| | |
|---|---|
| `packages/shared/src/plugin-manifest.ts` | the manifest schema, `PLUGIN_API_VERSION`, `PluginInfo` |
| `packages/shared/src/plugin-api.ts` | `PluginContext` / `PluginModule` (server) |
| `packages/shared/src/plugin-client-api.ts` | `ClientHost`, slot and engine defs, the kit props |
| `packages/plugin-sdk/` | `@dispatch/plugin-sdk`: types, `definePlugin`, `./vite` presets, `./testing` |
| `packages/server/src/plugins/` | the host: `service.ts` (lifecycle), `context.ts` (what `ctx` adapts) |
| `packages/client/src/plugins/` | the client host: loader, `host.ts`, slots, `deps.ts` (the shim) |
| `packages/cli/src/core/plugins.ts`, `plugin-init.ts` | `dispatch plugin` |
| `examples/plugins/{hello-server,hello-slot,event-forwarder,contributions}` | the references — copy from these |
| `docs/plugins.md` | the full contract |

## Verifying

Unit-test `activate` with `createTestContext` first; then install into a **throwaway
instance** with its own `DISPATCH_DATA_DIR` / `DISPATCH_CONFIG_DIR` / `DISPATCH_PORT`,
look at Settings → Plugins, hit your routes, and screenshot any UI in both themes.
Never install into the user's running instance to "see if it works" — the recipe is in
[references/testing.md](references/testing.md).
