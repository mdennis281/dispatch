# The client host — `activate(host)`

Types: `ClientHost` and the slot/engine defs in `@dispatch/plugin-sdk` (re-exported from
`packages/shared/src/plugin-client-api.ts`). The host lives in
`packages/client/src/plugins/` (`host.ts` is what `host` is; `slots.ts` the registries;
`PluginSlot.tsx` how a `render` is mounted). Reference: `examples/plugins/hello-slot`.

## Loading

After boot (and again after sign-in), the SPA fetches `GET /api/plugins` and, for every
plugin whose `status` is `active` AND has a `clientUrl`, `import()`s that URL and calls
`activate(host)`. A plugin whose server half failed (`error`) does not get its client
loaded — its routes would 404. An import or `activate` that throws shows a toast naming
the plugin and is skipped; the next plugin still loads.

`clientUrl` is `/plugins/<id>/<entry file>`; the directory holding the entry is served
publicly, path-confined, `no-cache`. There is no deactivate hook on the client side —
switching a plugin off pulls the bundle on the next load; the current tab keeps what it
registered until reload.

## Building the bundle

```js
// vite.config.mjs
import { dirOf, dispatchClientBuild } from "@dispatch/plugin-sdk/vite";
export default dispatchClientBuild({ root: dirOf(import.meta.url), entry: "src/client.tsx" });
```

```tsx
import { defineClientPlugin } from "@dispatch/plugin-sdk";
import { useState } from "react";          // resolves to the host's React at build time
import { Sparkles } from "lucide-react";   // tree-shakes to the icons you import

export default defineClientPlugin({ activate(host) { … } });
```

**React is a singleton.** The bundle must not carry its own `react`, `react-dom`,
`react/jsx-runtime`, `zustand` or `lucide-react`; the preset resolves those five to the
host's copies on `window.__dispatch.deps` (`DispatchClientGlobals`). Import them
normally in source. `host.React` is the same object, for code that prefers not to
import at all. Anything else you import is bundled.

Styling: utility classes come from the host's stylesheet, so only classes the host
already emits exist. Prefer the kit; use classes for layout. Both themes must work —
the host's tokens (`text-muted`, `border-line`, `bg-inset`…) do, hard-coded colours
don't.

## `host`

```ts
host.pluginId
host.React                                   // the host's React
host.ui                                      // the kit: Button, IconButton, Select, MenuItem, Dialog, Tooltip, Toggle, Field
host.slots.composerControl(def) → unsubscribe
host.slots.settingsSection(def) → unsubscribe
host.slots.panelTab(def) → unsubscribe
host.slots.chatBadge(def) → unsubscribe
host.toast(message, { kind?: "info" | "warn" | "error", detail? })
host.engines.dictation.register(def) → unsubscribe
host.engines.tts.register(def) → unsubscribe
host.events.on("chat-update", (evt) => …) → unsubscribe   // the typed server event stream, AFTER the host's stores applied it
host.events.onPlugin((payload, chatId?) => …) → unsubscribe // this plugin's plugin-events only
host.chat.current()                          // { id, projectId, modeId?, status?, ext? } | undefined
host.chat.setExt(chatId, patch | null)       // writes ext[pluginId] (null deletes it); the row returns on chat-update
host.chat.setMode(chatId, modeId | null)
host.chat.send(chatId, text)
host.api.fetch(path, init?)                  // sessionFetch under /api/plugins/<pluginId>/ — your routes, authenticated
```

Registration functions throw on a duplicate id (two plugins wanting the same key) —
the loader turns that into the failing-plugin toast.

## Slots

Every `render` runs **as its own component inside an error boundary scoped to your
plugin** (`PluginSlot`). So a `render` may use hooks directly, and one that throws shows
"<plugin> failed · Retry" in the slot's place instead of taking the host's region down.
A `menu` is a `ReactNode` created once at registration — put state in a component of
your own rendered inside it.

### Composer control

```ts
host.slots.composerControl({
  id: "voice",            // namespaced by the host to "<pluginId>:voice"
  label: "Voice",
  hint: "talk instead of type",     // beside the label in the options menu and the "Show in composer" list
  icon: <Mic />,
  priority: 1,            // eviction tie-break; built-ins run 0 (persona) … 6 (dictate); lower leaves first
  render: (size) => <VoiceButton host={host} />,   // size is always "sm": a plugin control is an icon
  menu: <VoiceRows host={host} />,                 // OR onSelect: () => …, for a control with no drill-in
});
```

The control **enters the toolbar's size ladder** with one `sm` rung: when width runs
out it is evicted like any built-in icon and lives in the composer options menu, where
it always has a root row (and a drill-in if you gave a `menu`). It never adds a row to
the composer box — that is the rule, not a suggestion. The `menu` is rendered inside
the host's menu surface, which on a phone is a bottom sheet: it must be **rows**
(`host.ui.MenuItem`), never a popover (a popover inside the sheet closes the sheet).

### Settings section

```ts
host.slots.settingsSection({ id: "voice", label: "Voice", blurb: "engines and voice mode", icon: Mic, render: () => <Page/> });
```
Appears in the Settings rail under the built-in sections. `blurb` is the one-line
description — at phone width the rail IS the index. `icon` is a component
(`ComponentType<{ className?: string }>`), not an element.

### Panel tab

```ts
host.slots.panelTab({ id: "transcript", label: "Transcript", group: "run" | "ship", icon?, render: (chat) => … });
```
A tab in the right panel's `run` (processes) or `ship` (the change) half; `render`
receives the current chat ref.

### Chat badge

```ts
host.slots.chatBadge({ render: (chat) => (count ? <Chip/> : null) });
```
Rendered in the chat header for the chat on screen; return `null` to show nothing.

## Engines

```ts
host.engines.dictation.register({
  id: "whisper", label: "Local Whisper",
  unavailable: () => (navigator.mediaDevices ? null : "no microphone access"),  // checked before create
  create: (handlers) => ({ start() {…}, stop() {…} }) | null,   // handlers.onFinal/onInterim/onError/onStopped
});
host.engines.tts.register({
  id: "piper", label: "Piper",
  unavailable?: () => string | null,
  create: () => ({ feed(sentence) {…}, flush() {…}, cancel() {…} }) | null,
});
```

Engines are **per browser**, not per chat: which one is active is a local preference
beside the composer-control visibility, picked in the composer options menu — the
"Voice engines…" row appears once a plugin has registered one (with only the built-ins
there is nothing to pick). The built-in Web Speech dictation and `speechSynthesis` TTS
are always registered. A selection naming an engine that is no longer registered falls
back to the built-in.

TTS **streams**: with "Speak replies" on, the host feeds the active chat's reply at
**sentence boundaries** (`feed` gets whole sentences, never raw deltas), `flush`es when
the assistant row lands, and `cancel`s when the reader switches chats or turns it off.
The chunker stops at a `---` line, which is voice mode's convention for "the spoken part
ends here".

## Per-chat state: `chat.ext`

`Chat.ext` is a bag keyed by plugin id. `host.chat.setExt(chatId, patch)` writes
`ext[pluginId] = patch` (whole slice, not merged) and `null` deletes your key; other
plugins' keys are untouched, and the server merges per key under the chat lock so two
plugins cannot erase each other. The updated row arrives on `chat-update` — subscribe to
it to see your own write land, in this tab and every other (hello-slot's
`useCurrentChat`). The host never interprets `ext`.

## Events

`host.events.on(type, fn)` taps the typed server event stream after the host's stores
have applied the frame, so a listener that reads `host.chat.current()` sees the new
state. `onPlugin` is the same tap filtered to your plugin's `plugin-event`s. Both return
an unsubscribe.

## What is NOT available, deliberately

Secrets (server half only). Popover, RowButton, Chip, the editor and transcript
components (shapes the host is still settling). Raw `<button>` — the host's
`ui/rawButtons.test.ts` ratchet is why the kit exists.
