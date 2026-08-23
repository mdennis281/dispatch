import type { HarnessKind, ModelOption } from "@dispatch/shared";
import type { AppSettings, AppSettingsDefaults, HarnessInfo } from "../../../lib/api.js";

/**
 * What every editable app-settings subpage gets.
 *
 * One `patch` rather than a patcher per nested key: the nested helpers were only
 * ever `{...draft.x, ...p}`, and hoisting five of them into props would have made
 * the section registry the place you go to learn what a webhook is. Each section
 * spells out its own merge against the draft it already has.
 */
export interface AppPaneProps {
  draft: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
  /** Installed providers — drives the "not installed" hint and the effort list. */
  harnesses: HarnessInfo[];
  /** Model catalog per provider, filled in as each request lands. */
  catalogs: Partial<Record<HarnessKind, ModelOption[]>>;
  /** What a cleared optional field falls back to on this server. `null` until the
   *  request lands — a section must render something honest in the meantime. */
  serverDefaults: AppSettingsDefaults | null;
}
