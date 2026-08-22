/**
 * The IN-PAGE notification path — the one a desktop actually uses.
 *
 * A push only reaches this machine when the app isn't running; with a Dispatch
 * window open in the background every toast comes from here instead. So the
 * consolidation rules have to hold in both places, and this suite is the mirror
 * of swPush.test.ts for the half that runs in the page.
 *
 * The stores read `Notification.permission` at module-eval time, so every global
 * has to be in place before the import — hence the dynamic import in `load()`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AttentionItem } from "@dispatch/shared";

interface FakeNotification {
  title: string;
  options: Record<string, unknown>;
}

function stubEnvironment(options: { inFront?: boolean } = {}) {
  let tray: FakeNotification[] = [];

  const registration = {
    showNotification: vi.fn(async (title: string, opts: Record<string, unknown> = {}) => {
      tray.push({ title, options: opts });
    }),
    getNotifications: vi.fn(async ({ tag }: { tag?: string } = {}) =>
      tray
        .filter((n) => !tag || n.options.tag === tag)
        .map((n) => ({
          close: () => {
            tray = tray.filter((x) => x !== n);
          },
        })),
    ),
  };

  const Notification = function () {} as unknown as typeof globalThis.Notification;
  Object.defineProperty(Notification, "permission", { value: "granted", configurable: true });

  const store = new Map<string, string>();
  Object.assign(globalThis, {
    window: { isSecureContext: true, focus: () => {}, Notification },
    Notification,
    document: {
      visibilityState: options.inFront ? "visible" : "hidden",
      hasFocus: () => !!options.inFront,
    },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  // Node exposes `navigator` as a getter-only global, so it has to be redefined
  // rather than assigned.
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: { getRegistration: async () => registration },
      setAppBadge: vi.fn(async () => {}),
      clearAppBadge: vi.fn(async () => {}),
    },
  });

  return { tray: () => tray, registration };
}

async function load() {
  vi.resetModules();
  return import("./browserNotify.js");
}

function attn(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "a1",
    chatId: "c1",
    kind: "permission",
    summary: "Run `rm -rf`?",
    createdAt: 1,
    ...over,
  };
}

describe("in-page attention notifications", () => {
  let env: ReturnType<typeof stubEnvironment>;
  beforeEach(() => {
    env = stubEnvironment();
  });

  it("tags by chat, the same way the worker does, and updates silently", async () => {
    const { notifyAttention } = await load();
    await notifyAttention(attn({ id: "a1" }), "Fix the parser", 1);
    await notifyAttention(attn({ id: "a2", kind: "question" }), "Fix the parser", 2);

    // The browser is what collapses same-tag notifications, so this asserts the
    // tag rather than the tray depth: both paths must agree on it, or a desktop
    // that gets a push AND has the page open shows the same thing twice.
    expect(env.tray().map((n) => n.options.tag)).toEqual(["chat:c1", "chat:c1"]);
    expect(env.tray()[1]!.title).toBe("Question — Fix the parser (+1 more)");
    // Replacing must not buzz again for something already announced.
    expect(env.tray()[1]!.options.renotify).toBe(false);
  });

  it("omits the suffix when the chat has exactly one item", async () => {
    const { notifyAttention } = await load();
    await notifyAttention(attn(), "Fix the parser", 1);
    expect(env.tray()[0]!.title).toBe("Permission needed — Fix the parser");
  });

  it("stays quiet while you are looking at the app", async () => {
    env = stubEnvironment({ inFront: true });
    const { notifyAttention } = await load();
    await notifyAttention(attn(), "Fix the parser", 1);
    expect(env.tray()).toHaveLength(0);
  });

  it("withdraws the toast when the chat has nothing left", async () => {
    const { notifyAttention, syncChatNotification } = await load();
    await notifyAttention(attn(), "Fix the parser", 1);
    expect(env.tray()).toHaveLength(1);
    // The permission got answered — in this window, or in another one.
    await syncChatNotification("c1", [], "Fix the parser");
    expect(env.tray()).toHaveLength(0);
  });

  it("corrects the count instead of withdrawing when items remain", async () => {
    const { notifyAttention, syncChatNotification } = await load();
    await notifyAttention(attn({ id: "a1" }), "Fix the parser", 2);
    expect(env.tray()[0]!.title).toBe("Permission needed — Fix the parser (+1 more)");

    const remaining = [attn({ id: "a2", kind: "question" })];
    await syncChatNotification("c1", remaining, "Fix the parser");
    expect(env.tray()).toHaveLength(1);
    expect(env.tray()[0]!.title).toBe("Question — Fix the parser");
  });

  it("NEVER conjures a toast for a chat that had none", async () => {
    // Resolving something in a chat you had already cleared (or were never
    // notified about) must not put a notification on screen announcing that
    // there is nothing to see.
    const { syncChatNotification } = await load();
    await syncChatNotification("c1", [attn({ id: "a2" })], "Fix the parser");
    expect(env.tray()).toHaveLength(0);
  });

  it("withdrawing one chat leaves another chat's toast alone", async () => {
    const { notifyAttention, syncChatNotification } = await load();
    await notifyAttention(attn({ chatId: "c1" }), "One", 1);
    await notifyAttention(attn({ chatId: "c2" }), "Two", 1);
    await syncChatNotification("c1", []);
    expect(env.tray().map((n) => n.options.tag)).toEqual(["chat:c2"]);
  });

  it("sets and clears the app badge", async () => {
    const { setAttentionBadge } = await load();
    await setAttentionBadge(3);
    expect(navigator.setAppBadge).toHaveBeenCalledWith(3);
    await setAttentionBadge(0);
    expect(navigator.clearAppBadge).toHaveBeenCalled();
  });
});
