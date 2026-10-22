# event-forwarder

A **TypeScript server plugin built with the SDK**: it subscribes to the bus,
POSTs the event types you choose to a URL, signs each delivery with
`X-Dispatch-Signature` exactly as the host's outbound webhooks do, and keeps a
delivery count in `ctx.kv`. The canonical reference for "a plugin that reacts
to what happens in Dispatch and tells something outside".

```
pnpm --filter @dispatch/example-event-forwarder build   # src/server.ts → server/index.js
dispatch plugin link examples/plugins/event-forwarder         # or: dispatch plugin add …
# restart Dispatch
```

Then in Settings → Plugins set **Deliver to** (and optionally **Events**), and
set the `EVENT_FORWARDER_SECRET` secret through a chat's
`mcp__dispatch-secrets__secret_request` card. `GET
/api/plugins/event-forwarder/status` reports counts and whether deliveries are
signed; `POST /api/plugins/event-forwarder/test` fires one synthetic delivery.

## What to look at

- `src/server.ts` — `definePlugin({ activate })`, with `bus.subscribe`,
  `settings.onChange`, `secrets.get`, `kv`, and two routes. The signature
  function is the host's scheme (`t=<unix>,v1=<hex HMAC-SHA256 over
  "<t>.<body>">`), so a receiver written for Settings → Integrations → Webhooks
  accepts these unchanged.
- `test/forwarder.test.ts` — `createTestContext` from
  `@dispatch/plugin-sdk/testing`: publish an event into the fake bus, stub
  `fetch`, verify the HMAC as a receiver would, change settings live, call
  the routes. No server, ~100 ms.
- `vite.config.mjs` — `dispatchServerBuild`: everything but `node:*` is inlined
  into `server/index.js`, because the host imports that file straight from the
  plugin directory where no `node_modules` exists.

## What it deliberately does not do

Retry. The host's webhooks (Settings → Integrations → Webhooks) already retry
on a schedule with a delivery log and a pause rule; a plugin that needs durable
delivery should create one of those, through the API, rather than re-implement
them. This example shows the plugin side of the seam, not a replacement for the
host's.
