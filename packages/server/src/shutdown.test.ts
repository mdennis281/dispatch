import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { envNames } from "./config.js";
import { installShutdown } from "./shutdown.js";

/**
 * Run as if NOT owned by the desktop shell.
 *
 * With `DISPATCH_IPC=1` in the environment, `installShutdown` subscribes to
 * stdin — and a suite that calls it a dozen times then leaks a dozen listeners
 * onto one Socket and resumes the stream, which Node reports as a memory leak
 * at eleven. That variable is set for every process Dispatch itself spawns, so
 * ANY test run started from inside the app inherits it: the suite would behave
 * differently depending on where it was launched from.
 */
const savedIpc = new Map<string, string | undefined>();
beforeEach(() => {
  for (const name of envNames("IPC")) {
    savedIpc.set(name, process.env[name]);
    delete process.env[name];
  }
});
afterEach(() => {
  for (const [name, value] of savedIpc) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedIpc.clear();
});

/** Minimal Fastify stand-in: we only ever call `close()`. */
function fakeApp(close: () => Promise<void>, terminals?: unknown) {
  return { close, services: terminals ? { terminals } : undefined } as unknown as FastifyInstance;
}

/** A TerminalService stand-in that records the order teardown touched it in. */
function fakeTerminals(over: { reap?: () => Promise<number>; pids?: number[] } = {}) {
  const calls: string[] = [];
  return {
    calls,
    reap: vi.fn(async () => {
      calls.push("reap");
      return over.reap ? await over.reap() : 0;
    }),
    livePids: vi.fn(() => (over.pids ?? []).map((pid) => ({ pid }))),
  };
}

/**
 * `installShutdown` registers a `process.on("exit")` backstop, and vitest runs
 * every test in one process — so without cleanup the listeners accumulate and
 * Node warns about a leak at eleven.
 *
 * Only OURS come off: `removeAllListeners` would take vitest's own exit handler
 * with them, which it then re-registers, producing a different leak warning
 * instead of removing one.
 */
const HOOKED = ["exit", "SIGINT", "SIGTERM"] as const;
const preExisting = new Map<string, unknown[]>();
beforeEach(() => {
  for (const ev of HOOKED) preExisting.set(ev, process.listeners(ev));
});
afterEach(() => {
  for (const ev of HOOKED) {
    const before = preExisting.get(ev) ?? [];
    for (const fn of process.listeners(ev)) {
      if (!before.includes(fn)) process.off(ev, fn as never);
    }
  }
});

describe("installShutdown", () => {
  it("closes the app and exits 0", async () => {
    const close = vi.fn(async () => {});
    const exit = vi.fn();
    const trigger = installShutdown(fakeApp(close), { exit });

    await trigger();

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent — a second trigger never re-enters close()", async () => {
    const close = vi.fn(async () => {});
    const exit = vi.fn();
    const trigger = installShutdown(fakeApp(close), { exit });

    await Promise.all([trigger(), trigger(), trigger()]);

    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("still exits when teardown throws", async () => {
    // A failing dispose must not strand the process — the shell would tree-kill
    // it anyway, and the rest of teardown should still get its chance.
    const close = vi.fn(async () => {
      throw new Error("runner stuck");
    });
    const exit = vi.fn();
    const trigger = installShutdown(fakeApp(close), { exit });

    await trigger();

    expect(exit).toHaveBeenCalledWith(0);
  });

  it("force-exits when teardown exceeds the grace window", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      // Never settles: a wedged `docker compose down`, a hung `git`.
      installShutdown(fakeApp(() => new Promise<void>(() => {})), {
        exit,
        graceMs: 500,
      })();

      await vi.advanceTimersByTimeAsync(600);

      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("installShutdown — reaping the persistent shells", () => {
  it("reaps the shells BEFORE app.close(), not as its last step", async () => {
    // The ordering IS the fix. Inside `services.dispose()` the reap sits behind
    // `runner.stopAll()`, the broker and the harnesses, so a teardown that runs
    // long never reaches it — and a shell that outlives the server keeps its
    // port with nothing left that knows it exists.
    const terminals = fakeTerminals();
    const close = vi.fn(async () => void terminals.calls.push("close"));
    await installShutdown(fakeApp(close, terminals), { exit: vi.fn() })();

    expect(terminals.calls).toEqual(["reap", "close"]);
  });

  it("gets on with teardown when the reap wedges", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const terminals = fakeTerminals({ reap: () => new Promise<number>(() => {}) });
      const close = vi.fn(async () => {});
      const done = installShutdown(fakeApp(close, terminals), { exit, graceMs: 60_000 })();

      // The reap's own budget expires long before the grace window, so a hung
      // reap costs a few seconds rather than the whole teardown.
      await vi.advanceTimersByTimeAsync(6_000);
      await done;

      expect(close).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reap that fails AFTER its budget cannot surface as an unhandled rejection", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      // The budget wins the race, so nothing is looking at `reap()` any more —
      // and `installCrashNet` would record its late rejection as a CRASH, which
      // is a much worse thing to report than a slow shutdown.
      let boom!: (e: Error) => void;
      const terminals = fakeTerminals({
        reap: () => new Promise<number>((_, reject) => (boom = reject)),
      });
      const done = installShutdown(fakeApp(async () => {}, terminals), {
        exit: vi.fn(),
        graceMs: 60_000,
      })();

      await vi.advanceTimersByTimeAsync(6_000);
      boom(new Error("taskkill exploded"));
      await vi.advanceTimersByTimeAsync(10);
      await done;
      // Rejections are reported a turn later; give the real microtask queue one.
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 10));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      vi.useRealTimers();
    }
  });

  it("does not fall over on a server built without services", async () => {
    const close = vi.fn(async () => {});
    const exit = vi.fn();
    await installShutdown(fakeApp(close), { exit })();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("still reaps when teardown itself throws", async () => {
    const terminals = fakeTerminals();
    const close = vi.fn(async () => {
      throw new Error("runner stuck");
    });
    await installShutdown(fakeApp(close, terminals), { exit: vi.fn() })();
    expect(terminals.reap).toHaveBeenCalledOnce();
  });

  it("tree-kills whatever is still live from the `exit` handler", () => {
    // The path that skipped everything else: the grace timer's `exit(1)`, or
    // any other `process.exit`. Only a SYNCHRONOUS kill runs here at all.
    const killed: number[] = [];
    const terminals = fakeTerminals({ pids: [4242, 777] });
    installShutdown(fakeApp(async () => {}, terminals), {
      exit: vi.fn(),
      killTreeSync: (pid) => killed.push(pid),
    });

    process.emit("exit", 1);

    expect(killed).toEqual([4242, 777]);
  });

  it("the exit backstop is a no-op once teardown already reaped", async () => {
    const killed: number[] = [];
    const terminals = fakeTerminals();
    const trigger = installShutdown(fakeApp(async () => {}, terminals), {
      exit: vi.fn(),
      killTreeSync: (pid) => killed.push(pid),
    });

    await trigger();
    process.emit("exit", 0);

    expect(terminals.reap).toHaveBeenCalledOnce();
    expect(killed).toEqual([]);
  });
});
