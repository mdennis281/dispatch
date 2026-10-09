import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PauseState } from "@dispatch/shared";
import { PauseService } from "./pause.js";
import type { SessionBroker } from "./session-broker.js";

/** The slice of the broker the service drives, with the pause it would hold. */
function fakeBroker() {
  let state: PauseState | undefined;
  const calls: string[] = [];
  const broker = {
    get pause() {
      return state;
    },
    restorePause: (s: PauseState) => {
      state = s;
      calls.push("restore");
    },
    pauseAll: async (onArmed?: (s: PauseState) => Promise<void>) => {
      state = { since: 0, interrupted: ["a", "b"] };
      calls.push("pauseAll");
      await onArmed?.(state);
      return state;
    },
    markKilled: (ids: string[]) => {
      state = state && { ...state, killedAt: 1, killed: ids };
      return state;
    },
    resumeAll: (first: string[]) => {
      state = undefined;
      calls.push(`resumeAll:${first.join(",")}`);
    },
    schedulerSnapshot: () => ({ paused: state ?? null, cap: 4, running: [], queued: [] }),
  };
  return { broker: broker as unknown as SessionBroker, calls };
}

describe("PauseService", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pause-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function make(overrides: { killChat?: (id: string) => Promise<void> } = {}) {
    const { broker, calls } = fakeBroker();
    const sent: Array<{ chatId: string; text: string }> = [];
    const svc = new PauseService({
      broker,
      file: join(dir, "pause.json"),
      chatsWithProcesses: async () => ["a", "z"],
      killChat: overrides.killChat ?? (async () => {}),
      send: async (chatId, text) => {
        // The note must be sent while still paused so it queues, not starts.
        expect(broker.pause).toBeDefined();
        sent.push({ chatId, text });
      },
      now: () => 5 * 60_000,
    });
    return { svc, broker, calls, sent };
  }

  it("persists the pause so a restart cannot silently lift it", async () => {
    const { svc } = make();
    await svc.pause();
    expect(JSON.parse(await readFile(join(dir, "pause.json"), "utf8"))).toMatchObject({
      interrupted: ["a", "b"],
    });

    const next = make();
    await next.svc.restore();
    expect(next.calls).toEqual(["restore"]);
    expect(next.broker.pause?.interrupted).toEqual(["a", "b"]);
  });

  it("a second Resume while the first is still sending joins it instead of re-sending every note", async () => {
    const { svc, sent } = make();
    await svc.pause();
    const [a, b] = await Promise.all([svc.resume(), svc.resume()]);
    expect(a).toBe(b);
    expect(sent.map((s) => s.chatId)).toEqual(["a", "b"]);
  });

  it("refuses to kill processes unless paused", async () => {
    const killChat = vi.fn(async () => {});
    const { svc } = make({ killChat });
    await expect(svc.killProcesses()).rejects.toThrow("not paused");
    expect(killChat).not.toHaveBeenCalled();
  });

  it("on resume notes only the interrupted chats, says shells must restart, then reopens with them first", async () => {
    const { svc, calls, sent } = make();
    await svc.pause();
    await svc.killProcesses();
    const { notified } = await svc.resume();

    expect(notified).toEqual(["a", "b"]);
    expect(sent.map((s) => s.chatId)).toEqual(["a", "b"]);
    // "a" had its processes killed; "b" did not — both are told about shells.
    expect(sent[0]!.text).toMatch(/processes were killed/);
    expect(sent[1]!.text).toMatch(/restart existing shells/);
    expect(sent[0]!.text).toMatch(/about 5 minutes/);
    expect(calls.at(-1)).toBe("resumeAll:a,b");
    expect(JSON.parse(await readFile(join(dir, "pause.json"), "utf8"))).toBeNull();
  });

  it("one chat whose note fails does not keep the rest paused", async () => {
    const { broker, calls } = fakeBroker();
    const svc = new PauseService({
      broker,
      file: join(dir, "pause.json"),
      chatsWithProcesses: async () => [],
      killChat: async () => {},
      send: async (chatId) => {
        if (chatId === "a") throw new Error("chat gone");
      },
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await svc.pause();
    expect((await svc.resume()).notified).toEqual(["b"]);
    expect(calls.at(-1)).toBe("resumeAll:b");
    expect(broker.pause).toBeUndefined();
    err.mockRestore();
  });
});
