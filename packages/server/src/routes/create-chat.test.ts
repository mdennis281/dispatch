/**
 * The posture a NEW chat starts in.
 *
 * `createChat` walks ONE chain — the request, then (for a spawn) the parent,
 * then the project manifest's `defaults`, then the app's per-provider defaults,
 * then a built-in floor — and only PINS what the request or the parent chose.
 * Everything the project or app answered is left off the row so the chat keeps
 * inheriting it live. The whole chain is dead weight if a caller pins a value
 * it could have omitted: the UI's new-chat buttons used to send
 * `effort: "medium"` (and later `modeId: "auto"`) unconditionally, which meant
 * Settings → Chat → Effort was configurable, persisted, displayed, and never
 * once applied. These lock both halves: the chain resolves, and an omitted
 * field really is omitted rather than defaulted client-side.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectConfigDefaults } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { AuthoredConfigService } from "../services/authored-config.js";
import { createChat } from "./dispatch.js";
import type { Services } from "../services/container.js";

let root: string;
let bus: EventBus;
let store: Store;

/**
 * createChat only reaches for the store, the bus, the harness registry and the
 * project config's `defaults` — the registry is absent here (a unit test
 * installs no runtime, and the lookup is already guarded) and the config is a
 * one-method fake. `satisfies` keeps the fields it DOES provide type-checked,
 * so renaming any of them breaks the build rather than the run.
 */
function services(defaults: ProjectConfigDefaults | null = null): Services {
  const partial = { store, bus } satisfies Pick<Services, "store" | "bus">;
  const projectConfig = { getDefaults: () => defaults } satisfies Pick<
    Services["projectConfig"],
    "getDefaults"
  >;
  return { ...partial, projectConfig, harnesses: undefined } as unknown as Services;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cm-newchat-"));
  bus = new EventBus();
  store = new Store(join(root, "data"));
  await store.init();
  await store.saveProject({
    id: "p1",
    name: "P",
    repoPath: join(root, "repo"),
    worktreeRoot: join(root, "wt"),
    subApps: [],
    defaultBranch: "main",
    createdAt: 1,
  });
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe("createChat defaults", () => {
  // The app default is no longer COPIED onto the row: an unpinned chat keeps
  // inheriting it live, so a later change in Settings reaches existing chats
  // too. What the row must NOT do is carry a snapshot of today's default.
  it("leaves effort, model and mode unpinned when only the app configures them", async () => {
    await store.saveSettings({
      theme: "dark",
      defaultModeId: "plan",
      harness: {
        defaultHarness: "claude",
        defaults: { claude: { effort: "high", model: "claude-opus-5" } },
      },
    });

    const chat = await createChat(services(), { projectId: "p1" });

    expect(chat.effort).toBeUndefined();
    expect(chat.model).toBeUndefined();
    expect(chat.modeId).toBeUndefined();
    expect(chat.harness).toBe("claude");
  });

  it("leaves them unpinned when the project manifest configures them", async () => {
    const chat = await createChat(services({ mode: "edit", effort: "low", model: "m" }), {
      projectId: "p1",
    });

    expect(chat.effort).toBeUndefined();
    expect(chat.model).toBeUndefined();
    expect(chat.modeId).toBeUndefined();
  });

  it("pins exactly what the request chose", async () => {
    await store.saveSettings({
      theme: "dark",
      harness: { defaultHarness: "claude", defaults: { claude: { effort: "high" } } },
    });

    const chat = await createChat(services(), {
      projectId: "p1",
      effort: "max",
      modeId: "plan",
      model: "claude-haiku-4-5",
    });

    expect(chat.effort).toBe("max");
    expect(chat.modeId).toBe("plan");
    expect(chat.model).toBe("claude-haiku-4-5");
  });

  it("pins nothing at all when nothing is configured", async () => {
    const chat = await createChat(services(), { projectId: "p1" });

    expect(chat.effort).toBeUndefined();
    expect(chat.modeId).toBeUndefined();
    expect(chat.model).toBeUndefined();
  });

  describe("harness", () => {
    it("comes from the project manifest before the app default", async () => {
      await store.saveSettings({ theme: "dark", harness: { defaultHarness: "claude", defaults: {} } });

      const chat = await createChat(services({ harness: "codex" }), { projectId: "p1" });

      expect(chat.harness).toBe("codex");
    });

    it("comes from the app default when the manifest says nothing", async () => {
      await store.saveSettings({ theme: "dark", harness: { defaultHarness: "codex", defaults: {} } });

      const chat = await createChat(services(), { projectId: "p1" });

      expect(chat.harness).toBe("codex");
    });

    it("an explicit request wins over both", async () => {
      await store.saveSettings({ theme: "dark", harness: { defaultHarness: "codex", defaults: {} } });

      const chat = await createChat(services({ harness: "codex" }), {
        projectId: "p1",
        harness: "claude",
      });

      expect(chat.harness).toBe("claude");
    });
  });

  describe("spawned children", () => {
    it("inherit the parent's mode, effort and model as pins", async () => {
      const chat = await createChat(services({ mode: "plan", effort: "low" }), {
        projectId: "p1",
        parent: { harness: "claude", modeId: "edit", effort: "max", model: "claude-opus-5" },
      });

      expect(chat.modeId).toBe("edit");
      expect(chat.effort).toBe("max");
      expect(chat.model).toBe("claude-opus-5");
    });

    it("drop the parent's model, but not its effort or mode, on a provider change", async () => {
      const chat = await createChat(services(), {
        projectId: "p1",
        harness: "codex",
        parent: { harness: "claude", modeId: "edit", effort: "max", model: "claude-opus-5" },
      });

      expect(chat.harness).toBe("codex");
      expect(chat.model).toBeUndefined();
      expect(chat.effort).toBe("max");
      expect(chat.modeId).toBe("edit");
    });

    it("inherit nothing from an unpinned parent, so they inherit live too", async () => {
      const chat = await createChat(services(), {
        projectId: "p1",
        parent: { harness: "claude" },
      });

      expect(chat.effort).toBeUndefined();
      expect(chat.modeId).toBeUndefined();
    });
  });
});


it.each(["claude", "codex"] as const)("persists explicit personas for %s, defaulting to off", async (harness) => {
  const deps = { ...services(), authored: new AuthoredConfigService({ globalRoot: join(root, "global") }) };
  expect((await createChat(deps, { projectId: "p1", harness })).personaId).toBeUndefined();
  const selected = await createChat(deps, { projectId: "p1", harness, personaId: "product-owner" });
  expect((await store.getChat(selected.id))!.personaId).toBe("product-owner");
  expect(selected.harness).toBe(harness);
  await expect(createChat(deps, { projectId: "p1", harness, personaId: "missing" })).rejects.toThrow("unavailable");
});
