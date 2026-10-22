/**
 * The UI slots a plugin can register into, other than the composer ladder
 * (which has its own registry in lib/composerPrefs because it is also the
 * fitting algorithm's input): settings sections, right-panel tabs and chat
 * header badges.
 *
 * Each is a list in one zustand store so the surface that renders it
 * re-renders on registration — a plugin activates after the app has painted,
 * and a static array would show its section only after the next navigation.
 * Entries carry the owning plugin id and a NAMESPACED key (`<plugin>:<id>`)
 * so two plugins' "settings" sections cannot clobber each other or a
 * built-in.
 */
import type { ChatBadgeDef, PanelTabDef, SettingsSectionDef } from "@dispatch/shared";
import { create } from "zustand";

export interface Registered<T> {
  /** `<pluginId>:<def.id>` — what navigation state and tab selection carry. */
  key: string;
  pluginId: string;
  def: T;
}

interface SlotsStore {
  settingsSections: Registered<SettingsSectionDef>[];
  panelTabs: Registered<PanelTabDef>[];
  chatBadges: Registered<ChatBadgeDef>[];
}

export const useSlots = create<SlotsStore>(() => ({
  settingsSections: [],
  panelTabs: [],
  chatBadges: [],
}));

/** The key a plugin's slot entry is filed under. */
export function slotKey(pluginId: string, id: string): string {
  return `${pluginId}:${id}`;
}

function add<K extends keyof SlotsStore>(
  list: K,
  entry: SlotsStore[K][number],
): () => void {
  const cur = useSlots.getState()[list] as Registered<unknown>[];
  if (cur.some((e) => e.key === entry.key)) {
    throw new Error(`${list} "${entry.key}" is already registered`);
  }
  useSlots.setState((s) => ({ [list]: [...(s[list] as unknown[]), entry] }) as Pick<SlotsStore, K>);
  return () => {
    useSlots.setState(
      (s) => ({ [list]: (s[list] as unknown[]).filter((e) => e !== entry) }) as Pick<SlotsStore, K>,
    );
  };
}

export function registerSettingsSection(pluginId: string, def: SettingsSectionDef): () => void {
  return add("settingsSections", { key: slotKey(pluginId, def.id), pluginId, def });
}

export function registerPanelTab(pluginId: string, def: PanelTabDef): () => void {
  return add("panelTabs", { key: slotKey(pluginId, def.id), pluginId, def });
}

let badgeSeq = 0;
export function registerChatBadge(pluginId: string, def: ChatBadgeDef): () => void {
  // A badge has no id of its own — a plugin may register several — so the
  // key is a counter under the plugin's namespace.
  return add("chatBadges", { key: slotKey(pluginId, `badge-${badgeSeq++}`), pluginId, def });
}

/** The group a registered panel tab belongs to, or undefined for a built-in / unknown tab. */
export function pluginPanelTabGroup(key: string): "run" | "ship" | undefined {
  return useSlots.getState().panelTabs.find((t) => t.key === key)?.def.group;
}

/** Test seam. */
export function resetSlots(): void {
  useSlots.setState({ settingsSections: [], panelTabs: [], chatBadges: [] });
}
