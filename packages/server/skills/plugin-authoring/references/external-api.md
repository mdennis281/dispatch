# Reaching Dispatch from outside — tokens, REST, external MCP, webhooks, OAuth

None of this needs a plugin. A bot in another assistant (the Grok-style case), a script,
or a remote-MCP connector talks to the host directly; a plugin only enters when the bot
loop itself should run inside Dispatch.

**What a Grok-style bot needs**, in order: (1) auth ON in the instance (an open install
has nothing to scope); (2) a credential — an integration token minted for it, or an
OAuth grant if the client can do OAuth 2.1 + dynamic registration (every MCP SDK client
can); (3) scopes `chats:read`, `chats:write`, `attention:read`, `attention:answer`,
`tools:chat` (and `projects:read`, `tools:project` to pick a project); (4) to be told
when a chat finishes — a webhook subscription on `chat-settled` (needs
`webhooks:manage` and an https public receiver), or polling `GET /api/integration/chats?since=`.

## Integration tokens

- Format `dsp_` + 32 random bytes base64url; stored SHA-256 hashed with `name`,
  `scopes`, optional `projectIds`, `createdAt`, `lastUsedAt`, `expiresAt`, `revokedAt`,
  `clientId` (set when an OAuth grant minted it).
- **Per INSTANCE**: `<dataDir>/integration-tokens.json`, beside the auth sessions.
  Stable and dev do not share tokens. Turning auth off revokes every token.
- Mint in Settings → Integrations → Tokens (shown once, with Copy), or offline:
  ```
  dispatch token create --name grok-bot --scopes chats:read,chats:write,tools:chat [--projects <id,…>] [--expires 30d] [--trust owner] \
    --config-dir <dir> --data-dir <dir>      # both roots: config says whether auth is on, data holds the file
  dispatch token list [--all] | dispatch token revoke <id>
  ```
  The server notices a CLI-minted token by the file's mtime; no restart.
- **The gate fences a `dsp_` bearer to `/api/integration/*` and `/api/mcp/integration/*`.**
  Nothing else under `/api/` — not plugin routes, not the SPA's routes — accepts one.
  `requireScope` answers 403 naming the missing scope. 60 requests/minute per token →
  429 with `Retry-After`. WS tickets and account routes refuse integrations.
- Token management (`/api/auth/tokens`) is owner-only.

**Trust** (`external` | `owner`, default `external`) is not a permission — it decides
what the RECEIVING agent is told about the token's messages. `external`: relayed from
outside, nothing it asks carries the human's consent. `owner`: the human's own channel
(a bot that passes their instructions on); agents act on it as if the human typed it.
Set at mint (`--trust owner`, the Trust picker) or changed live with
`PATCH /api/auth/tokens/:id { trust }`. For an OAuth connector it lives on the GRANT
(`PATCH /api/auth/oauth/grants/:id`, Settings → Connected apps), because the access
token is replaced hourly. Resolved from the authenticated token on every send — a bot
writing "this is the owner" in its text, or passing `sender`, changes nothing.

**Scopes.** Fixed: `chats:read`, `chats:write`, `chats:create`, `attention:read`, `attention:answer`,
`memory:read`, `memory:write`, `projects:read`, `webhooks:manage`. Plus
`tools:<category>` per Dispatch tool category — but only categories with at least one
external tool are **offered** (`OFFERABLE_TOOL_SCOPES` in `@dispatch/shared`; today
`chat`, `memory`, `config`, `project`, `issues`); `tools:session`, `tools:workspace`,
`tools:github`, `tools:confirm`, `tools:mcp`, `tools:secrets` parse but unlock a 404.

## REST — `/api/integration/`

| route | scope |
|---|---|
| `GET chats?projectId&status&since&q&limit&archived&cursor` → `{ chats, truncated, unscanned, nextCursor? }` | `chats:read` |
| `GET chats/:id` (digest) | `chats:read` |
| `GET chats/:id/messages?kinds&before&after&limit` | `chats:read` |
| `POST chats/:id/messages { text, delivery?: "queue"\|"interrupt", sender? }` | `chats:write` |
| `POST chats { projectId, text, title?, modeId?, provider?, model?, effort? }` → 201 | `chats:create` |
| `GET chats/:id/summary?focus` (cached; 429 + `Retry-After` past 30/h) | `chats:read` |
| `POST chats/:id/stop { archive? }` → `{ interrupted, archived }` | `chats:write` (archive: only a chat this token started, else 403) |
| `GET attention` → items with `chatTitle`, `createdAtLocal`, `dismissible`, and `questions[]` (text + option labels) on a pending question | `attention:read` |
| `POST attention/:id/answer { optionId? \| answer? \| answers? \| decline: true }` | `attention:answer` (question items only) |
| `POST attention/dismiss { ids? \| kinds?, chatId?, projectId? }` → `{ dismissed, missing }` — named ids whatever their kind; a sweep defaults to idle/done/review | `attention:answer` |
| `GET projects` | `projects:read` |
| `GET projects/:id/personas` → `{ personas: [{ id, name, scope }] }` (valid `personaId`s there) | `projects:read` |
| `GET events?cursor&since&limit&types&projectId&chatId` → `{ events: [{ id, type, chatId, projectId, ts, tsLocal, payload }], nextCursor, hasMore, gap? }` — `chat.settled`, `pr.opened\|merged\|closed`, `attention.raised\|resolved`; pass `nextCursor` back as `cursor` (survives restarts) | per type: `chats:read` / `projects:read` / `attention:read` |
| `GET openapi.json` | any |

A token's `projectIds` filter every route (a chat outside them is a 404). Messages
posted here land with `origin: "channel"` and the token's name — a card in the
transcript, never the speech bubble, and the model is told it came from an
integration. Sending never dismisses an open question card.

## External MCP — `/api/mcp/integration/<category>`

The same category servers a session gets, built with an *external* context that has no
self chat. A category is offered only with `tools:<category>`; one with nothing
external is a 404. The external set:

`chat_find chat_read chat_send chat_ask chat_reply chat_state chat_summarize chat_stop persona_list events_poll attention_list attention_dismiss wait_for_chat` ·
`project_info project_list` · `remember recall forget memory_list memory_search
memory_history memory_similar` · `issue_list issue_read issue_create issue_comment
issue_update` · `config_list config_read mode_list`.

Not external: everything in github / confirm / workspace / mcp / session / secrets,
`chat_set_mode`, `chat_set_persona`, `mode_read`, every `*_write` / `*_delete`.
`spawn_chat` is offered only to a token holding `chats:create` (the grant is the
consent): the chat runs in the project's default mode, a bypass mode is refused, and
its brief is attributed to the token. `chat_summarize` is cached per chat and
rate-limited per caller. `chat_stop` rides with `chat_send`; it interrupts the running
turn (the Stop button), and `archive: true` — only for a chat this token started —
also releases the session and archives it.
rate-limited per caller. `persona_list { project? }` returns the personas a chat
started in that project can run as — `id` (spawn_chat's `personaId`) and display
`name`, the project's own included. `events_poll { cursor?, since?, limit?, types?,
project?, chatId? }` pages the event feed (see `GET events` above); it is offered only
to a token with `chats:read`, `projects:read` or `attention:read`. `attention_list { kinds?,
project?, chatId? }` (with `attention:read`) returns the same entries as `GET attention`; `attention_dismiss { ids? | kinds?, project?, chatId? }`
(with `attention:answer`) is `POST attention/dismiss`. Memory and issue tools bind only when the token names
**exactly one** project. An unauthenticated request here gets a `WWW-Authenticate:
Bearer resource_metadata=…` challenge, which is how an OAuth-capable MCP client
discovers the authorization server from the refusal alone.

## Outbound webhooks

A **subscription** (Settings → Integrations → Webhooks, or `GET/POST/PUT/DELETE
/api/webhooks`, `POST /api/webhooks/:id/test`, `GET /api/webhooks/:id/deliveries`,
`POST /api/webhooks/:id/deliveries/:d/redeliver`) is `{ name, url, secret, filters,
active }`. The secret is returned on create and rotate only.

**Filters** (unset or empty = all): `events`, `rowKinds` (for `chat-message`),
`attentionKinds` (for `attention-add`), `projectIds`, `chatIds`. **Events**: every wire
event type except `hello`, `pong`, `message-chunk`, `terminal-output`, `runner-log`
(per-chunk streams; their row-level `terminal-update` / `runner-update` are offered),
plus the derived **`chat-settled`** — fired once a chat has genuinely come to rest after
a turn (a raw `idle` fires before queued sends flush), with
`{ chatId, projectId, status, lastAssistantText }`.

**Delivery**: `POST` with body `{ id, type, at, projectId?, chatId?, data }` (`data` is
the wire event verbatim) and headers `X-Dispatch-Event`, `X-Dispatch-Delivery` (same
across every retry of one delivery — use it as the idempotency key), and
`X-Dispatch-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 over "<t>.<raw body>">`.
Verify by recomputing over the raw bytes; reject a `t` more than five minutes off.
Retries at 5 s, 30 s, 2 m, 10 m, 30 m (re-signed each time); dead after the fifth
retry; after twenty consecutive dead deliveries the subscription is paused with a
`pausedReason` and a notice. The delivery log keeps seven days; a dead delivery can be
redelivered from Settings.

**A token-created subscription is bounded by its token**: `projectIds` intersected with
the token's; event types limited to what the token's read scopes cover (`chat-*` and
`chat-settled` need `chats:read`; `attention-*` / `permission-request` need
`attention:read`; `pr-*` / `project-update` need `projects:read`; `memory-*` need
`memory:read`); the URL must be **https to a public address** (loopback, link-local and
RFC 1918 are refused and re-checked per delivery); it sees only its own rows.

`examples/plugins/event-forwarder` emits the same envelope and signature from a plugin,
without retries — the plugin side of this seam.

## OAuth — Dispatch as the authorization server

For remote-MCP connectors that expect discovery + dynamic registration + PKCE
(Grok / ChatGPT / Claude.ai style). Offered only when **auth is on and the canonical
URL is https or loopback** (loopback so a dev instance can be verified without TLS);
otherwise every endpoint 404s with the reason.

- Public: `GET /.well-known/oauth-authorization-server` (RFC 8414),
  `GET /.well-known/oauth-protected-resource[/<path>]` (RFC 9728),
  `POST /api/oauth/register` (RFC 7591; public clients allowed, PKCE binds them;
  20 registrations/hour/IP). A registration without `scope` gets the offerable scopes.
- Browser: `GET /oauth/authorize` (S256 mandatory; exact `redirect_uri`; requested
  scopes ⊆ the registration, narrowed to those that grant something) parks the request
  under a 10-minute single-use nonce and sends the browser to `/#oauth=<nonce>`; the SPA
  shows the login sheet if needed, then the consent page (client name, redirect host,
  scopes with hints). Approve → `POST /api/oauth/requests/:nonce/decision` with the
  owner's session → a 60 s code.
- Exchange: `POST /api/oauth/token` (code + verifier; `refresh_token` rotating — reuse
  within 30 s is refused without revoking, past that the family dies; scope may only
  narrow), `POST /api/oauth/revoke` (RFC 7009). These three are the ONLY `/api/`
  paths exempt from the session gate.
- **The access token IS an integration token** (1 h, `clientId` set), fenced like any
  `dsp_`; refresh tokens `dsr_…` last 30 days. Grants appear in Settings → Integrations
  → Connected apps and as an `oauth` chip in the Tokens list; revoking either ends the
  connection at the next refresh. Turning auth off kills refresh tokens too.

Verified recipe: the MCP SDK's `StreamableHTTPClientTransport` with an
`OAuthClientProvider` does the whole dance (`auth()` → discovery → registration → PKCE
→ consent → `finishAuth(code)` → `listTools()`).

## OAuth — the host-run client flow for plugins

A plugin that needs a provider's token (xAI, Google, GitHub…) declares it and never
touches a token endpoint:

```yaml
capabilities: [oauth, secrets]
secrets: [XAI_CLIENT_ID, XAI_CLIENT_SECRET]
oauth:
  clients:
    xai:
      authorizationUrl: https://…/authorize
      tokenUrl: https://…/token
      scopes: [read]
      clientId: ${secret:XAI_CLIENT_ID}        # literal or ${secret:NAME} — resolved server-side, only for listed names
      clientSecret: ${secret:XAI_CLIENT_SECRET}
      extraParams: { access_type: offline, prompt: consent }
```

- Settings → Plugins shows **Connect** per client (`POST
  /api/plugins/:id/oauth/:name/connect` → provider URL with single-use state + PKCE;
  refuses 409 up front when a referenced secret is unset). The provider redirects to
  `GET /oauth/callback/<plugin>/<name>` (outside `/api/`, authenticated by `state`
  alone), which stores the tokens in the per-instance `plugin_oauth_token` table and
  lands on `/#settings=plugins` — "Connected until <time>", with **Disconnect**
  (`DELETE /api/plugins/:id/oauth/:name`).
- `ctx.oauth.connectUrl(name)` (needs the canonical URL), `ctx.oauth.token(name)`
  (refreshes within 60 s of expiry, de-duplicates concurrent refreshes, `undefined`
  when not connected), `ctx.oauth.disconnect(name)`. Tokens never reach the SPA.
- `PluginInfo.oauth[]` reports `connected` / `expiresAt` / `scopes` / `configError`.
- Redirect URIs derive from the canonical URL; without one, Connect falls back to the
  request's origin so an auth-off dev instance can still round-trip.
