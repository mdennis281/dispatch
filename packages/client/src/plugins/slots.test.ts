import { describe, it, expect, beforeEach } from "vitest";
import {
  pluginPanelTabGroup,
  registerChatBadge,
  registerPanelTab,
  registerSettingsSection,
  resetSlots,
  slotKey,
  useSlots,
} from "./slots.js";

describe("slot registries", () => {
  beforeEach(resetSlots);

  it("files entries under a namespaced key and unregisters them", () => {
    const off = registerSettingsSection("voice", {
      id: "settings",
      label: "Voice",
      blurb: "b",
      icon: () => null,
      render: () => null,
    });
    expect(useSlots.getState().settingsSections.map((s) => s.key)).toEqual([slotKey("voice", "settings")]);
    off();
    expect(useSlots.getState().settingsSections).toEqual([]);
  });

  it("two plugins may use the same id; one plugin may not use it twice", () => {
    const tab = { id: "log", label: "Log", group: "run" as const, render: () => null };
    registerPanelTab("a", tab);
    registerPanelTab("b", tab);
    expect(() => registerPanelTab("a", tab)).toThrow(/already registered/);
    expect(pluginPanelTabGroup("a:log")).toBe("run");
    expect(pluginPanelTabGroup("worktrees")).toBeUndefined();
  });

  it("badges have no id of their own, so a plugin may register several", () => {
    registerChatBadge("a", { render: () => null });
    registerChatBadge("a", { render: () => null });
    expect(useSlots.getState().chatBadges.length).toBe(2);
  });
});
