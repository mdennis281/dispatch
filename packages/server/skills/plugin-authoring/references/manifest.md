# plugin.yaml — the manifest

One schema, three consumers: the server's loader, `dispatch plugin add` (which validates
BEFORE copying anything in), and the Settings → Plugins row. It lives in
`packages/shared/src/plugin-manifest.ts` (`PluginManifestSchema`), and
`@dispatch/plugin-sdk/manifest` re-exports it for tooling.

```yaml
id: voice                       # [a-z0-9][a-z0-9-]{0,39}; never starts with "dispatch-"
name: Voice                     # display name
version: 0.1.0                  # the plugin's own version, semver x.y.z; not interpreted by the host
dispatch: ">=1"                 # REQUIRED: host plugin-API major it was built against
description: Talk to a chat; hear replies.
server: ./server/index.js       # optional: ESM module exporting activate / deactivate
client: ./client/index.js       # optional: ESM module exporting activate(host); its DIRECTORY is served publicly
settings: ./settings.schema.json # optional: JSON Schema → generic form in Settings → Plugins
secrets: [WHISPER_URL]          # names the plugin may read through ctx.secrets (and in mcp.yaml / oauth)
capabilities:                   # what the plugin touches; gates members of ctx; shown on the consent card
  - events
  - routes
  - chats:write
  - process
contributes:                    # see contributions.md
  modes: ./modes
  skills: ./skills
  instructions: ./instructions
  personas: ./personas
  mcpServers: ./mcp.yaml
  processes: ./processes.yaml
oauth:                          # see external-api.md → "OAuth client flow"
  clients:
    xai:                        # [a-z0-9][a-z0-9-]{0,31}
      authorizationUrl: https://…
      tokenUrl: https://…
      scopes: [read]
      clientId: ${secret:XAI_CLIENT_ID}       # literal or ${secret:NAME}; NAME must be under secrets:
      clientSecret: ${secret:XAI_CLIENT_SECRET}
      extraParams: { access_type: offline }   # appended to the authorization URL verbatim
```

## Rules the validator enforces (and why)

- **The directory name is the id.** `<configDir>/plugins/<id>/plugin.yaml` must say
  `id: <id>`; a mismatch is `invalid`. Settings key, route prefix, kv rows and the
  `plugin-event` discriminator are all keyed by the id, and a plugin with two names
  would have its state in two places.
- **`dispatch:` is required.** A small range grammar over ONE integer, the host's
  `PLUGIN_API_VERSION`: `">=1"`, `"^1"`, `"~1"`, `"1"`, `"1.x"`, `">=1 <3"` (space-separated
  clauses AND together; no `||`). Unparseable → incompatible. The API is additive
  within a major, so `">=1"` is the right thing to write.
- **Every path resolves inside the plugin directory.** Absolute paths and `..` segments
  are refused.
- **`client` must sit in its own directory, and that directory may hold nothing else of
  the plugin's** — not `server`, not `settings`, not a contributions root. The directory
  is served at `/plugins/<id>/` without authentication (a bare `import()` cannot carry a
  bearer), so a layout that put the server module beside it would publish the server
  module. `./client/index.js` is the convention; the file name is yours
  (`PluginInfo.clientUrl` is the entry file's URL).
- **`dispatch-` is a reserved id prefix** — Dispatch's own MCP servers are `dispatch-*`
  and a plugin named that way would be indistinguishable from the host in a tool name.
- `oauth.clients.<name>` keys are `[a-z0-9][a-z0-9-]{0,31}` because the name becomes a
  URL path segment of the callback.
- A `contributes.processes` entry with `singleton: true` must declare `ports` — the port
  is how the second instance finds the first (see contributions.md).

## Capabilities

| capability | grants |
|---|---|
| `events` | `ctx.bus` |
| `routes` | `ctx.routes` |
| `chats:read` | `ctx.chats.list/find/read/state`, `ctx.attention.list` |
| `chats:write` | `ctx.chats.send/ask/reply`, `ctx.attention.answer` |
| `memory` | `ctx.memory` |
| `secrets` | `ctx.secrets` (only names listed under `secrets:`) |
| `kv` | `ctx.kv` |
| `mcp` | `contributes.mcpServers` is honoured (without it: a row warning, no server) |
| `process` | `contributes.processes` is honoured, `ctx.processes` |
| `oauth` | `oauth.clients` is honoured, `ctx.oauth` |
| `ui` | a `client` entry (declare it; the consent card reads the list) |

A capability the manifest does not declare is **absent from the object** `activate`
receives — the member is `undefined`, not a stub that throws. `settings`, `projects`,
`log`, `emit`, `id`, `dir`, `version` are always present. This is a declaration for the
human who installs the plugin (the consent summary `dispatch plugin add` prints and the
Settings row), not a sandbox: server plugins run in-process with the server's
privileges.

## `settings` — the JSON Schema

`settings.schema.json` is rendered as a generic form on the plugin's Settings row and
stored as `AppSettings.plugins[<id>].settings`. Supported property types: `string`
(with `enum` → a select), `number`, `integer`, `boolean`; `title`, `description`,
`default`, `minimum`/`maximum` are honoured. Unsupported keys are named on the row
rather than silently dropped. The plugin reads them with `ctx.settings.get()` and gets
every change through `ctx.settings.onChange` — the form saves on every edit through
`PUT /api/plugins/:id/settings`, not through the app settings draft. A schema that
fails to read costs the plugin its form, not its activation.

## What the host reports — `GET /api/plugins`

One `PluginInfo` row per directory: `id`, `name`, `version`, `description`, `dir`,
`status`, `error`, `enabled`, `needsRestart`, `capabilities`, `hasServer`, `clientUrl`
(the entry module's URL), `settingsSchema`, `settings`, `secrets` (names), `oauth[]`
(per client: `connected`, `expiresAt`, `scopes`, `configError`), `warnings[]`
(non-fatal contribution problems).

| status | meaning |
|---|---|
| `active` | the server module activated, or there was none to activate |
| `disabled` | valid, but switched off (`AppSettings.plugins[id].enabled: false`) |
| `error` | `activate` threw or ran past its 30 s budget — the message is in `error`, and in the crash log |
| `invalid` | the manifest failed validation — `error` says which field |
| `incompatible` | its `dispatch` range excludes this host's `PLUGIN_API_VERSION` |

A directory under `plugins/` with no `plugin.yaml` is ignored silently (a README, a
`.git`); one WITH a manifest that fails is listed, so the owner sees why.
