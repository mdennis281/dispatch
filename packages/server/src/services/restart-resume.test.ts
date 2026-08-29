import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, MessagePart, WsServerEvent } from "@dispatch/shared";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import { RestartResumeService, RESUME_MAX_AGE_MS } from "./restart-resume.js";

describe("RestartResumeService", () => {
  let dir: string;
  let store: Store;
  let bus: EventBus;
  let timers: { id: number; fn: () => void; ms: number }[];
  let clock: number;
  let sent: { chatId: string; text: string; parts?: MessagePart[] }[];
  let interrupted: string[];
  let events: WsServerEvent[];
  let sendFails: string | null;
  let sha: string | undefined;

  const NOW = Date.parse("2026-08-01T18:00:00.000Z");

  function makeService() {
    let nextId = 1;
    return new RestartResumeService({
      store,
      bus,
      send: async (chatId, text, parts) => {
        if (sendFails) throw new Error(sendFails);
        sent.push({ chatId, text, parts });
      },
      interrupt: async (chatId) => {
        interrupted.push(chatId);
      },
      deps: {
        now: () => clock,
        setTimer: (fn, ms) => {
          const id = nextId++;
          timers.push({ id, fn, ms });
          return id;
        },
        clearTimer: (h) => {
          timers = timers.filter((t) => t.id !== h);
        },
        genId: () => `n${nextId++}`,
        readSha: () => sha,
      },
    });
  }

  /** Fire every armed timer and let the boot pass land. */
  async function tick(s: RestartResumeService) {
    const due = timers;
    timers = [];
    for (const t of due) t.fn();
    await s.drain();
  }

  function chat(id: string, over: Partial<Chat> = {}): Chat {
    return {
      id,
      projectId: "p1",
      title: `Chat ${id}`,
      modeId: "auto",
      effort: "medium",
      worktrees: [],
      prs: [],
      sessionId: `sess-${id}`,
      createdAt: NOW - 600_000,
      ...over,
    };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cm-restart-resume-"));
    store = new Store(dir);
    bus = new EventBus();
    timers = [];
    clock = NOW;
    sent = [];
    interrupted = [];
    events = [];
    sendFails = null;
    sha = "aaaaaaa";
    bus.subscribe((e) => events.push(e));
  });

  afterEach(() => {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------- capture */

  it("records only the chats that were mid-flight, with their undelivered messages", async () => {
    await store.saveChat(chat("a"));
    await store.saveChat(chat("b"));
    await store.saveChat(chat("c"));
    const svc = makeService();

    await svc.capture([
      { chatId: "a", status: "running", pending: ["finish the migration"] },
      { chatId: "b", status: "idle", pending: [] },
      { chatId: "c", status: "queued", pending: ["start on the docs"] },
    ]);

    expect((await store.getChat("a"))?.interruption).toMatchObject({
      at: NOW,
      status: "running",
      pending: ["finish the migration"],
      sha: "aaaaaaa",
    });
    // `idle` was not doing anything to continue.
    expect((await store.getChat("b"))?.interruption).toBeUndefined();
    // `queued` never started a turn, so its outbox is the whole ask.
    expect((await store.getChat("c"))?.interruption?.pending).toEqual(["start on the docs"]);
  });

  it("skips archived chats — somebody already decided that work is over", async () => {
    await store.saveChat(chat("a", { archived: true }));
    const svc = makeService();
    await svc.capture([{ chatId: "a", status: "running", pending: [] }]);
    expect((await store.getChat("a"))?.interruption).toBeUndefined();
  });

  it("records nothing on a source checkout, where there is no sha either side", async () => {
    sha = undefined;
    await store.saveChat(chat("a"));
    const svc = makeService();
    await svc.capture([{ chatId: "a", status: "running", pending: [] }]);
    const rec = (await store.getChat("a"))?.interruption;
    expect(rec).toBeDefined();
    expect(rec?.sha).toBeUndefined();
  });

  /* --------------------------------------------------------------- boot */

  it("continues an interrupted chat and stamps the record settled", async () => {
    await store.saveChat(chat("a"));
    const capture = makeService();
    await capture.capture([{ chatId: "a", status: "running", pending: [] }]);

    // A new build is running now — the same shutdown, a different sha.
    sha = "bbbbbbb";
    const svc = makeService();
    svc.restore();
    // Nothing may run before the server is listening.
    expect(sent).toHaveLength(0);
    await tick(svc);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe("a");
    expect(sent[0]!.text).toContain("Dispatch was updated");
    // Authored by Dispatch, not by the human: a lone `brief`, never bare text.
    expect(sent[0]!.parts?.[0]).toMatchObject({ kind: "brief" });

    const rec = (await store.getChat("a"))?.interruption;
    expect(rec?.settledAt).toBe(NOW);
    expect(rec?.settledAs).toBe("resumed");
    expect(svc.status()).toMatchObject({
      cause: "update",
      resumed: [{ chatId: "a", title: "Chat a", was: "running" }],
      needsInput: [],
    });
  });

  it("says 'restart', not 'update', when the sha did not change", async () => {
    await store.saveChat(chat("a"));
    const capture = makeService();
    await capture.capture([{ chatId: "a", status: "running", pending: [] }]);

    const svc = makeService(); // same sha
    svc.restore();
    await tick(svc);

    expect(svc.status()?.cause).toBe("restart");
    expect(sent[0]!.text).toContain("The Dispatch server was restarted");
  });

  it("replays the human's undelivered message AS THEIRS instead of a canned prompt", async () => {
    await store.saveChat(chat("a"));
    const capture = makeService();
    await capture.capture([
      { chatId: "a", status: "running", pending: ["actually, use the other branch"] },
    ]);

    const svc = makeService();
    svc.restore();
    await tick(svc);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe("actually, use the other branch");
    // No `brief` — attributing the human's own words to Dispatch would put them
    // in the wrong speech bubble.
    expect(sent[0]!.parts).toBeUndefined();
  });

  it("does NOT resume a chat that was blocked on a human, and raises attention", async () => {
    await store.saveChat(chat("a"));
    const capture = makeService();
    await capture.capture([{ chatId: "a", status: "awaiting-input", pending: [] }]);

    const svc = makeService();
    svc.restore();
    await tick(svc);

    expect(sent).toHaveLength(0);
    expect((await store.getChat("a"))?.interruption?.settledAs).toBe("needs-input");
    const attention = events.find((e) => e.type === "attention-add");
    expect(attention).toMatchObject({ item: { chatId: "a", kind: "question" } });
    expect(svc.status()).toMatchObject({ resumed: [], needsInput: [{ chatId: "a" }] });
  });

  it("never replays a record a previous boot already settled", async () => {
    await store.saveChat(chat("a"));
    const capture = makeService();
    await capture.capture([{ chatId: "a", status: "running", pending: [] }]);

    const first = makeService();
    first.restore();
    await tick(first);
    expect(sent).toHaveLength(1);

    // Second boot, same records on disk.
    const second = makeService();
    second.restore();
    await tick(second);
    expect(sent).toHaveLength(1);
    expect(second.status()).toBeNull();
  });

  it("leaves a stale interruption alone rather than resuming a day-old turn", async () => {
    await store.saveChat(chat("a"));
    const capture = makeService();
    await capture.capture([{ chatId: "a", status: "running", pending: ["hi"] }]);

    clock = NOW + RESUME_MAX_AGE_MS + 1;
    const svc = makeService();
    svc.restore();
    await tick(svc);

    expect(sent).toHaveLength(0);
    expect((await store.getChat("a"))?.interruption?.settledAs).toBe("skipped");
    expect(svc.status()).toBeNull();
  });

  it("skips a chat with no session to resume into and nothing of the human's to replay", async () => {
    await store.saveChat(chat("a", { sessionId: undefined }));
    const capture = makeService();
    await capture.capture([{ chatId: "a", status: "running", pending: [] }]);

    const svc = makeService();
    svc.restore();
    await tick(svc);

    expect(sent).toHaveLength(0);
    expect((await store.getChat("a"))?.interruption?.settledAs).toBe("skipped");
  });

  it("still delivers a pending message when there is no session id", async () => {
    await store.saveChat(chat("a", { sessionId: undefined }));
    const capture = makeService();
    await capture.capture([{ chatId: "a", status: "queued", pending: ["do the thing"] }]);

    const svc = makeService();
    svc.restore();
    await tick(svc);

    expect(sent.map((s) => s.text)).toEqual(["do the thing"]);
  });

  it("settles a failed send as `failed` rather than leaving it to fire again", async () => {
    await store.saveChat(chat("a"));
    const capture = makeService();
    await capture.capture([{ chatId: "a", status: "running", pending: [] }]);

    sendFails = "no such worktree";
    const svc = makeService();
    svc.restore();
    await tick(svc);

    expect((await store.getChat("a"))?.interruption?.settledAs).toBe("failed");
    expect(svc.status()).toBeNull();
    // The transcript says why, rather than the chat simply sitting there.
    const notice = events
      .filter((e) => e.type === "chat-message")
      .map((e) => (e as { message: { text?: string } }).message.text ?? "");
    expect(notice.some((t) => t.includes("no such worktree"))).toBe(true);
  });

  it("resumes several chats without dropping any", async () => {
    for (const id of ["a", "b", "c"]) await store.saveChat(chat(id));
    const capture = makeService();
    await capture.capture([
      { chatId: "a", status: "running", pending: [] },
      { chatId: "b", status: "waiting", pending: [] },
      { chatId: "c", status: "awaiting-input", pending: [] },
    ]);

    const svc = makeService();
    svc.restore();
    await tick(svc);

    expect(sent.map((s) => s.chatId).sort()).toEqual(["a", "b"]);
    expect(svc.status()?.resumed.map((r) => r.chatId).sort()).toEqual(["a", "b"]);
    expect(svc.status()?.needsInput.map((r) => r.chatId)).toEqual(["c"]);
  });

  /* -------------------------------------------------------------- undo */

  it("the undo interrupts every resumed turn and clears the banner", async () => {
    for (const id of ["a", "b"]) await store.saveChat(chat(id));
    const capture = makeService();
    await capture.capture([
      { chatId: "a", status: "running", pending: [] },
      { chatId: "b", status: "awaiting-input", pending: [] },
    ]);

    const svc = makeService();
    svc.restore();
    await tick(svc);

    const stopped = await svc.stopResumed();
    // Only what we started. `b` was never resumed, so there is nothing of ours
    // to take back from it.
    expect(stopped).toEqual(["a"]);
    expect(interrupted).toEqual(["a"]);
    expect(svc.status()).toBeNull();
  });

  it("dismiss hides the banner and announces it", async () => {
    await store.saveChat(chat("a"));
    const capture = makeService();
    await capture.capture([{ chatId: "a", status: "running", pending: [] }]);
    const svc = makeService();
    svc.restore();
    await tick(svc);
    expect(svc.status()).not.toBeNull();

    events.length = 0;
    svc.dismiss();
    expect(svc.status()).toBeNull();
    expect(events.some((e) => e.type === "restart-resume")).toBe(true);
  });

  /* ------------------------------------------------------------ safety */

  it("a crash leaves no record, so boot resumes nothing", async () => {
    // No `capture()` at all — this is precisely what a hard kill looks like.
    await store.saveChat(chat("a", { status: "running" }));
    const svc = makeService();
    svc.restore();
    await tick(svc);

    expect(sent).toHaveLength(0);
    expect(svc.status()).toBeNull();
  });

  it("a disposed service never fires an armed pass", async () => {
    await store.saveChat(chat("a"));
    const capture = makeService();
    await capture.capture([{ chatId: "a", status: "running", pending: [] }]);

    const svc = makeService();
    svc.restore();
    svc.dispose();
    await tick(svc);

    expect(sent).toHaveLength(0);
    expect((await store.getChat("a"))?.interruption?.settledAt).toBeUndefined();
  });
});
