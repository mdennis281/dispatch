import { describe, it, expect, beforeEach } from "vitest";
import type { Chat, Project } from "@dispatch/shared";
import { useChats } from "./chats.js";
import { useProjects } from "./projects.js";
import { useView } from "./view.js";
import { selectProject, selectChat, reconcileActiveChat, visibleChat } from "./navigation.js";

/* --------------------------------------------------------------- fixtures */

function project(id: string): Project {
  return {
    id,
    name: `Project ${id}`,
    repoPath: `/repos/${id}`,
    worktreeRoot: `/repos/${id}/.worktrees`,
    subApps: [],
    createdAt: 1,
  };
}

function chat(id: string, projectId: string, updatedAt = 1): Chat {
  return {
    id,
    projectId,
    title: `Chat ${id}`,
    modeId: "auto",
    effort: "medium",
    worktrees: [],
    prs: [],
    createdAt: 1,
    updatedAt,
  };
}

/** Seed both stores with a two-project world and an explicit selection. */
function seed(opts: {
  chats: Chat[];
  activeProjectId?: string | null;
  activeChatId?: string | null;
}): void {
  useProjects.setState({
    projects: [project("p1"), project("p2")],
    activeProjectId: opts.activeProjectId === undefined ? "p1" : opts.activeProjectId,
  });
  const byId: Record<string, Chat> = {};
  const lastActivity: Record<string, number> = {};
  for (const c of opts.chats) {
    byId[c.id] = c;
    lastActivity[c.id] = c.updatedAt ?? c.createdAt;
  }
  useChats.setState({
    byId,
    lastActivity,
    // Deliberately NOT recency-sorted: the ordering rules under test must come
    // from `lastActivity`, not from however the seed happened to be listed.
    order: opts.chats.map((c) => c.id),
    activeChatId: opts.activeChatId ?? null,
  });
  useView.setState({ view: "chat" });
}

const activeChat = () => useChats.getState().activeChatId;
const activeProject = () => useProjects.getState().activeProjectId;

beforeEach(() => {
  useChats.setState({ byId: {}, order: [], activeChatId: null, lastActivity: {} });
  useProjects.setState({ projects: [], activeProjectId: null });
  useView.setState({ view: "chat" });
});

/* -------------------------------------------------------- selectProject */

describe("selectProject", () => {
  it("closes the open chat when switching to another project", () => {
    seed({ chats: [chat("a", "p1")], activeChatId: "a" });

    selectProject("p2");

    expect(activeProject()).toBe("p2");
    // The open chat belongs to the project we just left → empty state.
    expect(activeChat()).toBeNull();
  });

  it("does NOT auto-open a chat in the project being switched to", () => {
    // Even though p2 has chats, arriving there shows the empty state — picking
    // one is the user's move.
    seed({ chats: [chat("a", "p1"), chat("b", "p2")], activeChatId: "a" });

    selectProject("p2");

    expect(activeChat()).toBeNull();
  });

  it("is a no-op when the project is already focused (config reload re-set)", () => {
    seed({ chats: [chat("a", "p1")], activeChatId: "a" });

    selectProject("p1");

    expect(activeProject()).toBe("p1");
    expect(activeChat()).toBe("a"); // what you were reading survives
  });

  it("clears the chat even when nothing was open and when switching from no project", () => {
    seed({ chats: [chat("a", "p1")], activeProjectId: null, activeChatId: null });

    selectProject("p1");

    expect(activeProject()).toBe("p1");
    expect(activeChat()).toBeNull();
  });

  it("switches to a project id it has no record of rather than getting stuck", () => {
    // A project created in another tab: the switch must still take effect (the
    // record arrives over the socket a moment later) and must not strand the
    // previous project's chat on screen.
    seed({ chats: [chat("a", "p1")], activeChatId: "a" });

    selectProject("p-new");

    expect(activeProject()).toBe("p-new");
    expect(activeChat()).toBeNull();
  });
});

/* ----------------------------------------------------------- selectChat */

describe("selectChat", () => {
  it("opens a chat in the focused project without disturbing the project", () => {
    seed({ chats: [chat("a", "p1"), chat("b", "p1")], activeChatId: "a" });

    selectChat("b");

    expect(activeProject()).toBe("p1");
    expect(activeChat()).toBe("b");
  });

  it("switches project FIRST when the chat lives in another one", () => {
    // The Attention Queue is global: acting on an item raised by another
    // project's chat must land you in that project, not straddle two.
    seed({ chats: [chat("a", "p1"), chat("b", "p2")], activeChatId: "a" });

    selectChat("b");

    expect(activeProject()).toBe("p2");
    expect(activeChat()).toBe("b");
    expect(visibleChat(useChats.getState(), activeProject())).toBeDefined();
  });

  it("returns to the chat surface from Memory / Source Control", () => {
    seed({ chats: [chat("a", "p1")], activeChatId: null });
    useView.setState({ view: "memory" });

    selectChat("a");

    expect(useView.getState().view).toBe("chat");
  });

  it("selects an unknown chat id without touching the project (deep link beats hydrate)", () => {
    seed({ chats: [chat("a", "p1")], activeChatId: "a" });

    selectChat("not-hydrated-yet");

    expect(activeChat()).toBe("not-hydrated-yet");
    expect(activeProject()).toBe("p1"); // nothing to switch TO
    // …and until the record lands, the main area shows the empty state.
    expect(visibleChat(useChats.getState(), activeProject())).toBeUndefined();
  });

  it("re-selecting the already-open chat is stable", () => {
    seed({ chats: [chat("a", "p1")], activeChatId: "a" });

    selectChat("a");

    expect(activeChat()).toBe("a");
    expect(activeProject()).toBe("p1");
  });

  it("adopts the chat's project when no project is focused", () => {
    seed({ chats: [chat("a", "p1")], activeProjectId: null, activeChatId: null });

    selectChat("a");

    expect(activeProject()).toBe("p1");
  });
});

/* ---------------------------------------------------------- visibleChat */

describe("visibleChat", () => {
  it("returns the open chat when it belongs to the focused project", () => {
    seed({ chats: [chat("a", "p1")], activeChatId: "a" });
    expect(visibleChat(useChats.getState(), "p1")?.id).toBe("a");
  });

  it("hides a chat from another project", () => {
    seed({ chats: [chat("b", "p2")], activeChatId: "b" });
    expect(visibleChat(useChats.getState(), "p1")).toBeUndefined();
  });

  it("hides everything while no project is focused", () => {
    seed({ chats: [chat("a", "p1")], activeChatId: "a" });
    expect(visibleChat(useChats.getState(), null)).toBeUndefined();
  });

  it("returns undefined for no selection and for an unknown id", () => {
    seed({ chats: [chat("a", "p1")], activeChatId: null });
    expect(visibleChat(useChats.getState(), "p1")).toBeUndefined();
    expect(visibleChat({ activeChatId: "ghost", byId: {} }, "p1")).toBeUndefined();
  });
});

/* -------------------------------------------------- reconcileActiveChat */

describe("reconcileActiveChat", () => {
  it("keeps a selection that already belongs to the focused project", () => {
    seed({ chats: [chat("a", "p1", 10), chat("b", "p1", 20)], activeChatId: "a" });

    reconcileActiveChat();

    expect(activeChat()).toBe("a"); // not "b", the more recent one
  });

  it("replaces a foreign selection with the project's most RECENT chat", () => {
    // The hydrate case: projects[0] and the globally-most-recent chat can land
    // in different projects.
    seed({
      chats: [chat("old", "p1", 10), chat("new", "p1", 30), chat("foreign", "p2", 40)],
      activeChatId: "foreign",
    });

    reconcileActiveChat();

    expect(activeChat()).toBe("new");
  });

  it("falls back to a chat's own timestamps when it has no live activity yet", () => {
    seed({ chats: [chat("old", "p1", 10), chat("new", "p1", 30)], activeChatId: "foreign" });
    useChats.setState({ lastActivity: {} });

    reconcileActiveChat();

    expect(activeChat()).toBe("new");
  });

  it("clears the selection when the focused project has no chats", () => {
    seed({ chats: [chat("foreign", "p2")], activeChatId: "foreign" });

    reconcileActiveChat();

    expect(activeChat()).toBeNull();
  });

  it("clears an id the store has no record of", () => {
    seed({ chats: [], activeChatId: "gone" });

    reconcileActiveChat();

    expect(activeChat()).toBeNull();
  });

  it("clears the selection when no project is focused, and never auto-opens one", () => {
    seed({ chats: [chat("a", "p1")], activeProjectId: null, activeChatId: "a" });

    reconcileActiveChat();

    expect(activeChat()).toBeNull();
  });

  it("is idempotent", () => {
    seed({ chats: [chat("a", "p1", 10), chat("b", "p1", 20)], activeChatId: "foreign" });

    reconcileActiveChat();
    const first = activeChat();
    reconcileActiveChat();

    expect(activeChat()).toBe(first);
    expect(first).toBe("b");
  });

  it("never leaves the app in a state where the open chat is foreign", () => {
    // Property-ish sweep over the shapes hydrate can produce.
    const worlds: { chats: Chat[]; activeProjectId: string | null; activeChatId: string | null }[] = [
      { chats: [], activeProjectId: "p1", activeChatId: null },
      { chats: [chat("a", "p1")], activeProjectId: "p1", activeChatId: "a" },
      { chats: [chat("b", "p2")], activeProjectId: "p1", activeChatId: "b" },
      { chats: [chat("a", "p1"), chat("b", "p2")], activeProjectId: "p2", activeChatId: "a" },
      { chats: [chat("a", "p1")], activeProjectId: null, activeChatId: "a" },
      { chats: [chat("a", "p1")], activeProjectId: "p1", activeChatId: "ghost" },
    ];

    for (const w of worlds) {
      seed(w);
      reconcileActiveChat();
      const id = activeChat();
      if (id !== null) {
        expect(useChats.getState().byId[id]?.projectId).toBe(activeProject());
      }
    }
  });
});
