# Testing a plugin

Two layers, in order: `activate` under a fake context (milliseconds, no server), then
the real thing on a **throwaway instance** you own. Never "try it" on the user's running
Dispatch — plugins load at boot, so that means restarting the server every one of their
chats runs through.

## 1. Unit: `createTestContext`

```ts
import { describe, expect, it, vi } from "vitest";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import plugin from "../src/server.js";

it("counts and answers", async () => {
  const t = createTestContext({
    id: "my-plugin",
    capabilities: ["routes", "events", "kv", "secrets"],   // the manifest's list → the shape the host delivers
    settings: { greeting: "hi" },
    secrets: { API_KEY: "k" },
    kv: { seen: 4 },                                        // state from an "earlier run"
    chats: [{ id: "c1", title: "Fix build", projectId: "p1", createdAt: 1, updatedAt: 2 }],
    answerAsk: (chatId, q) => "yes",                        // what chats.ask resolves with
  });
  await plugin.activate(t.ctx);

  t.publish({ type: "chat-status", chatId: "c1", status: "idle" });   // into ctx.bus listeners
  expect(t.kv.get("seen")).toBe(5);

  const res = await t.routes.call("GET", "/hello?x=1", { headers: { authorization: "Bearer t" } });
  expect(res).toMatchObject({ status: 200, body: { greeting: "hi" } });
  expect(t.routes.list()).toEqual(["GET /hello"]);

  t.settings.set({ greeting: "yo" });                       // fires ctx.settings.onChange
  expect(t.emitted).toEqual([{ payload: { ready: true } }]);
  expect(t.sent).toEqual([]);                               // chats.send calls, in order
  expect(t.log.at(-1)).toMatchObject({ level: "info" });
});
```

What it records: `emitted`, `kv` (a Map), `sent`, `asked`, `replied`, `answered`,
`log`, `memory` (per project), `processes` (seed a Map entry, start/stop flip
`status`), `oauthTokens` (set one to simulate Connected), `attention` (push items),
`listenerCount()` (zero after a clean `deactivate`). The cleanup lifecycle:
`t.lifecycle.shutdown(mod, "restart")` runs `onShutdown` then `deactivate` on the host's
5 s budget and returns `{ overran, error?, elapsedMs }` — assert `overran: false`;
`t.lifecycle.reconcile(mod, chats)`; `t.terminals.chatDeleted(id)` rejects when your
`onChatDeleted` does (the host would retry it — call it twice to prove idempotence). Route handlers receive
`PluginRequest` / `PluginReply`; `reply.code().header().send()` is honoured and the
result is `{ status, headers, body }`. An unregistered route throws, naming what exists.

Outbound HTTP: `vi.stubGlobal("fetch", async (url, init) => ({ ok: true, status: 200 }))`
and assert on the recorded calls (`examples/plugins/event-forwarder/test`).

What it does NOT do: the 30 s activate budget, real chats, persistence, two plugins at
once. Those belong to the next layer.

Run it with `pnpm test` in the plugin (the scaffold wires vitest). The host's own suite
loads `examples/plugins/hello-server` and `contributions` as fixtures — change what those
do and the host's tests change.

## 2. A throwaway instance

From a Dispatch checkout that has been built (`pnpm install && pnpm -r build`):

```powershell
# scratch roots — NEVER the user's config dir (plugins there load into their running instance)
$R = "$env:TEMP\dsp-try"; New-Item -ItemType Directory -Force "$R\config","$R\data" | Out-Null

# install the plugin into the scratch config root
pnpm dispatch plugin add C:\path\to\my-plugin --config-dir $R\config      # or: dispatch plugin link … while iterating

# pick a port nobody holds (netstat -ano | findstr LISTEN) — 4318 is stable, 4319 is dev, other agents use others
Set-Location packages\server
$env:DISPATCH_PORT="4441"; $env:DISPATCH_HOST="127.0.0.1"
$env:DISPATCH_DATA_DIR="$R\data"; $env:DISPATCH_CONFIG_DIR="$R\config"
$env:DISPATCH_FAKE_SDK="1"           # chats echo instantly; no provider tokens spent
node --import tsx ./src/dev.ts       # a managed background terminal; `pnpm dev` from the repo root prints nothing useful
```

Then, without clicking through the first-run wizard:

```bash
B=http://127.0.0.1:4441
curl -s $B/api/health                                   # wait for 200
curl -s -X POST $B/api/auth/first-run/dismiss           # skip the auth sheet
curl -s -X POST $B/api/setup/complete                   # skip the setup wizard
curl -s $B/api/plugins                                  # status per plugin; `error` carries the activate failure
curl -s $B/api/plugins/<id>/<route>                     # your routes (auth is off on a fresh instance)
curl -s -X POST $B/api/projects -H 'content-type: application/json' \
  -d '{"name":"Try","repoPath":"C:/path/to/some/repo","worktreeRoot":"C:/path/to/.worktrees"}'
curl -s -X POST $B/api/chats -H 'content-type: application/json' -d '{"projectId":"<id>","title":"Plugin demo"}'
```

Open `http://127.0.0.1:4441/#chat=<chatId>` in the Playwright MCP
(`mcp__playwright__browser_navigate`), `browser_snapshot` to find your control by its
`aria-label`, click it, read the toast from the page text, then
`browser_take_screenshot`. Settings → Plugins is the gear in the top bar, then
"Plugins" in the rail; your own settings section is further down the same rail.

**Both themes.** A fresh instance follows the OS. Switch with the app's own store (dev
mode serves source):

```js
const m = await import("/src/stores/theme.ts"); m.useTheme.getState().setTheme("dark");   // or "light"
```

Console errors from your bundle: `mcp__chrome-devtools__list_console_messages`, or the
Playwright MCP's console log. A plugin whose client failed to load shows a toast naming
it; the reason is in the console.

Stop it cleanly with `POST /api/shutdown` (or Ctrl-C in its terminal) — never
`taskkill`, which orphans any process the plugin started.

## 3. What to check before calling it done

- `GET /api/plugins` says `active`, no `warnings`.
- Every route answers; a 503 means you are still activating, a 404 that the table is
  empty (threw before `ctx.routes`?) or the plugin is off.
- Toggle it off in Settings: routes 404, the control disappears on reload, processes
  stop. Toggle on: "restart to apply".
- The composer control survives a narrow window (resize to 360 px): it must move into
  the options menu, not break the row.
- Light and dark screenshots of anything you added to the UI.
- The install path: `dispatch plugin add` (a copy, no `node_modules`), not only `link`.
