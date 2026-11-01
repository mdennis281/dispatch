import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "@dispatch/shared";
import { publishServerEvent } from "../lib/eventTap.js";
import { api } from "../lib/api.js";
import { createClientHost } from "./host.js";
import { resetPluginSettingsForTests } from "./settings.js";

beforeEach(() => resetPluginSettingsForTests());
afterEach(() => vi.restoreAllMocks());

describe("host.settings", () => {
  it("is seeded from the row, follows the plugin-settings event, and tells listeners only of real changes", () => {
    const host = createClientHost("remote-host", { hosts: [] });
    expect(host.settings!.get()).toEqual({ hosts: [] });
    const heard: unknown[] = [];
    host.settings!.onChange((next) => heard.push(next));

    // The plugin's server half (or the other instance) wrote.
    publishServerEvent({ type: "plugin-settings", plugin: "remote-host", settings: { hosts: [{ id: "cvx-mac" }] } });
    publishServerEvent({ type: "plugin-settings", plugin: "other-plugin", settings: { x: 1 } });
    // Same value again, keys reordered — not a change.
    publishServerEvent({ type: "plugin-settings", plugin: "remote-host", settings: { hosts: [{ id: "cvx-mac" }] } });

    expect(host.settings!.get()).toEqual({ hosts: [{ id: "cvx-mac" }] });
    expect(heard).toEqual([{ hosts: [{ id: "cvx-mac" }] }]);
  });

  it("writes through PATCH and sees its own write without waiting for the event", async () => {
    const patch = vi
      .spyOn(api.plugins, "patchSettings")
      .mockResolvedValue({ settings: { hosts: [], label: "garage" } } as unknown as PluginInfo);
    const host = createClientHost("remote-host", { hosts: [] });
    await expect(host.settings!.set({ label: "garage" })).resolves.toEqual({ hosts: [], label: "garage" });
    expect(patch).toHaveBeenCalledWith("remote-host", { label: "garage" });
    expect(host.settings!.get()).toEqual({ hosts: [], label: "garage" });
  });
});
