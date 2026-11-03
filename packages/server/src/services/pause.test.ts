import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PauseState } from "@dispatch/shared";
import { PauseService } from "./pause.js";
import type { SessionBroker } from "./session-broker.js";

/** The slice of the broker the service drives, with the pause it would hold. */
function fakeBroker() {
  let state: PauseState | undefined;
  let projects: Record<string, PauseState> = {};
  let chats: Record<string, PauseState> = {};
  const calls: string[] = [];
  const broker = {
    get pause() {
      return state;
    },
    get projectPauseStates() {
      return projects;
    },
    restorePause: (s: PauseState) => {
      state = s;
      calls.push("restore");
    },
    restoreProjectPauses: (p: Record<string, PauseState>) => {
      projects = p;
      calls.push(`restoreProjects:${Object.keys(p).join(",")}`);
    },
    pauseProject: async (id: string, onArmed?: (s: PauseState) => Promise<void>) => {
      const s = { since: 0, interrupted: [`${id}-chat`] };
      projects = { ...projects, [id]: s };
      await onArmed?.(s);
      return s;
    },
    resumeProject: (id: string, first: string[]) => {
      const { [id]: _, ...rest } = projects;
      projects = rest;
      calls.push(`resumeProject:${id}:${first.join(",")}`);
    },
    get chatPauseStates() {
      return chats;
    },
    restoreChatPauses: (c: Record<string, PauseState>) => {
      chats = c;
      calls.push(`restoreChats:${Object.keys(c).join(",")}`);
    },
    pauseChat: async (id: string, onArmed?: (s: PauseState) => Promise<void>) => {
      const s = { since: 0, interrupted: [id] };
      chats = { ...chats, [id]: s };
      await onArmed?.(s);
      return s;
    },
    resumeChat: (id: string, first: string[]) => {
      const { [id]: _, ...rest } = chats;
      chats = rest;
      calls.push(`resumeChat:${id}:${first.join(",")}`);
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
    schedulerSnapshot: () => ({ paused: state ?? null, projectPauses: projects, chatPauses: chats, cap: 4, lent: 0, running: [], queued: [] }),
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
        expect(
          broker.pause ??
            Object.keys(broker.projectPauseStates)[0] ??
            Object.keys(broker.chatPauseStates)[0],
        ).toBeDefined();
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
      global: { interrupted: ["a", "b"] },
      projects: {},
    });

    const next = make();
    await next.svc.restore();
    expect(next.calls).toEqual(["restore", "restoreProjects:", "restoreChats:"]);
    expect(next.broker.pause?.interrupted).toEqual(["a", "b"]);
  });

  it("still restores a pause file written before per-project pauses existed", async () => {
    await writeFile(join(dir, "pause.json"), JSON.stringify({ since: 1, interrupted: ["x"] }));
    const { svc, broker, calls } = make();
    await svc.restore();
    expect(calls).toEqual(["restore"]);
    expect(broker.pause?.interrupted).toEqual(["x"]);
  });

  it("project and chat pauses persist beside the global one, and resume-all lifts only them", async () => {
    const { svc, broker, calls, sent } = make();
    await svc.pauseProject("p1");
    await svc.pauseProject("p2");
    await svc.pauseChat("c9");
    await svc.pause();
    const onDisk = JSON.parse(await readFile(join(dir, "pause.json"), "utf8"));
    expect(Object.keys(onDisk.projects)).toEqual(["p1", "p2"]);
    expect(Object.keys(onDisk.chats)).toEqual(["c9"]);
    expect(onDisk.global.interrupted).toEqual(["a", "b"]);

    const { notified } = await svc.resumeAllScoped();
    expect(notified.sort()).toEqual(["c9", "p1-chat", "p2-chat"]);
    expect(sent.find((s) => s.chatId === "p1-chat")!.text).toMatch(/paused agent work in this project/);
    expect(sent.find((s) => s.chatId === "c9")!.text).toMatch(/paused this chat/);
    expect(calls).toContain("resumeProject:p1:p1-chat");
    expect(calls).toContain("resumeChat:c9:c9");
    expect(broker.pause).toBeDefined();
    expect(JSON.parse(await readFile(join(dir, "pause.json"), "utf8"))).toMatchObject({
      global: { interrupted: ["a", "b"] },
      projects: {},
      chats: {},
    });
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
    expect(JSON.parse(await readFile(join(dir, "pause.json"), "utf8"))).toEqual({
      global: null,
      projects: {},
      chats: {},
    });
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
