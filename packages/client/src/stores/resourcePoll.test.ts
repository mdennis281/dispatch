import { describe, it, expect, vi, beforeEach } from "vitest";

const snapshot = vi.fn();
const system = vi.fn();
vi.mock("../lib/api.js", () => ({
  api: {
    resources: {
      snapshot: (fresh: boolean) => snapshot(fresh),
      system: () => system(),
      chatDetail: vi.fn(),
    },
  },
}));

const { useResources } = await import("./resources.js");

/** A promise the test settles by hand — a server that is slow to answer. */
function pending<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const snap = { at: 1, chats: [] };

beforeEach(() => {
  snapshot.mockReset();
  system.mockReset();
  useResources.setState({ snapshot: null, loading: false, refetching: false, system: null });
});

describe("resources store — polls do not stack", () => {
  it("skips a snapshot poll tick while the previous read is still out", async () => {
    // The interval fired whether or not the last request had answered, so a
    // slow server collected one more request every 5 s, each holding one of
    // the browser's six connections to the origin.
    const slow = pending<typeof snap>();
    snapshot.mockReturnValueOnce(slow.promise);
    const first = useResources.getState().refreshSnapshot();
    const tick = useResources.getState().refreshSnapshot();
    expect(snapshot).toHaveBeenCalledTimes(1);
    slow.resolve(snap);
    await Promise.all([first, tick]);
    snapshot.mockResolvedValueOnce(snap);
    await useResources.getState().refreshSnapshot();
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("still sends a forced rescan, and keeps its spinner up past a poll landing", async () => {
    const poll = pending<typeof snap>();
    const forced = pending<typeof snap>();
    snapshot.mockReturnValueOnce(poll.promise).mockReturnValueOnce(forced.promise);
    const a = useResources.getState().refreshSnapshot();
    const b = useResources.getState().refreshSnapshot(true);
    expect(snapshot).toHaveBeenNthCalledWith(2, true);
    poll.resolve(snap);
    await a;
    expect(useResources.getState().refetching).toBe(true);
    forced.resolve(snap);
    await b;
    expect(useResources.getState().refetching).toBe(false);
  });

  it("skips a system poll tick while the previous one is still out", async () => {
    const slow = pending<null>();
    system.mockReturnValueOnce(slow.promise);
    const first = useResources.getState().refreshSystem();
    await useResources.getState().refreshSystem();
    expect(system).toHaveBeenCalledTimes(1);
    slow.resolve(null);
    await first;
  });
});
