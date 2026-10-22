/**
 * The object a plugin's `activate(host)` receives — one per plugin, bound to
 * its id. See docs/plugins.md → "Client host" and the `ClientHost` type in
 * @dispatch/shared, which this implements exactly.
 *
 * Everything here adapts an existing seam rather than adding one:
 *
 *   slots.composerControl → the ladder registry in lib/composerPrefs
 *   slots.settingsSection / panelTab / chatBadge → plugins/slots
 *   toast                 → stores/notices (the same stack `notice` events use)
 *   engines.*             → lib/engines
 *   events.on             → lib/eventTap, after the stores have applied the frame
 *   events.onPlugin       → the same tap, filtered to this plugin's `plugin-event`
 *   chat.*                → the chats store, the WS actions and `PUT /api/chats/:id`
 *   api.fetch             → `sessionFetch` under `/api/plugins/<id>/`
 *
 * The REGISTRATION functions throw on a duplicate id rather than replacing —
 * `activate` is wrapped by the loader, so a throw shows as a toast naming
 * the plugin, which is the right place for "two plugins want the same key".
 */
import * as React from "react";
import type { ClientHost, ClientHostKit, PluginChatRef, WsServerEvent } from "@dispatch/shared";
import { Button } from "../components/ui/Button.js";
import { IconButton } from "../components/ui/IconButton.js";
import { Select } from "../components/ui/Select.js";
import { MenuItem } from "../components/ui/Popover.js";
import { Tooltip } from "../components/ui/Tooltip.js";
import { Switch } from "../components/ui/Switch.js";
import { Modal, Field } from "../components/sidebar/Modal.js";
import { api } from "../lib/api.js";
import { actions } from "../lib/actions.js";
import { onServerEvent } from "../lib/eventTap.js";
import { registerComposerControl } from "../lib/composerPrefs.js";
import { useEngines } from "../lib/engines.js";
import { useChats } from "../stores/chats.js";
import { useNotices } from "../stores/notices.js";
import { sessionFetch } from "../stores/auth.js";
import { registerChatBadge, registerPanelTab, registerSettingsSection } from "./slots.js";

/**
 * The kit, typed by the HOST's guarantee (`ClientHostKit`) and assigned from
 * the real components — so a prop the kit promises that a component stops
 * taking is a compile error here, not a runtime surprise in a plugin.
 *
 *   Button / IconButton / Select / MenuItem / Tooltip — components/ui
 *   Toggle  — ui/Switch (the kit name says what it does, not how it draws)
 *   Dialog  — sidebar/Modal, the app's one centred dialog
 *   Field   — sidebar/Modal's labelled form row
 *
 * What is NOT here, deliberately: Popover (its trigger-render contract is the
 * host's business and changes), RowButton and Chip (shapes the host is still
 * settling), the editor and transcript components.
 */
export const KIT: ClientHostKit = {
  Button,
  IconButton,
  Select,
  MenuItem,
  Dialog: Modal,
  Tooltip,
  Toggle: Switch,
  Field,
};

/** The chat ref the host hands out — a projection, never the row itself. */
export function chatRefOf(id: string): PluginChatRef | undefined {
  const chat = useChats.getState().byId[id];
  if (!chat) return undefined;
  return {
    id: chat.id,
    projectId: chat.projectId,
    ...(chat.modeId !== undefined ? { modeId: chat.modeId } : {}),
    ...(chat.status !== undefined ? { status: chat.status } : {}),
    ...(chat.ext !== undefined ? { ext: chat.ext } : {}),
  };
}

export function createClientHost(pluginId: string): ClientHost {
  const prefix = `/api/plugins/${pluginId}/`;
  return {
    pluginId,
    React,
    ui: KIT,
    slots: {
      composerControl: (def) =>
        registerComposerControl({
          // Namespaced, so two plugins' "voice" controls (or a plugin's and a
          // built-in's) cannot share a sizes key.
          id: `${pluginId}:${def.id}`,
          owner: pluginId,
          label: def.label,
          hint: def.hint,
          icon: def.icon,
          priority: def.priority ?? 1,
          render: def.render,
          ...(def.menu !== undefined ? { menu: def.menu } : {}),
          ...(def.onSelect ? { onSelect: def.onSelect } : {}),
        }),
      settingsSection: (def) => registerSettingsSection(pluginId, def),
      panelTab: (def) => registerPanelTab(pluginId, def),
      chatBadge: (def) => registerChatBadge(pluginId, def),
    },
    toast: (message, opts) =>
      useNotices.getState().push({
        level: opts?.kind ?? "info",
        text: message,
        ...(opts?.detail !== undefined ? { detail: opts.detail } : {}),
      }),
    engines: {
      dictation: { register: (def) => useEngines.getState().registerDictation(def) },
      tts: { register: (def) => useEngines.getState().registerTts(def) },
    },
    events: {
      on: (type, fn) => onServerEvent(type, fn),
      onPlugin: (fn) =>
        onServerEvent("plugin-event", (evt: Extract<WsServerEvent, { type: "plugin-event" }>) => {
          if (evt.plugin === pluginId) fn(evt.payload, evt.chatId);
        }),
    },
    chat: {
      current: () => {
        const id = useChats.getState().activeChatId;
        return id ? chatRefOf(id) : undefined;
      },
      setExt: async (chatId, patch) => {
        // The server merges `ext` per key, so this writes ONLY this plugin's
        // key; `null` deletes it. The row comes back on `chat-update`, which
        // is what every tab (including this one) applies.
        await api.chats.update(chatId, { ext: { [pluginId]: patch } });
      },
      setMode: async (chatId, modeId) => {
        actions.setMode(chatId, modeId);
      },
      send: async (chatId, text) => {
        actions.sendMessage(chatId, { text });
      },
    },
    api: {
      fetch: (path, init) => sessionFetch(prefix + path.replace(/^\/+/, ""), init),
    },
  };
}
