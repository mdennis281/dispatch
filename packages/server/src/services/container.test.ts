import { describe, it, expect, vi } from "vitest";
import type { Chat, PeerSender, WsServerEvent } from "@dispatch/shared";
import type { ServerConfig } from "../config.js";
import type { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import type { SpawnChatRequest } from "./mcp/manager-mcp.js";
import {
  createServices,
  recoverInterruptedChatStatuses,
  type ServiceOverrides,
} from "./container.js";

/**
 * A stub whose every accessed member is an async no-op function, EXCEPT the
 * members supplied in `extra` (so a test can make one method throw or spy on it).
 * Returning a resolved promise keeps `await svc.start().catch(...)` call sites
 * happy regardless of which method boot invokes.
 */
function stub<T = unknown>(extra: Record<string, unknown> = {}): T {
  return new Proxy(extra, {
    get: (target, prop) =>
      typeof prop === "string" && prop in target
        ? (target as Record<string, unknown>)[prop]
        : () => Promise.resolve(),
  }) as T;
}

describe("createServices().start() resilience", () => {
  it("marks live statuses left by a killed process as errors on restart", async () => {
    const patchChat = vi.fn(async () => null);
    const store = stub<Store>({
      listChats: async () => [
        { id: "running", status: "running" },
        { id: "waiting", status: "waiting" },
        { id: "idle", status: "idle" },
        { id: "done", status: "done" },
      ],
      patchChat,
    });

    await recoverInterruptedChatStatuses(store);

    expect(patchChat).toHaveBeenCalledTimes(2);
    expect(patchChat).toHaveBeenCalledWith("running", { status: "error" });
    expect(patchChat).toHaveBeenCalledWith("waiting", { status: "error" });
  });

  it("still wires the AI-title trigger when a best-effort service throws on start", async () => {
    const bus = new EventBus();
    const maybeGenerateInitialTitle = vi.fn(async () => {});

    // usage.start() blows up — the failure must NOT abort boot and skip the
    // title-trigger wiring that runs after it.
    const overrides: ServiceOverrides = {
      broker: stub(),
      terminals: stub(),
      memory: stub(),
      projectConfig: stub(),
      projectConfigArchive: stub(),
      title: stub({ maybeGenerateInitialTitle }),
      checkpoints: stub(),
      worktrees: stub(),
      worktreeDetector: stub(),
      worktreeReaper: stub(),
      runner: stub(),
      github: stub(),
      notifier: stub(),
      // Stubbed like the rest: the real PushService resolves its two file paths
      // from `config`, and this test's config is a bare `{ maxActiveSessions }`.
      push: stub(),
      attention: stub(),
      usage: stub({
        start: () => {
          throw new Error("usage boom");
        },
      }),
    };

    // Silence the expected "usage.start() failed" console.error the guard logs.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const services = createServices(
      { config: { maxActiveSessions: 4 } as unknown as ServerConfig, store: stub<Store>(), bus },
      overrides,
    );

    // Boot must resolve despite the throwing service.
    await expect(services.start()).resolves.toBeUndefined();

    // The title trigger is wired: a first user message drives title generation.
    bus.publish({
      type: "chat-message",
      chatId: "c1",
      message: { id: "m1", chatId: "c1", ts: 1, kind: "user", text: "hi" },
    } as unknown as WsServerEvent);

    expect(maybeGenerateInitialTitle).toHaveBeenCalledWith("c1");
    // The failure was surfaced (logged), not swallowed silently.
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it("applies the SAVED concurrency cap at boot, over the env default", async () => {
    // `createServices` is synchronous and the setting lives behind an async store
    // read, so the broker is constructed on the env default and corrected here.
    // start() runs before the server listens, so nothing can be admitted against
    // the wrong number in between.
    const bus = new EventBus();
    const setCap = vi.fn();
    const services = createServices(
      {
        config: { maxActiveSessions: 4 } as unknown as ServerConfig,
        store: stub<Store>({
          getSettings: async () => ({ theme: "dark", maxActiveSessions: 9 }),
        }),
        bus,
      },
      {
        broker: stub({ setCap }),
        terminals: stub(),
        memory: stub(),
        projectConfig: stub(),
        projectConfigArchive: stub(),
        title: stub(),
        checkpoints: stub(),
        worktrees: stub(),
        worktreeDetector: stub(),
        worktreeReaper: stub(),
        runner: stub(),
        github: stub(),
        notifier: stub(),
        push: stub(),
        attention: stub(),
        usage: stub(),
      },
    );

    await services.start();

    expect(setCap).toHaveBeenCalledWith(9);
  });

  it("captures interruptions BEFORE the broker tears the sessions down", async () => {
    // The whole feature rests on this ordering, and no unit test of the service
    // can see it: `broker.dispose()` overwrites every status with `done` and
    // empties every outbox, so a capture that runs one line later reads an empty
    // snapshot and auto-resume is silently dead. Assert the sequence itself.
    const order: string[] = [];
    const capture = vi.fn(async (_live: unknown) => 1);
    const services = createServices(
      {
        config: { maxActiveSessions: 4 } as unknown as ServerConfig,
        store: stub<Store>(),
        bus: new EventBus(),
      },
      {
        broker: stub({
          interruptionSnapshot: () => {
            order.push("snapshot");
            return [{ chatId: "c1", status: "running", pending: [{ text: "keep going" }] }];
          },
          dispose: async () => {
            order.push("broker.dispose");
          },
        }),
        restartResume: stub({
          dispose: () => order.push("restartResume.dispose"),
          drain: async () => {},
          capture: async (live: unknown) => {
            order.push("capture");
            return capture(live);
          },
        }),
        terminals: stub(),
        memory: stub(),
        projectConfig: stub(),
        projectConfigArchive: stub(),
        title: stub(),
        checkpoints: stub(),
        worktrees: stub(),
        worktreeDetector: stub(),
        worktreeReaper: stub(),
        runner: stub(),
        github: stub(),
        notifier: stub(),
        push: stub(),
        attention: stub(),
        usage: stub(),
      },
    );

    await services.dispose();

    expect(order).toEqual([
      // Our own boot timer is disarmed first: a shutdown seconds after boot must
      // not fire a resume into a server that is going away.
      "restartResume.dispose",
      "snapshot",
      "capture",
      "broker.dispose",
    ]);
    // And it received the live sessions, not an empty list.
    expect(capture).toHaveBeenCalledWith([
      { chatId: "c1", status: "running", pending: [{ text: "keep going" }] },
    ]);
  });
});

/**
 * A spawned chat's opening prompt is written by an AGENT, not by the human — the
 * human only approved the spawn. Unstamped it landed as the new chat's opening
 * SPEECH BUBBLE, the most prominent row in a transcript that had nothing else in
 * it, attributed to someone who never typed a word of it. The `peer` stamp is
 * what the transcript renders a card from, and what `peerReminder` tells the
 * model it heard from a colleague.
 */
describe("broker.spawnChat attribution", () => {
  const PARENT = "parent_chat";

  async function spawn(
    parent: Partial<Chat> | null,
    request: SpawnChatRequest = {
      prompt: "Migrate the cloud save slots.",
      title: "save migration",
    },
  ) {
    // Typed args, not `vi.fn(async () => {})`: an inferred empty tuple makes
    // every `mock.calls[0][n]` read a type error.
    const sendMessage =
      vi.fn(async (_chatId: string, _text: string, _opts?: { peer?: PeerSender }) => {});
    const saved: Chat[] = [];
    const services = createServices(
      {
        config: { maxActiveSessions: 4 } as unknown as ServerConfig,
        store: stub<Store>({
          getProject: async () => ({ id: "p1", name: "Hivebreak" }),
          getSettings: async () => ({}),
          saveChat: async (c: Chat) => {
            saved.push(c);
            return c;
          },
          // Two callers with different needs: `ensureSession` looks up the chat
          // just created, the peer stamp looks up its parent.
          getChat: async (id: string) =>
            id === PARENT ? parent : (saved.find((c) => c.id === id) ?? null),
        }),
        bus: new EventBus(),
      },
      {
        // `has: true` so `ensureSession` short-circuits instead of trying to
        // start a real subprocess.
        broker: stub({ has: () => true, sendMessage }),
        terminals: stub(),
        memory: stub(),
        projectConfig: stub(),
        projectConfigArchive: stub(),
        title: stub(),
        checkpoints: stub(),
        worktrees: stub(),
        worktreeDetector: stub(),
        worktreeReaper: stub(),
        runner: stub(),
        github: stub(),
        notifier: stub(),
        push: stub(),
        attention: stub(),
        usage: stub(),
      },
    );
    await services.broker.spawnChat!({
      request,
      project: { id: "p1", name: "Hivebreak" },
      parentChatId: PARENT,
    });
    return { sendMessage, saved };
  }

  it("stamps the opening prompt as coming from the chat that spawned it", async () => {
    const { sendMessage } = await spawn({
      id: PARENT,
      title: "Steam cloud save",
      projectId: "hivebreak",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![1]).toBe("Migrate the cloud save slots.");
    expect(sendMessage.mock.calls[0]![2]).toEqual({
      // Denormalised, per PeerSenderSchema: the parent may be renamed or deleted
      // before anyone reads the row, and a transcript can't be rewritten.
      peer: { chatId: PARENT, title: "Steam cloud save", projectId: "hivebreak" },
    });
  });

  it("still stamps the sender when the parent can no longer be read", async () => {
    // An unreadable parent must cost the row its TITLE, never its attribution —
    // falling back to an unstamped send would put the words back in the human's
    // mouth for the one case nobody can check afterwards.
    const { sendMessage } = await spawn(null);

    expect(sendMessage.mock.calls[0]![2]).toEqual({
      peer: { chatId: PARENT, title: undefined, projectId: undefined },
    });
  });

  it("inherits the parent chat's current provider and model by default", async () => {
    const { saved } = await spawn({
      id: PARENT,
      title: "Review repair",
      projectId: "hivebreak",
      harness: "codex",
      model: "gpt-5.6-sol",
    });

    expect(saved[0]).toMatchObject({
      harness: "codex",
      model: "gpt-5.6-sol",
    });
  });

  it("does not carry a model across an explicit provider change", async () => {
    const { saved } = await spawn(
      {
        id: PARENT,
        title: "Review repair",
        projectId: "hivebreak",
        harness: "claude",
        model: "claude-opus-5",
      },
      {
        prompt: "Fix PR #54.",
        title: "PR #54",
        provider: "codex",
      },
    );

    expect(saved[0]).toMatchObject({ harness: "codex" });
    expect(saved[0]?.model).toBeUndefined();
  });

  it("creates the child on the explicitly selected provider and model", async () => {
    const { saved } = await spawn(
      { id: PARENT, title: "Review repair", projectId: "hivebreak" },
      {
        prompt: "Fix PR #54.",
        title: "PR #54",
        provider: "codex",
        model: "gpt-5.6-sol",
      },
    );

    expect(saved[0]).toMatchObject({
      harness: "codex",
      model: "gpt-5.6-sol",
    });
  });
});
