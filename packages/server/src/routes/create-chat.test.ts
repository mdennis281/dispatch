/**
 * The posture a NEW chat starts in.
 *
 * `createChat` is the bottom of a fallback chain — explicit input, then the
 * app's per-provider defaults, then a hardcoded floor — and the whole chain is
 * dead weight if a caller pins a value it could have omitted. The UI's new-chat
 * buttons used to send `effort: "medium"` unconditionally, which meant Settings
 * → Chat → Effort was configurable, persisted, displayed, and never once
 * applied. These lock both halves: the chain resolves, and an omitted field
 * really is omitted rather than defaulted client-side.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { createChat } from "./dispatch.js";
import type { Services } from "../services/container.js";

let root: string;
let bus: EventBus;
let store: Store;

/**
 * createChat only reaches for the store, the bus and the harness registry — the
 * last of which is absent here (a unit test installs no runtime, and the lookup
 * is already guarded). `satisfies` keeps the two fields it DOES provide
 * type-checked, so renaming either breaks the build rather than the run.
 */
function services(): Services {
  const partial = { store, bus } satisfies Pick<Services, "store" | "bus">;
  return { ...partial, harnesses: undefined } as unknown as Services;
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
  it("takes effort and model from the app's defaults for the chat's harness", async () => {
    await store.saveSettings({
      theme: "dark",
      harness: {
        defaultHarness: "claude",
        defaults: { claude: { effort: "high", model: "claude-opus-5" } },
      },
    });

    const chat = await createChat(services(), { projectId: "p1" });

    expect(chat.effort).toBe("high");
    expect(chat.model).toBe("claude-opus-5");
  });

  it("reads the defaults of the harness the chat actually starts on", async () => {
    await store.saveSettings({
      theme: "dark",
      harness: {
        defaultHarness: "claude",
        defaults: { claude: { effort: "low" }, codex: { effort: "xhigh" } },
      },
    });

    const chat = await createChat(services(), { projectId: "p1", harness: "codex" });

    expect(chat.effort).toBe("xhigh");
  });

  it("lets an explicit effort win over the app default", async () => {
    await store.saveSettings({
      theme: "dark",
      harness: { defaultHarness: "claude", defaults: { claude: { effort: "high" } } },
    });

    const chat = await createChat(services(), { projectId: "p1", effort: "max" });

    expect(chat.effort).toBe("max");
  });

  it("falls back to medium only when nothing is configured", async () => {
    const chat = await createChat(services(), { projectId: "p1" });

    expect(chat.effort).toBe("medium");
  });

  it("takes the default mode from settings", async () => {
    await store.saveSettings({ theme: "dark", defaultModeId: "plan" });

    const chat = await createChat(services(), { projectId: "p1" });

    expect(chat.modeId).toBe("plan");
  });
});
