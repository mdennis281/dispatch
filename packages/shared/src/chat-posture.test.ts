import { describe, it, expect } from "vitest";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODE_ID,
  pinnedPostureFields,
  projectHarnessOf,
  resolveChatPosture,
  type PostureSettings,
} from "./chat-posture.js";

const settings: PostureSettings = {
  defaultModeId: "plan",
  harness: {
    defaultHarness: "claude",
    defaults: {
      claude: { effort: "high", model: "claude-opus-5", subscriptionId: "work" },
      codex: { effort: "xhigh", model: "gpt-5.6" },
    },
  },
  subscriptions: [
    { id: "work", name: "Work", provider: "claude" },
    { id: "home", name: "Home", provider: "claude" },
  ],
};

describe("resolveChatPosture", () => {
  it("bottoms out at the built-in floor with every layer absent", () => {
    const p = resolveChatPosture({});
    expect(p.harness).toMatchObject({ effective: "claude", source: "default" });
    expect(p.modeId).toMatchObject({ effective: DEFAULT_MODE_ID, source: "default" });
    expect(p.effort).toMatchObject({ effective: DEFAULT_EFFORT, source: "default" });
    expect(p.model).toMatchObject({ effective: undefined, source: "default" });
    expect(p.subscription.effective.implicit).toBe(true);
    expect(p.subscription.source).toBe("default");
  });

  it("reads the app layer per provider", () => {
    const p = resolveChatPosture({ settings });
    expect(p.modeId).toMatchObject({ effective: "plan", source: "app" });
    expect(p.effort).toMatchObject({ effective: "high", source: "app" });
    expect(p.model).toMatchObject({ effective: "claude-opus-5", source: "app" });
    expect(p.subscription).toMatchObject({ source: "app" });
    expect(p.subscription.effective.id).toBe("work");

    const codex = resolveChatPosture({ settings, chat: { harness: "codex" } });
    expect(codex.effort).toMatchObject({ effective: "xhigh", source: "app" });
    expect(codex.model).toMatchObject({ effective: "gpt-5.6", source: "app" });
  });

  it("lets the project layer override the app", () => {
    const p = resolveChatPosture({
      settings,
      project: { mode: "edit", effort: "low", model: "claude-sonnet-5" },
    });
    expect(p.modeId).toMatchObject({ effective: "edit", source: "project" });
    expect(p.effort).toMatchObject({ effective: "low", source: "project" });
    expect(p.model).toMatchObject({ effective: "claude-sonnet-5", source: "project" });
  });

  it("lets the project pin its provider, and reads that provider's app defaults", () => {
    const p = resolveChatPosture({ settings, project: { harness: "codex" } });
    expect(p.harness).toMatchObject({ effective: "codex", source: "project" });
    expect(p.effort).toMatchObject({ effective: "xhigh", source: "app" });
    expect(projectHarnessOf({ harness: "codex" }, settings)).toBe("codex");
    expect(projectHarnessOf({}, settings)).toBe("claude");
  });

  it("the chat's own pins win and report what they would inherit", () => {
    const p = resolveChatPosture({
      settings,
      project: { effort: "low" },
      chat: { modeId: "auto", effort: "max", model: "claude-haiku-4-5" },
    });
    expect(p.modeId).toMatchObject({ effective: "auto", source: "chat", inherited: "plan" });
    expect(p.effort).toMatchObject({ effective: "max", source: "chat", inherited: "low" });
    expect(p.model).toMatchObject({
      effective: "claude-haiku-4-5",
      source: "chat",
      inherited: "claude-opus-5",
    });
  });

  // The rule that keeps a Codex chat from wearing a Claude model id: a model
  // authored for one provider is skipped, not carried, when the chat lands on
  // another.
  it("skips a project model authored for another provider", () => {
    const p = resolveChatPosture({
      settings,
      project: { model: "claude-sonnet-5" },
      chat: { harness: "codex" },
    });
    expect(p.model).toMatchObject({ effective: "gpt-5.6", source: "app" });
  });

  describe("account", () => {
    it("a pinned account names the provider", () => {
      const p = resolveChatPosture({ settings, chat: { subscriptionId: "home" } });
      expect(p.harness).toMatchObject({ effective: "claude", source: "chat" });
      expect(p.subscription).toMatchObject({ source: "chat" });
      expect(p.subscription.effective.id).toBe("home");
      expect(p.subscription.inherited.id).toBe("work");
    });

    it("an explicit harness beats the account's provider, which then falls to that provider's default", () => {
      const p = resolveChatPosture({ settings, chat: { harness: "codex", subscriptionId: "home" } });
      expect(p.harness.effective).toBe("codex");
      expect(p.subscription.effective.provider).toBe("codex");
      expect(p.subscription.source).toBe("default");
    });

    it("a stale account id is ignored rather than throwing the chat onto a provider", () => {
      const p = resolveChatPosture({ settings, chat: { subscriptionId: "gone" } });
      expect(p.harness.source).toBe("app");
      expect(p.subscription.effective.id).toBe("work");
    });
  });

  describe("parent (spawn)", () => {
    const parent = {
      harness: "claude" as const,
      subscriptionId: "home",
      modeId: "edit",
      effort: "low" as const,
      model: "claude-sonnet-5",
    };

    it("sits between the request and the project for every field", () => {
      const p = resolveChatPosture({ settings, parent, project: { mode: "plan", effort: "max" } });
      expect(p.harness).toMatchObject({ effective: "claude", source: "parent" });
      expect(p.subscription.effective.id).toBe("home");
      expect(p.subscription.source).toBe("parent");
      expect(p.modeId).toMatchObject({ effective: "edit", source: "parent" });
      expect(p.effort).toMatchObject({ effective: "low", source: "parent" });
      expect(p.model).toMatchObject({ effective: "claude-sonnet-5", source: "parent" });
    });

    it("the request still wins over the parent", () => {
      const p = resolveChatPosture({ settings, parent, chat: { effort: "high", modeId: "auto" } });
      expect(p.effort).toMatchObject({ effective: "high", source: "chat" });
      expect(p.modeId).toMatchObject({ effective: "auto", source: "chat" });
    });

    it("a provider change drops the parent's model and account but keeps effort and mode", () => {
      const p = resolveChatPosture({ settings, parent, chat: { harness: "codex" } });
      expect(p.model).toMatchObject({ effective: "gpt-5.6", source: "app" });
      expect(p.subscription.effective.provider).toBe("codex");
      expect(p.effort).toMatchObject({ effective: "low", source: "parent" });
      expect(p.modeId).toMatchObject({ effective: "edit", source: "parent" });
    });

    it("an unpinned parent hands nothing down, so the child inherits live too", () => {
      const p = resolveChatPosture({ settings, parent: { harness: "claude" } });
      expect(p.effort.source).toBe("app");
      expect(pinnedPostureFields(p).effort).toBeUndefined();
    });
  });
});

describe("pinnedPostureFields", () => {
  it("always pins harness and a real account, never an implicit one", () => {
    const fields = pinnedPostureFields(resolveChatPosture({ settings }));
    expect(fields).toEqual({ harness: "claude", subscriptionId: "work" });
    const implicit = pinnedPostureFields(resolveChatPosture({ chat: { harness: "codex" } }));
    expect(implicit).toEqual({ harness: "codex" });
  });

  it("pins only what the request or the parent chose", () => {
    const fromRequest = pinnedPostureFields(
      resolveChatPosture({ settings, chat: { effort: "max" }, project: { mode: "plan" } }),
    );
    expect(fromRequest).toEqual({ harness: "claude", subscriptionId: "work", effort: "max" });

    const fromParent = pinnedPostureFields(
      resolveChatPosture({ settings, parent: { harness: "claude", modeId: "edit" } }),
    );
    expect(fromParent).toEqual({ harness: "claude", subscriptionId: "work", modeId: "edit" });
  });
});
