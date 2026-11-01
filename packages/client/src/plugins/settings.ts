/**
 * Each client plugin's settings, as `host.settings.get()` returns them.
 *
 * Seeded from the plugin row the loader already fetched, then kept current by
 * the `plugin-settings` wire event — which the server publishes for EVERY
 * writer: the Settings pane, the plugin's own server half, another tab, and
 * the other instance's write noticed on disk. So `get()` can stay synchronous,
 * like its server twin, without polling.
 */
import { sameSettingsValue } from "@dispatch/shared";
import { onServerEvent } from "../lib/eventTap.js";

type Listener = (next: Record<string, unknown>) => void;

const byPlugin = new Map<string, Record<string, unknown>>();
const listeners = new Map<string, Set<Listener>>();
let tapped = false;

/** The cached settings for a plugin, `{}` before anything was seen. */
export function pluginSettings(pluginId: string): Record<string, unknown> {
  return byPlugin.get(pluginId) ?? {};
}

/** Take `next` as a plugin's settings; tell its listeners when it differs. */
export function adoptPluginSettings(pluginId: string, next: Record<string, unknown>): void {
  if (!tapped) {
    tapped = true;
    onServerEvent("plugin-settings", (evt) => adoptPluginSettings(evt.plugin, evt.settings));
  }
  const had = byPlugin.has(pluginId);
  if (had && sameSettingsValue(byPlugin.get(pluginId), next)) return;
  byPlugin.set(pluginId, next);
  // The first sighting is the seed, not a change.
  if (!had) return;
  for (const fn of [...(listeners.get(pluginId) ?? [])]) {
    try {
      fn(next);
    } catch (err) {
      console.error(`[dispatch] plugin "${pluginId}" settings listener threw:`, err);
    }
  }
}

export function onPluginSettings(pluginId: string, fn: Listener): () => void {
  let set = listeners.get(pluginId);
  if (!set) listeners.set(pluginId, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}

/** Tests only: forget everything. */
export function resetPluginSettingsForTests(): void {
  byPlugin.clear();
  listeners.clear();
}
