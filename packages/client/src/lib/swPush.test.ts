/**
 * The service worker's push handler, exercised for real.
 *
 * `public/sw.js` is the only code that runs when the app is closed, and it is
 * the one file no other suite can reach: it lives outside the TS build, it never
 * registers in dev (main.tsx gates registration on PROD), and notifications
 * render outside the page so a browser test cannot see them either. So it is
 * loaded here as source, evaluated against a fake `self`, and driven directly.
 *
 * Two of these guard invariants whose failure is invisible until days later:
 * stacking on iOS (because WebKit ignores `tag`), and a push that displays
 * nothing on an Apple endpoint (which costs the subscription outright).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SW_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../public/sw.js"),
  "utf8",
);

interface FakeNotification {
  title: string;
  options: Record<string, unknown>;
  close: () => void;
}

/**
 * Evaluate sw.js against a stand-in `self` and return a harness that can fire a
 * push at it and inspect the resulting tray.
 */
function loadWorker(options: { endpoint?: string } = {}) {
  const endpoint = options.endpoint ?? "https://fcm.googleapis.com/fcm/send/x";
  /** The device's notification tray, keyed the way a real one is: by tag. */
  let tray: FakeNotification[] = [];
  const badge: Array<number | "cleared"> = [];
  const listeners = new Map<string, (event: unknown) => void>();

  const registration = {
    showNotification: vi.fn(async (title: string, opts: Record<string, unknown> = {}) => {
      const n: FakeNotification = {
        title,
        options: opts,
        close: () => {
          tray = tray.filter((x) => x !== n);
        },
      };
      tray.push(n);
    }),
    getNotifications: vi.fn(async ({ tag }: { tag?: string } = {}) =>
      tray.filter((n) => !tag || n.options.tag === tag),
    ),
    pushManager: { getSubscription: async () => ({ endpoint }) },
  };

  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    registration,
    location: { origin: "https://dispatch.test" },
    navigator: {
      setAppBadge: vi.fn(async (n: number) => void badge.push(n)),
      clearAppBadge: vi.fn(async () => void badge.push("cleared")),
    },
    clients: { matchAll: async () => [], openWindow: async () => undefined },
    skipWaiting: () => {},
  };

  // The handlers reference these lazily; nothing here is touched at eval time.
  const evaluate = new Function(
    "self",
    "caches",
    "fetch",
    "atob",
    "Headers",
    "Request",
    "Response",
    "URL",
    "setTimeout",
    SW_SOURCE,
  );
  evaluate(self, {}, async () => ({}), () => "", Headers, Request, Response, URL, setTimeout);

  /** Fire a push and wait for whatever the handler passed to `waitUntil`. */
  async function push(payload: unknown): Promise<void> {
    const handler = listeners.get("push");
    if (!handler) throw new Error("sw.js registered no push listener");
    let held: Promise<unknown> = Promise.resolve();
    handler({
      data: { json: () => payload },
      waitUntil: (p: Promise<unknown>) => {
        held = p;
      },
    });
    await held;
  }

  return { push, badge, tray: () => tray, registration };
}

/** A payload shaped like PushService.payloadFor (see services/push.ts). */
function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a1",
    chatId: "c1",
    kind: "permission",
    title: "Permission needed",
    body: "Run `rm -rf`?",
    sticky: true,
    outstanding: 1,
    badge: 1,
    ...over,
  };
}

describe("sw.js push handler", () => {
  let sw: ReturnType<typeof loadWorker>;
  beforeEach(() => {
    sw = loadWorker();
  });

  it("keeps ONE notification per chat instead of stacking", async () => {
    await sw.push(payload({ id: "a1", outstanding: 1 }));
    await sw.push(payload({ id: "a2", outstanding: 2, title: "Question" }));
    await sw.push(payload({ id: "a3", outstanding: 3, title: "Task done" }));

    // The whole point: three events in one chat, one row in the tray. This is
    // what `tag` does on Chrome and what iOS refuses to do, which is why the
    // handler closes the old one by hand rather than trusting the tag.
    expect(sw.tray()).toHaveLength(1);
    expect(sw.tray()[0]!.options.tag).toBe("chat:c1");
  });

  it("says how many are waiting behind the one it shows", async () => {
    await sw.push(payload({ outstanding: 1 }));
    expect(sw.tray()[0]!.title).toBe("Permission needed");
    await sw.push(payload({ outstanding: 3 }));
    expect(sw.tray()[0]!.title).toBe("Permission needed (+2 more)");
  });

  it("keeps different chats apart", async () => {
    await sw.push(payload({ chatId: "c1" }));
    await sw.push(payload({ chatId: "c2" }));
    expect(sw.tray().map((n) => n.options.tag)).toEqual(["chat:c1", "chat:c2"]);
  });

  it("withdraws the notification when nothing is outstanding any more", async () => {
    await sw.push(payload({ outstanding: 2 }));
    expect(sw.tray()).toHaveLength(1);
    // The question got answered / the PR merged while the device was asleep.
    await sw.push(payload({ outstanding: 0 }));
    expect(sw.tray()).toHaveLength(0);
  });

  it("withdrawing one chat leaves another chat's notification alone", async () => {
    await sw.push(payload({ chatId: "c1" }));
    await sw.push(payload({ chatId: "c2" }));
    await sw.push(payload({ chatId: "c1", outstanding: 0 }));
    expect(sw.tray().map((n) => n.options.tag)).toEqual(["chat:c2"]);
  });

  it("NEVER displays nothing on an Apple endpoint", async () => {
    // A push that shows nothing is a silent push, and a handful of those makes
    // iOS revoke the subscription — the failure being that notifications work
    // for a day and then stop with nothing reporting an error. The server does
    // not send withdrawals to Apple; this is the belt to that pair of braces.
    const ios = loadWorker({ endpoint: "https://web.push.apple.com/abc" });
    await ios.push(payload({ outstanding: 2 }));
    await ios.push(payload({ outstanding: 0 }));
    expect(ios.tray()).toHaveLength(1);
    expect(ios.tray()[0]!.title).toBe("Dispatch");
  });

  it("always shows something, even for an unreadable payload", async () => {
    const handler = loadWorker();
    await handler.push(null);
    expect(handler.tray()).toHaveLength(1);
    expect(handler.tray()[0]!.title).toBe("Dispatch");
  });

  it("mirrors the outstanding total onto the app badge", async () => {
    await sw.push(payload({ badge: 4 }));
    await sw.push(payload({ outstanding: 0, badge: 0 }));
    expect(sw.badge).toEqual([4, "cleared"]);
  });

  it("leaves the badge alone when the payload omits it", async () => {
    // The test push proves delivery works; it must not make the icon claim
    // there is work waiting.
    await sw.push(payload({ badge: undefined }));
    expect(sw.badge).toEqual([]);
  });

  it("carries the focus target so a click lands on the right chat", async () => {
    await sw.push(payload({ chatId: "c9", permissionRequestId: "req-1" }));
    expect(sw.tray()[0]!.options.data).toEqual({
      type: "attention-focus",
      chatId: "c9",
      permissionRequestId: "req-1",
      url: undefined,
    });
  });
});
