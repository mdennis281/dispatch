import { describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { installShutdown } from "./shutdown.js";

/** Minimal Fastify stand-in: we only ever call `close()`. */
function fakeApp(close: () => Promise<void>) {
  return { close } as unknown as FastifyInstance;
}

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
