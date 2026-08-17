/**
 * What the Workspace modal actually ASKS the server.
 *
 * The whole point of putting the sort and the facets in `RegistryQuery` is that
 * the controls describe one question the server answers — so the thing worth
 * testing here is the translation, not the rendering. Two rules in particular
 * are easy to break and quiet when broken:
 *
 *   - a tab must not send the OTHER tab's facets. The server returns nothing for
 *     a facet a catalog can't answer (deliberately — see registry.ts), so a
 *     leaked `unmerged` would empty the Terminals list with no error anywhere.
 *   - `archived: false` must survive as a value. It reads as falsy, and any
 *     `if (flag)` on the way out drops a filter the human switched on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const worktreesList = vi.fn();
const terminalsList = vi.fn();
const killAll = vi.fn();
vi.mock("../lib/api.js", () => ({
  api: {
    worktrees: { list: (q: unknown) => worktreesList(q) },
    terminals: { list: (q: unknown) => terminalsList(q), killAll: (q: unknown) => killAll(q) },
  },
}));

/** In-memory Storage stand-in — the node test env has no localStorage. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

globalThis.localStorage = memoryStorage();
const { useWorkspace } = await import("./workspace.js");

const IDS = { projectId: "p1", chatId: "c1" };

beforeEach(() => {
  worktreesList.mockReset().mockResolvedValue([]);
  terminalsList.mockReset().mockResolvedValue([]);
  killAll.mockReset().mockResolvedValue({ killed: 0, ids: [] });
  localStorage.clear();
  useWorkspace.setState({
    kind: "worktrees",
    scope: "chat",
    sort: "recent",
    filters: { active: false, hideArchived: false, unmerged: false, unattributed: false },
    q: "",
    worktrees: [],
    terminals: [],
    loading: false,
    killing: false,
    error: undefined,
  });
});

describe("workspace store — the query it sends", () => {
  it("sends the scope, the ids and the sort", async () => {
    useWorkspace.getState().setSort("name");
    await useWorkspace.getState().load(IDS);
    expect(worktreesList).toHaveBeenCalledWith({
      scope: "chat",
      projectId: "p1",
      chatId: "c1",
      sort: "name",
    });
  });

  it("sends only the visible tab's facets", async () => {
    useWorkspace.getState().toggleFilter("unmerged");
    useWorkspace.getState().toggleFilter("active");

    await useWorkspace.getState().load(IDS);
    expect(worktreesList.mock.calls[0]![0]).toMatchObject({ unmerged: true });
    expect(worktreesList.mock.calls[0]![0]).not.toHaveProperty("active");

    useWorkspace.getState().setKind("terminals");
    await useWorkspace.getState().load(IDS);
    expect(terminalsList.mock.calls[0]![0]).toMatchObject({ active: true });
    // The leak that would silently empty the list.
    expect(terminalsList.mock.calls[0]![0]).not.toHaveProperty("unmerged");
  });

  it("sends `archived: false` for 'hide archived' — a value, not an absence", async () => {
    useWorkspace.getState().setKind("terminals");
    useWorkspace.getState().toggleFilter("hideArchived");
    await useWorkspace.getState().load(IDS);
    expect(terminalsList.mock.calls[0]![0]).toMatchObject({ archived: false });
  });

  it("omits a facet that is off, rather than sending `false`", async () => {
    await useWorkspace.getState().load(IDS);
    expect(worktreesList.mock.calls[0]![0]).not.toHaveProperty("unmerged");
  });

  it("never fetches for the PRs tab", async () => {
    useWorkspace.getState().setKind("prs");
    await useWorkspace.getState().load(IDS);
    expect(worktreesList).not.toHaveBeenCalled();
    expect(terminalsList).not.toHaveBeenCalled();
  });
});

describe("workspace store — kill all", () => {
  it("kills with the SAME query the list was fetched with, then refetches", async () => {
    useWorkspace.getState().setKind("terminals");
    useWorkspace.getState().toggleFilter("active");
    killAll.mockResolvedValue({ killed: 2, ids: ["c1::a", "c1::b"] });

    const killed = await useWorkspace.getState().killAll(IDS);

    expect(killed).toBe(2);
    expect(killAll).toHaveBeenCalledWith({
      scope: "chat",
      projectId: "p1",
      chatId: "c1",
      sort: "recent",
      active: true,
    });
    // A list left showing shells that no longer exist is worse than a spinner.
    expect(terminalsList).toHaveBeenCalledTimes(1);
    expect(useWorkspace.getState().killing).toBe(false);
  });

  it("reports a failure and clears `killing` rather than wedging the button", async () => {
    useWorkspace.getState().setKind("terminals");
    killAll.mockRejectedValue(new Error("nope"));

    expect(await useWorkspace.getState().killAll(IDS)).toBe(0);
    expect(useWorkspace.getState().killing).toBe(false);
    expect(useWorkspace.getState().error).toBe("nope");
  });
});

describe("workspace store — persistence", () => {
  it("restores kind, scope, sort and filters, and ignores junk from an older build", async () => {
    useWorkspace.getState().setKind("terminals");
    useWorkspace.getState().setScope("all");
    useWorkspace.getState().setSort("created");
    useWorkspace.getState().toggleFilter("active");

    const saved = JSON.parse(localStorage.getItem("cm.workspace.view")!);
    expect(saved).toMatchObject({ kind: "terminals", scope: "all", sort: "created" });
    expect(saved.filters.active).toBe(true);

    // A filter name this build has never heard of must not ride along into the
    // query string, where the server would 400 on it.
    localStorage.setItem(
      "cm.workspace.view",
      JSON.stringify({ kind: "terminals", scope: "all", sort: "nonsense", filters: { bogus: true } }),
    );
    vi.resetModules();
    const { useWorkspace: reloaded } = await import("./workspace.js");
    expect(reloaded.getState().sort).toBe("recent");
    expect(reloaded.getState().filters).toEqual({
      active: false,
      hideArchived: false,
      unmerged: false,
      unattributed: false,
    });
  });
});
