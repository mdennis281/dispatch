import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Chat, Project } from "@dispatch/shared";
import { useChats } from "./chats.js";
import { useProjects } from "./projects.js";
import { useView } from "./view.js";
import { useLayout } from "./layout.js";
import {
  selectProject,
  selectChat,
  selectGlobalChat,
  openChat,
  openProject,
  reconcileActiveChat,
  openPicker,
  visibleChat,
  goHome,
  leaveHome,
  toggleHome,
  lastPlace,
} from "./navigation.js";

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

/* ------------------------------------------------------------------- home */

describe("the homepage toggle", () => {
  it("snapshots where you were and returns you to exactly that", () => {
    seed({ chats: [chat("c1", "p1"), chat("c2", "p2")], activeChatId: "c1" });

    goHome();
    expect(useView.getState().view).toBe("home");
    expect(lastPlace()).toEqual({ projectId: "p1", chatId: "c1" });

    leaveHome();
    expect(useView.getState().view).toBe("chat");
    expect(useProjects.getState().activeProjectId).toBe("p1");
    expect(useChats.getState().activeChatId).toBe("c1");
  });

  it("returns to where you LEFT, not to a card you clicked while home", () => {
    // The reason the place is snapshotted rather than read live: picking p2's
    // chat from the grid moves the selection, and the toggle still means "back".
    seed({ chats: [chat("c1", "p1"), chat("c2", "p2")], activeChatId: "c1" });
    goHome();
    selectChat("c2");
    expect(useProjects.getState().activeProjectId).toBe("p2");

    useView.setState({ view: "home" });
    leaveHome();
    expect(useProjects.getState().activeProjectId).toBe("p1");
    expect(useChats.getState().activeChatId).toBe("c1");
  });

  it("falls back to the project when the remembered chat is gone", () => {
    seed({ chats: [chat("c1", "p2")], activeProjectId: "p2", activeChatId: "c1" });
    goHome();
    // The chat is deleted while the overview is up.
    useChats.setState({ byId: {}, order: [], lastActivity: {}, activeChatId: null });

    leaveHome();
    expect(useView.getState().view).toBe("chat");
    expect(useProjects.getState().activeProjectId).toBe("p2");
  });

  it("still leaves when there is nothing at all to return to", () => {
    // The one thing it must never do is strand you on a view with no sidebar.
    seed({ chats: [], activeProjectId: null, activeChatId: null });
    goHome();
    leaveHome();
    expect(useView.getState().view).toBe("chat");
  });

  it("toggles both ways and does not overwrite the place on a second press", () => {
    seed({ chats: [chat("c1", "p1")], activeChatId: "c1" });
    toggleHome();
    expect(useView.getState().view).toBe("home");
    // Already home — pressing again must not record `home` as the place to
    // return to, which would make the toggle a no-op forever after.
    toggleHome();
    expect(useView.getState().view).toBe("chat");
    expect(lastPlace()).toEqual({ projectId: "p1", chatId: "c1" });
  });
});

/* ------------------------------------------------------- the stale pane */

/**
 * Below `lg` a Ship/Run pane REPLACES the transcript, and the homepage is
 * full-bleed — you reach it from wherever you were, with whatever pane you had
 * open still selected. Every navigation that lands on a chat has to put that
 * back, or the click navigates correctly and looks like it did nothing.
 */
describe("navigating to a chat clears a stale Ship/Run pane", () => {
  const onRun = () => useLayout.setState({ pane: "run" });
  const pane = () => useLayout.getState().pane;

  it("openChat — the homepage's three lists", () => {
    seed({ chats: [chat("c1", "p1"), chat("c2", "p2")], activeChatId: "c1" });
    onRun();
    openChat("c2");
    expect(pane()).toBe("chat");
    expect(useChats.getState().activeChatId).toBe("c2");
    expect(useProjects.getState().activeProjectId).toBe("p2");
  });

  it("selectGlobalChat — the homepage button, the sidebar row, the palette", () => {
    seed({ chats: [chat("c1", "p1")], activeChatId: "c1" });
    onRun();
    selectGlobalChat();
    expect(pane()).toBe("chat");
    expect(useView.getState().view).toBe("chat");
    expect(useProjects.getState().activeProjectId).toBe("__global__");
  });

  it("openProject — unchanged, and asserted beside the two above", () => {
    seed({ chats: [chat("c1", "p1"), chat("c2", "p2")], activeChatId: "c1" });
    onRun();
    openProject("p2");
    expect(pane()).toBe("chat");
    expect(useChats.getState().activeChatId).toBe("c2");
  });

  it("selectChat on its own does NOT — it is pressed from inside panels too", () => {
    seed({ chats: [chat("c1", "p1"), chat("c2", "p2")], activeChatId: "c1" });
    onRun();
    selectChat("c2");
    expect(pane()).toBe("run");
  });
});

/* ------------------------------------------------------------- the picker */

/**
 * The phone's chat list is a PLACE, not a sheet over the transcript — so going
 * to it closes the chat.
 *
 * The visible symptom was in the bottom nav: Ship and Run are enabled by the
 * open chat alone, so they stayed live, lit and badged for a chat you had left
 * long enough ago to have forgotten which one it was, and one tap put that
 * chat's panel over the list you were reading.
 *
 * The node test env has no `matchMedia`, so `useLayout` boots at `lg` (see
 * lib/useBreakpoint) — every test that wants the phone says so, and puts it
 * back afterwards for the suites that assume the default.
 */
describe("openPicker", () => {
  const onPhone = () => useLayout.setState({ mode: "sm" });

  beforeEach(() => {
    useLayout.setState({ mode: "lg", leftOpen: false, pane: "chat" });
  });

  it("shows the list and closes the chat behind it", () => {
    onPhone();
    seed({ chats: [chat("c1", "p1")], activeChatId: "c1" });

    openPicker();

    expect(useLayout.getState().leftOpen).toBe(true);
    expect(activeChat()).toBeNull();
    // The project stays — the list you land on is this project's list.
    expect(activeProject()).toBe("p1");
  });

  it("resets a Ship/Run pane, which nothing renders with no chat open", () => {
    onPhone();
    seed({ chats: [chat("c1", "p1")], activeChatId: "c1" });
    useLayout.setState({ pane: "run" });

    openPicker();

    expect(useLayout.getState().pane).toBe("chat");
  });

  it("is a no-op above sm, where the sidebar is a column beside the transcript", () => {
    for (const mode of ["md", "lg"] as const) {
      useLayout.setState({ mode, leftOpen: false, pane: "chat" });
      seed({ chats: [chat("c1", "p1")], activeChatId: "c1" });

      openPicker();

      expect(activeChat()).toBe("c1");
      expect(useLayout.getState().leftOpen).toBe(false);
    }
  });
});

describe("openProject on a phone", () => {
  beforeEach(() => {
    useLayout.setState({ mode: "sm", leftOpen: false, pane: "chat" });
  });

  afterEach(() => {
    useLayout.setState({ mode: "lg", leftOpen: false, pane: "chat" });
  });

  it("lands on the project's chat list rather than inside its newest chat", () => {
    // The homepage grid is how you choose BETWEEN projects; a tap on a card
    // that re-entered a conversation from days ago reads as the app having
    // restored something you did not ask for. At `sm` the list is the whole
    // screen, so showing it IS taking you in.
    seed({ chats: [chat("c1", "p1"), chat("c2", "p2")], activeChatId: "c1" });

    openProject("p2");

    expect(activeProject()).toBe("p2");
    expect(activeChat()).toBeNull();
    expect(useLayout.getState().leftOpen).toBe(true);
    expect(useView.getState().view).toBe("chat");
  });

  it("clears the previous chat even when the project is already focused", () => {
    // `selectProject` short-circuits on a re-select (it is how a config reload
    // forces itself), so the clearing cannot be left to it.
    seed({ chats: [chat("c1", "p1")], activeChatId: "c1" });

    openProject("p1");

    expect(activeChat()).toBeNull();
    expect(useLayout.getState().leftOpen).toBe(true);
  });

  it("still opens the most recent chat above sm", () => {
    useLayout.setState({ mode: "md" });
    seed({ chats: [chat("c1", "p1"), chat("old", "p2", 10), chat("new", "p2", 30)] });

    openProject("p2");

    expect(activeChat()).toBe("new");
    expect(useLayout.getState().leftOpen).toBe(false);
  });
});
