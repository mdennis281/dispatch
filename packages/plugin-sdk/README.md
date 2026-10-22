# @dispatch/plugin-sdk

What a Dispatch plugin author imports. Three entry points:

| import | gives you |
|---|---|
| `@dispatch/plugin-sdk` | every plugin type (`PluginContext`, `ClientHost`, `PluginManifest`, …), `definePlugin()`, `defineClientPlugin()` — types and two identity helpers, nothing that costs bundle size |
| `@dispatch/plugin-sdk/manifest` | `PluginManifestSchema`, `PLUGIN_API_VERSION`, `pluginRangeAccepts` and the other constants, for tooling (they carry zod; keep them out of plugin source) |
| `@dispatch/plugin-sdk/vite` | `dispatchClientBuild()` and `dispatchServerBuild()` — Vite configs that produce `client/index.js` against the host's globals shim and a self-contained `server/index.js` |
| `@dispatch/plugin-sdk/testing` | `createTestContext()` — a fake `PluginContext` so `activate` runs under vitest with no server |

Start from a scaffold rather than from here:

```
cm plugin init my-plugin --both      # or --server / --client
cd my-plugin && pnpm install && pnpm build && pnpm test
cm plugin add . --config-dir <dispatch config dir>
# restart Dispatch
```

The scaffold's `package.json` links this package from the Dispatch checkout
that ran `cm`, so the types and the build presets are the ones that match the
host you are installing into. The SDK is versioned with the host and is not on
npm; `PLUGIN_API_VERSION` (and the manifest's `dispatch:` range) is the
compatibility contract, not a package version.

The canonical references are `examples/plugins/` in the Dispatch repo:
`hello-server` (plain JS, every basic server seam), `hello-slot` (a client
half built with the preset), `event-forwarder` (TypeScript server plugin with a
test, built with the preset), `contributions` (no code — a mode, a skill, an
MCP server, a process). The full contract is `docs/plugins.md`.

## Server module

```ts
import { definePlugin } from "@dispatch/plugin-sdk";

export default definePlugin({
  async activate(ctx) {
    ctx.routes?.((r) => r.get("/hello", async () => ({ hi: ctx.id })));
    ctx.bus?.on("chat-status", (evt) => ctx.log.info(`${evt.chatId} → ${evt.status}`));
  },
});
```

Capability-gated members (`bus`, `routes`, `kv`, `secrets`, `chats`,
`attention`, `memory`, `processes`, `oauth`) are optional on the type because
they are absent at runtime when `plugin.yaml` does not declare the capability.
Declare it and use `!`, or keep the `?.` — both are honest.

Route handlers receive `PluginRequest` / `PluginReply`: the structural subset
of Fastify's request and reply a handler actually reads. The object is a real
Fastify request at runtime; cast if you need more.

`server/index.js` is imported straight from the plugin directory, with no
`node_modules` beside it, so it must not `import` any npm package at runtime.
`dispatchServerBuild` inlines everything but Node's builtins, which is the
reason the preset exists.

## Client module

```tsx
import { defineClientPlugin } from "@dispatch/plugin-sdk";
import { Sparkles } from "lucide-react";

export default defineClientPlugin({
  activate(host) {
    host.slots.composerControl({
      id: "hello", label: "Hello", hint: "says hello", icon: <Sparkles />,
      render: () => <host.ui.IconButton tip="Hello" onClick={() => host.toast("hi")}><Sparkles /></host.ui.IconButton>,
      onSelect: () => host.toast("hi"),
    });
  },
});
```

`react`, `react-dom`, `react/jsx-runtime`, `zustand` and `lucide-react` are
imported normally and resolved by the build to the host's copies on
`window.__dispatch.deps`. React must be the host's: a second copy breaks every
hook. Everything clickable is `host.ui.*`; the host's no-raw-button ratchet is
why the kit exists.

## Testing

```ts
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import plugin from "../src/server.js";

const t = createTestContext({ capabilities: ["routes", "kv"], settings: { greeting: "yo" } });
await plugin.activate(t.ctx);
expect((await t.routes.call("GET", "/hello")).body).toEqual({ hi: "test-plugin" });
t.publish({ type: "chat-status", chatId: "c1", status: "idle" });
expect(t.kv.get("seen")).toBe(1);
```

Everything is in memory and recorded (`sent`, `asked`, `emitted`, `log`, …).
It does not enforce the host's 30 s activate budget or run against real
chats; verify on a throwaway instance before shipping.
