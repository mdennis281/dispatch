import { describe, it, expect, vi } from "vitest";
import type { Chat, ChatMessage, WsServerEvent } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import type { Store } from "../store/index.js";
import {
  TitleService,
  makeFakeTitleQuery,
  DEFAULT_CHAT_TITLE,
  type TitleQueryFn,
} from "./title.js";

/* --------------------------------------------------------------- fixtures */

let seq = 0;
function chat(title: string): Chat {
  return {
    id: "c1",
    projectId: "p1",
    title,
    modeId: "default",
    effort: "medium",
    worktrees: [],
    prs: [],
    createdAt: 0,
  } as unknown as Chat;
}
function user(text: string): ChatMessage {
  return { id: `u${seq++}`, chatId: "c1", ts: seq, kind: "user", text } as ChatMessage;
}
function assistant(text: string): ChatMessage {
  return { id: `a${seq++}`, chatId: "c1", ts: seq, kind: "assistant", text } as ChatMessage;
}

/**
 * A fake store exposing only what TitleService touches. `getChat` returns the
 * latest saved record (so a save is observable by a subsequent read, mirroring
 * the real generate() re-read).
 */
function makeStore(initial: Chat | null, messages: ChatMessage[]) {
  let current = initial;
  const saves: Chat[] = [];
  const store = {
    getChat: async () => current,
    readMessages: async () => messages,
    saveChat: async (c: Chat) => {
      current = c;
      saves.push(c);
      return c;
    },
  } as unknown as Store;
  return { store, saves };
}

/** A service wired to a real bus (capturing events) + the given query. */
function make(
  initial: Chat | null,
  messages: ChatMessage[],
  query: TitleQueryFn = makeFakeTitleQuery(),
) {
  const bus = new EventBus();
  const events: WsServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const { store, saves } = makeStore(initial, messages);
  const svc = new TitleService({ store, bus, query, now: () => 42 });
  return { svc, saves, events };
}

/* ------------------------------------------------------------------ tests */

describe("TitleService.maybeGenerateInitialTitle", () => {
  it("names a default-titled chat from the first user message", async () => {
    const { svc, saves, events } = make(chat(DEFAULT_CHAT_TITLE), [
      user("add a dark mode toggle to settings"),
    ]);

    await svc.maybeGenerateInitialTitle("c1");

    expect(saves).toHaveLength(1);
    expect(saves[0]!.title.length).toBeGreaterThan(0);
    expect(saves[0]!.title).not.toBe(DEFAULT_CHAT_TITLE);
    // The new title is broadcast so the sidebar updates live.
    expect(events.some((e) => e.type === "chat-update")).toBe(true);
  });

  it("no-ops when the chat already has a custom title", async () => {
    const { svc, saves } = make(chat("Already Named"), [user("do a thing")]);
    await svc.maybeGenerateInitialTitle("c1");
    expect(saves).toHaveLength(0);
  });

  it("no-ops when there is no user text yet (image-only / empty first turn)", async () => {
    const { svc, saves } = make(chat(DEFAULT_CHAT_TITLE), [assistant("working on it")]);
    await svc.maybeGenerateInitialTitle("c1");
    expect(saves).toHaveLength(0);
  });
});

describe("TitleService.regenerate", () => {
  it("renames from recent USER text even when the title is already custom", async () => {
    const { svc, saves } = make(chat("Old Title"), [
      user("first thing"),
      assistant("Three PRs Shipped and other narration"),
      user("wire up the billing webhook"),
    ]);

    await svc.regenerate("c1");

    expect(saves).toHaveLength(1);
    // Title must come from the user's request, not the assistant's narration.
    expect(saves[0]!.title.toLowerCase()).not.toContain("prs shipped");
  });

  it("no-ops for a chat with no user messages at all", async () => {
    const { svc, saves } = make(chat("Old Title"), [assistant("hi")]);
    await svc.regenerate("c1");
    expect(saves).toHaveLength(0);
  });
});

describe("TitleService error handling", () => {
  it("swallows a query failure: no throw, no save, emits a best-effort notice", async () => {
    const throwing: TitleQueryFn = () => {
      throw new Error("sdk exploded");
    };
    const { svc, saves, events } = make(
      chat(DEFAULT_CHAT_TITLE),
      [user("please name this")],
      throwing,
    );

    // Must not reject — a failed title is a nicety, never a chat-breaking error.
    await expect(svc.maybeGenerateInitialTitle("c1")).resolves.toBeUndefined();
    expect(saves).toHaveLength(0);
    const notice = events.find((e) => e.type === "notice");
    expect(notice).toBeTruthy();
  });

  it("dedupes concurrent generations onto a single query", async () => {
    const query = vi.fn(makeFakeTitleQuery());
    const { svc } = make(chat(DEFAULT_CHAT_TITLE), [user("dedupe me")], query);
    await Promise.all([
      svc.maybeGenerateInitialTitle("c1"),
      svc.maybeGenerateInitialTitle("c1"),
    ]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------ composed turns + prefixes */

/** A user row the APP composed: a briefing, the human's line, injected context. */
function composed(brief: string, instructions: string, context?: string): ChatMessage {
  const parts = [
    { kind: "brief" as const, label: "how this config works", text: brief },
    { kind: "instructions" as const, label: "What I want", text: instructions },
    ...(context ? [{ kind: "context" as const, label: "memories", text: context }] : []),
  ];
  return {
    id: `u${seq++}`,
    chatId: "c1",
    ts: seq,
    kind: "user",
    // `text` is the whole composed prompt — what the SDK actually received.
    text: parts.map((p) => p.text).join("\n\n"),
    parts,
  } as ChatMessage;
}

describe("TitleService — composed turns", () => {
  it("titles from the human's words, not the briefing the app wrote", async () => {
    // Every config chat sends the same briefing. Seeding from `text` titles all
    // of them "Add An MCP Server To…" — the boilerplate, not the ask.
    const { svc, saves } = make(chat(DEFAULT_CHAT_TITLE), [
      composed(
        "Add an MCP server to this project's Dispatch config. Where it goes — project.yaml",
        "connect our Linear workspace",
      ),
    ]);

    await svc.maybeGenerateInitialTitle("c1");

    expect(saves).toHaveLength(1);
    expect(saves[0]!.title.toLowerCase()).toContain("connect");
    expect(saves[0]!.title.toLowerCase()).not.toContain("dispatch config");
  });

  it("ignores context the human never saw", async () => {
    const { svc, saves } = make(chat(DEFAULT_CHAT_TITLE), [
      composed("brief", "rename the worktree helper", "3 memories surfaced about pfSense"),
    ]);

    await svc.maybeGenerateInitialTitle("c1");

    expect(saves[0]!.title.toLowerCase()).not.toContain("pfsense");
  });

  it("skips a turn that is ALL briefing rather than titling from it", async () => {
    const briefOnly = {
      id: "u-brief",
      chatId: "c1",
      ts: 1,
      kind: "user",
      text: "Land everything in this working tree as a series of commits",
      parts: [{ kind: "brief", label: "Commit sweep", text: "Land everything…" }],
    } as unknown as ChatMessage;
    const { svc, saves } = make(chat(DEFAULT_CHAT_TITLE), [
      briefOnly,
      user("actually, split the schema change out"),
    ]);

    await svc.maybeGenerateInitialTitle("c1");

    expect(saves[0]!.title.toLowerCase()).toContain("actually");
  });

  it("still reads plain rows written before parts existed", async () => {
    const { svc, saves } = make(chat(DEFAULT_CHAT_TITLE), [user("add a dark mode toggle")]);
    await svc.maybeGenerateInitialTitle("c1");
    expect(saves[0]!.title.toLowerCase()).toContain("add a dark mode");
  });
});

describe("TitleService.regenerate — title prefixes", () => {
  it("keeps the chat's category when regenerating", async () => {
    // The category names where the chat came from; the transcript can't tell the
    // model that, so a regenerate would silently drop it.
    const { svc, saves } = make(chat("**sweep**: 12 files on main"), [
      user("group the schema and route changes together"),
    ]);

    await svc.regenerate("c1");

    expect(saves).toHaveLength(1);
    expect(saves[0]!.title.startsWith("**sweep**: ")).toBe(true);
    expect(saves[0]!.title).not.toBe("**sweep**: 12 files on main");
  });

  it("adds no category to a chat that never had one", async () => {
    const { svc, saves } = make(chat("Dark Mode Toggle"), [user("now do the light theme")]);
    await svc.regenerate("c1");
    expect(saves[0]!.title).not.toContain("**");
  });

  it("never nests marks, even if the model emits its own", async () => {
    const marky: TitleQueryFn = () => {
      async function* gen(): AsyncGenerator<unknown, void> {
        yield {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Fix **the** flake" }] },
        };
        yield { type: "result", subtype: "success", is_error: false, result: "Fix **the** flake" };
      }
      const g = gen() as unknown as Record<string, unknown>;
      g.interrupt = async () => {};
      g.setModel = async () => {};
      g.setPermissionMode = async () => {};
      g.setMaxThinkingTokens = async () => {};
      return g as never;
    };
    const { svc, saves } = make(chat("**sweep**: 12 files"), [user("fix the flake")], marky);

    await svc.regenerate("c1");

    expect(saves[0]!.title).toBe("**sweep**: Fix the flake");
  });
});
