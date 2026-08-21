import { describe, it, expect, vi } from "vitest";
import type { WsServerEvent } from "@dispatch/shared";
import type { ServerConfig } from "../config.js";
import type { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
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
});
