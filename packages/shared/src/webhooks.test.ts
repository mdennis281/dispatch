import { describe, expect, it } from "vitest";
import {
  CHAT_SETTLED_EVENT,
  WEBHOOK_ATTENTION_KINDS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_ROW_KINDS,
  WebhookFilterSchema,
  WebhookSubscriptionInputSchema,
  webhookFilterMatches,
} from "./webhooks.js";

describe("webhook event vocabulary", () => {
  it("offers the wire events plus chat-settled, and never the streams", () => {
    expect(WEBHOOK_EVENT_TYPES).toContain("chat-message");
    expect(WEBHOOK_EVENT_TYPES).toContain("attention-add");
    expect(WEBHOOK_EVENT_TYPES).toContain(CHAT_SETTLED_EVENT);
    // The decision, and the two streams excluded for the same reason.
    expect(WEBHOOK_EVENT_TYPES).not.toContain("message-chunk");
    expect(WEBHOOK_EVENT_TYPES).not.toContain("terminal-output");
    expect(WEBHOOK_EVENT_TYPES).not.toContain("runner-log");
    // Per-socket handshakes never reach the bus.
    expect(WEBHOOK_EVENT_TYPES).not.toContain("hello");
    expect(WEBHOOK_EVENT_TYPES).not.toContain("pong");
  });

  it("derives row and attention kinds from the message schemas", () => {
    expect(WEBHOOK_ROW_KINDS).toEqual(
      expect.arrayContaining(["user", "assistant", "tool_use", "tool_result", "result"]),
    );
    expect([...WEBHOOK_ATTENTION_KINDS]).toEqual(["permission", "question", "idle", "done", "review"]);
  });

  it("refuses a filter naming an unofferable event", () => {
    expect(WebhookFilterSchema.safeParse({ events: ["message-chunk"] }).success).toBe(false);
    expect(WebhookFilterSchema.safeParse({ events: ["chat-settled"] }).success).toBe(true);
  });

  it("has one retry per backoff step plus the first attempt", () => {
    expect(WEBHOOK_RETRY_DELAYS_MS).toEqual([5_000, 30_000, 120_000, 600_000, 1_800_000]);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(6);
  });
});

describe("webhookFilterMatches", () => {
  const msg = { type: "chat-message", chatId: "c1", projectId: "p1", rowKind: "assistant" };

  it("matches everything when nothing is set", () => {
    expect(webhookFilterMatches({}, msg)).toBe(true);
    expect(webhookFilterMatches({}, { type: "usage-update" })).toBe(true);
  });

  it("treats an empty list as unset", () => {
    expect(webhookFilterMatches({ events: [], projectIds: [], chatIds: [] }, msg)).toBe(true);
  });

  it("narrows by event type", () => {
    expect(webhookFilterMatches({ events: ["chat-message"] }, msg)).toBe(true);
    expect(webhookFilterMatches({ events: ["chat-status"] }, msg)).toBe(false);
  });

  it("consults rowKinds only for chat-message", () => {
    expect(webhookFilterMatches({ rowKinds: ["user"] }, msg)).toBe(false);
    expect(webhookFilterMatches({ rowKinds: ["assistant"] }, msg)).toBe(true);
    // Not a chat-message: the row filter is irrelevant, not a failure.
    expect(webhookFilterMatches({ rowKinds: ["user"] }, { type: "chat-status", chatId: "c1" })).toBe(true);
  });

  it("consults attentionKinds only for attention-add", () => {
    const add = { type: "attention-add", chatId: "c1", projectId: "p1", attentionKind: "done" };
    expect(webhookFilterMatches({ attentionKinds: ["permission"] }, add)).toBe(false);
    expect(webhookFilterMatches({ attentionKinds: ["done", "idle"] }, add)).toBe(true);
    expect(webhookFilterMatches({ attentionKinds: ["permission"] }, msg)).toBe(true);
  });

  it("scopes by project and chat, refusing an event with no project when one is required", () => {
    expect(webhookFilterMatches({ projectIds: ["p1"] }, msg)).toBe(true);
    expect(webhookFilterMatches({ projectIds: ["p2"] }, msg)).toBe(false);
    expect(webhookFilterMatches({ chatIds: ["c1"] }, msg)).toBe(true);
    expect(webhookFilterMatches({ chatIds: ["c9"] }, msg)).toBe(false);
    // "Only my project" must not leak a global event that has no project at all.
    expect(webhookFilterMatches({ projectIds: ["p1"] }, { type: "usage-update" })).toBe(false);
  });

  it("applies every axis together", () => {
    const f = { events: ["chat-message" as const], rowKinds: ["assistant" as const], projectIds: ["p1"] };
    expect(webhookFilterMatches(f, msg)).toBe(true);
    expect(webhookFilterMatches(f, { ...msg, rowKind: "user" })).toBe(false);
    expect(webhookFilterMatches(f, { ...msg, projectId: "p2" })).toBe(false);
  });
});

describe("WebhookSubscriptionInputSchema", () => {
  it("accepts http and https only", () => {
    expect(WebhookSubscriptionInputSchema.safeParse({ name: "x", url: "https://a.example/h" }).success).toBe(true);
    expect(WebhookSubscriptionInputSchema.safeParse({ name: "x", url: "http://192.168.1.4/h" }).success).toBe(true);
    expect(WebhookSubscriptionInputSchema.safeParse({ name: "x", url: "ftp://a.example/h" }).success).toBe(false);
    expect(WebhookSubscriptionInputSchema.safeParse({ name: "x", url: "not a url" }).success).toBe(false);
  });

  it("requires a name and a usable secret length", () => {
    expect(WebhookSubscriptionInputSchema.safeParse({ name: "  ", url: "https://a.example/h" }).success).toBe(false);
    expect(
      WebhookSubscriptionInputSchema.safeParse({ name: "x", url: "https://a.example/h", secret: "short" }).success,
    ).toBe(false);
  });
});
