import { describe, expect, it } from "vitest";
import {
  CHAT_DELETE_DAYS_MINIMUM,
  DEFAULT_CHAT_DELETE_DAYS,
  DEFAULT_MAX_CHATS_PER_PROJECT,
  DEFAULT_REVIEWER_CHAT_DAYS,
  DEFAULT_TOOL_IMAGE_DAYS,
  MAX_CHATS_PER_PROJECT_CEILING,
  RetentionSettingsSchema,
  capChatsPerProject,
  resolveRetention,
} from "./retention.js";

const DAY_MS = 24 * 60 * 60_000;

describe("resolveRetention", () => {
  it("falls back to the shipped defaults when nothing is set", () => {
    const r = resolveRetention(undefined, undefined);
    expect(r.maxChatsPerProject.effective).toBe(DEFAULT_MAX_CHATS_PER_PROJECT);
    expect(r.maxChatsPerProject.source).toBe("default");
    expect(r.reviewerChatDays.effective).toBe(DEFAULT_REVIEWER_CHAT_DAYS);
    expect(r.toolImageDays.effective).toBe(DEFAULT_TOOL_IMAGE_DAYS);
    expect(r.chatDeleteDays.effective).toBe(DEFAULT_CHAT_DELETE_DAYS);
  });

  it("deleting by age is OFF unless someone sets it", () => {
    expect(resolveRetention({}, {}).chatDeleteMs).toBe(0);
    expect(resolveRetention({ chatDeleteDays: 30 }, {}).chatDeleteMs).toBe(30 * DAY_MS);
  });

  it("lets a project override the load cap, and names the layer", () => {
    const r = resolveRetention({ maxChatsPerProject: 200 }, { maxChatsPerProject: 50 });
    expect(r.maxChatsPerProject.effective).toBe(50);
    expect(r.maxChatsPerProject.source).toBe("project");
    expect(r.maxChatsPerProject.inherited).toBe(50);
  });

  it("gives the deletion windows no project layer", () => {
    // ProjectRetentionSchema carries only the load cap, so a manifest cannot
    // shorten the window on the only copy of a transcript.
    const r = resolveRetention({ reviewerChatDays: 30 }, { maxChatsPerProject: 10 });
    expect(r.reviewerChatDays.effective).toBe(30);
    expect(r.reviewerChatDays.source).toBe("app");
  });

  it("converts the day windows to ms for the sweep", () => {
    const r = resolveRetention({ reviewerChatDays: 7, toolImageDays: 14 }, undefined);
    expect(r.reviewerChatMs).toBe(7 * DAY_MS);
    expect(r.toolImageMs).toBe(14 * DAY_MS);
  });
});

describe("RetentionSettingsSchema", () => {
  it("accepts 0 for the load cap (unlimited) and for chatDeleteDays (never)", () => {
    expect(RetentionSettingsSchema.parse({ maxChatsPerProject: 0 }).maxChatsPerProject).toBe(0);
    expect(RetentionSettingsSchema.parse({ chatDeleteDays: 0 }).chatDeleteDays).toBe(0);
  });

  it("refuses a chat-delete window short enough to take this week's work", () => {
    expect(RetentionSettingsSchema.safeParse({ chatDeleteDays: 1 }).success).toBe(false);
    expect(
      RetentionSettingsSchema.safeParse({ chatDeleteDays: CHAT_DELETE_DAYS_MINIMUM }).success,
    ).toBe(true);
  });

  it("refuses a load cap past the ceiling", () => {
    expect(
      RetentionSettingsSchema.safeParse({
        maxChatsPerProject: MAX_CHATS_PER_PROJECT_CEILING + 1,
      }).success,
    ).toBe(false);
  });

  it("refuses a zero reviewer/image window rather than deleting immediately", () => {
    expect(RetentionSettingsSchema.safeParse({ reviewerChatDays: 0 }).success).toBe(false);
    expect(RetentionSettingsSchema.safeParse({ toolImageDays: 0 }).success).toBe(false);
  });
});

describe("capChatsPerProject", () => {
  const chat = (id: string, projectId: string, at: number) => ({ id, projectId, at });
  const activityOf = (c: { at: number }) => c.at;

  it("keeps the newest N per project, independently", () => {
    const chats = [
      chat("a1", "a", 10),
      chat("a2", "a", 9),
      chat("a3", "a", 8),
      chat("b1", "b", 1),
      chat("b2", "b", 2),
    ];
    const kept = capChatsPerProject(chats, 2, { activityOf });
    expect(kept.map((c) => c.id).sort()).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("is a no-op at or under the cap", () => {
    const chats = [chat("a1", "a", 1), chat("b1", "b", 1)];
    expect(capChatsPerProject(chats, 200, { activityOf })).toHaveLength(2);
  });

  it("loads everything when the cap is 0", () => {
    const chats = [chat("a1", "a", 3), chat("a2", "a", 2), chat("a3", "a", 1)];
    expect(capChatsPerProject(chats, 0, { activityOf })).toHaveLength(3);
  });

  it("keeps a pinned chat that the recency cap would have dropped", () => {
    // The failure this exists for: a chat parked on a permission prompt from
    // hours ago is both old and the most important row on the screen.
    const chats = [chat("fresh", "a", 100), chat("asking", "a", 1)];
    const kept = capChatsPerProject(chats, 1, { activityOf, pinned: new Set(["asking"]) });
    expect(kept.map((c) => c.id)).toEqual(["asking"]);
  });

  it("counts pinned chats against the cap rather than on top of it", () => {
    const chats = [chat("p1", "a", 1), chat("p2", "a", 2), chat("fresh", "a", 100)];
    const kept = capChatsPerProject(chats, 2, {
      activityOf,
      pinned: new Set(["p1", "p2"]),
    });
    expect(kept).toHaveLength(2);
    expect(kept.map((c) => c.id).sort()).toEqual(["p1", "p2"]);
  });

  it("returns what it keeps newest-first", () => {
    const chats = [chat("older", "a", 1), chat("newer", "a", 2)];
    expect(capChatsPerProject(chats, 5, { activityOf }).map((c) => c.id)).toEqual([
      "newer",
      "older",
    ]);
  });
});
