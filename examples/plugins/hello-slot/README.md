# hello-slot

The canonical minimal plugin with a **client half**. It puts a control in the
composer toolbar, a section in Settings and a badge in the chat header, keeps a
per-chat count in `chat.ext`, and round-trips a ping through its server half.

```
pnpm --filter @dispatch/example-hello-slot build   # src/index.tsx → client/index.js
cm plugin link examples/plugins/hello-slot         # or: cm plugin add …
# restart Dispatch
```

`client/` is build output and is not committed — the root `pnpm build` produces
it, so a checkout that has been built has it. Linking an unbuilt copy lists the
plugin fine and then shows a "failed to load" toast for its client half.

## What to look at

- `src/index.tsx` — `activate(host)`, one use of every slot. The toolbar
  control is a bare icon: the host's size ladder decides whether it is in the
  row or only in the composer options menu, exactly as for the built-ins.
- `vite.config.mjs` — the externals → globals pattern. `react`, `react-dom`,
  `react/jsx-runtime`, `zustand` and `lucide-react` are not bundled; they
  resolve to `window.__dispatch.deps`, which the host sets before any plugin
  loads. React must be the host's — a second copy breaks every hook.
- `server/index.js` — `GET hello`, `POST ping`, and `ctx.emit`, which the
  client receives through `host.events.onPlugin`.
- `plugin.yaml` — note `client: ./client/index.js` sits in its own directory.
  That directory is served **without authentication** at `/plugins/hello-slot/`,
  which is why the schema refuses a manifest that puts the server module beside
  it.

## Rules the example follows

- No raw `<button>`: everything clickable is `host.ui.*`. The host's
  `ui/rawButtons.test.ts` is a ratchet, and plugin code should not need what it
  forbids.
- Rows in the options-menu drill-in, never a popover: on a phone that menu is a
  bottom sheet, and a popover inside it closes the sheet.
- Utility classes come from the host's stylesheet, so only classes the host
  already emits exist. Prefer the kit; use classes for layout only.
