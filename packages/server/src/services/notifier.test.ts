import { describe, it, expect, vi } from "vitest";
import type { AttentionItem, WsServerEvent } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import type { Store, AppSettings } from "../store/index.js";
import {
  Notifier,
  buildWebhookRequest,
  startNotifier,
  type FetchLike,
  type WebhookConfig,
} from "./notifier.js";

/** A fetch mock that satisfies FetchLike and records calls. */
function fetchMock() {
  return vi.fn<FetchLike>(async () => ({ ok: true, status: 200 }));
}

/** Minimal Store stub exposing only the getSettings the notifier uses. */
function storeWith(webhook?: AppSettings["webhook"]): Store {
  return {
    getSettings: async (): Promise<AppSettings> => ({ theme: "dark", webhook }),
  } as unknown as Store;
}

function attn(
  kind: AttentionItem["kind"],
  over: Partial<AttentionItem> = {},
): AttentionItem {
  return {
    id: "a1",
    chatId: "c1",
    kind,
    summary: "Chat B: allow Bash?",
    createdAt: 1,
    ...over,
  };
}

describe("buildWebhookRequest", () => {
  it("ntfy → plain-text body + Title/Tags/Priority headers", () => {
    const wh: WebhookConfig = { kind: "ntfy", url: "https://ntfy.sh/cm", enabled: true };
    const req = buildWebhookRequest(attn("permission"), wh);
    expect(req).not.toBeNull();
    expect(req!.url).toBe("https://ntfy.sh/cm");
    expect(req!.init.method).toBe("POST");
    expect(req!.init.body).toBe("Chat B: allow Bash?");
    const h = req!.init.headers as Record<string, string>;
    expect(h.Title).toBe("Permission needed");
    expect(h.Tags).toBe("lock");
    expect(h.Priority).toBe("4");
  });

  it("pushover → form-encoded title/message/priority", () => {
    const wh: WebhookConfig = { kind: "pushover", url: "https://push/x", enabled: true };
    const req = buildWebhookRequest(attn("done", { summary: "run finished" }), wh);
    expect(req!.url).toBe("https://push/x");
    const h = req!.init.headers as Record<string, string>;
    expect(h["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(req!.init.body as string);
    expect(form.get("title")).toBe("Task done");
    expect(form.get("message")).toBe("run finished");
    expect(form.get("priority")).toBe("0"); // done → normal priority
  });

  it("no kind → generic Slack-style JSON { text }", () => {
    const wh: WebhookConfig = { url: "https://hooks.slack/x", enabled: true };
    const req = buildWebhookRequest(attn("question", { summary: "pick one" }), wh);
    const h = req!.init.headers as Record<string, string>;
    expect(h["Content-Type"]).toBe("application/json");
    expect(JSON.parse(req!.init.body as string)).toEqual({ text: "Question: pick one" });
  });

  it("returns null when the webhook has no url", () => {
    expect(buildWebhookRequest(attn("idle"), { enabled: true })).toBeNull();
  });

  it("maps every attention kind to distinct copy", () => {
    const wh: WebhookConfig = { kind: "ntfy", url: "u", enabled: true };
    const titleOf = (k: AttentionItem["kind"]) =>
      (buildWebhookRequest(attn(k), wh)!.init.headers as Record<string, string>).Title;
    expect(titleOf("permission")).toBe("Permission needed");
    expect(titleOf("question")).toBe("Question");
    expect(titleOf("idle")).toBe("Waiting for input");
    expect(titleOf("done")).toBe("Task done");
  });
});

describe("Notifier.handle — no-op when unconfigured", () => {
  it("does not fetch when no webhook is configured", async () => {
    const f = fetchMock();
    const n = new Notifier({ bus: new EventBus(), store: storeWith(undefined), fetch: f });
    await n.handle(attn("permission"));
    expect(f).not.toHaveBeenCalled();
  });

  it("does not fetch when the webhook is disabled", async () => {
    const f = fetchMock();
    const n = new Notifier({
      bus: new EventBus(),
      store: storeWith({ kind: "ntfy", url: "https://ntfy.sh/cm", enabled: false }),
      fetch: f,
    });
    await n.handle(attn("done"));
    expect(f).not.toHaveBeenCalled();
  });

  it("does not fetch when enabled but URL is missing", async () => {
    const f = fetchMock();
    const n = new Notifier({
      bus: new EventBus(),
      store: storeWith({ kind: "ntfy", enabled: true }),
      fetch: f,
    });
    await n.handle(attn("idle"));
    expect(f).not.toHaveBeenCalled();
  });

  it("ignores non-notifiable kinds without reading settings", async () => {
    const f = fetchMock();
    const store = storeWith({ kind: "ntfy", url: "u", enabled: true });
    const spy = vi.spyOn(store, "getSettings");
    const n = new Notifier({ bus: new EventBus(), store, fetch: f });
    await n.handle({ ...attn("done"), kind: "bogus" as AttentionItem["kind"] });
    expect(f).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("Notifier.handle — POSTs when configured", () => {
  it("fires the built webhook request to the configured URL", async () => {
    const f = fetchMock();
    const n = new Notifier({
      bus: new EventBus(),
      store: storeWith({ kind: "ntfy", url: "https://ntfy.sh/cm", enabled: true }),
      fetch: f,
    });
    await n.handle(attn("permission", { summary: "allow Write?" }));
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://ntfy.sh/cm");
    expect(init.body).toBe("allow Write?");
    expect((init.headers as Record<string, string>).Title).toBe("Permission needed");
  });

  it("swallows webhook failures (never rejects) and reports via onError", async () => {
    const err = new Error("network down");
    const f = vi.fn<FetchLike>(async () => {
      throw err;
    });
    const onError = vi.fn();
    const n = new Notifier({
      bus: new EventBus(),
      store: storeWith({ url: "https://x", enabled: true }),
      fetch: f,
      onError,
    });
    await expect(n.handle(attn("done"))).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBe(err);
  });

  it("reports and no-ops when settings read throws", async () => {
    const f = fetchMock();
    const store = {
      getSettings: async () => {
        throw new Error("corrupt config");
      },
    } as unknown as Store;
    const onError = vi.fn();
    const n = new Notifier({ bus: new EventBus(), store, fetch: f, onError });
    await n.handle(attn("permission"));
    expect(f).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("Notifier — bus wiring", () => {
  it("delivers on attention-add published to the bus, ignores other events", async () => {
    const bus = new EventBus();
    const f = fetchMock();
    const n = startNotifier({
      bus,
      store: storeWith({ kind: "ntfy", url: "https://ntfy.sh/cm", enabled: true }),
      fetch: f,
    });

    bus.publish({ type: "hello", serverTime: 1 } satisfies WsServerEvent);
    bus.publish({ type: "attention-add", item: attn("question") } satisfies WsServerEvent);
    await n.whenIdle();

    expect(f).toHaveBeenCalledTimes(1);
    n.stop();
  });

  it("does not consume the event — other bus subscribers still receive it", async () => {
    const bus = new EventBus();
    const seen: WsServerEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const n = startNotifier({
      bus,
      store: storeWith({ url: "https://x", enabled: true }),
      fetch: fetchMock(),
    });
    const evt: WsServerEvent = { type: "attention-add", item: attn("idle") };
    bus.publish(evt);
    await n.whenIdle();
    expect(seen).toContainEqual(evt);
    n.stop();
  });

  it("stop() halts further deliveries", async () => {
    const bus = new EventBus();
    const f = fetchMock();
    const n = startNotifier({
      bus,
      store: storeWith({ kind: "ntfy", url: "u", enabled: true }),
      fetch: f,
    });
    n.stop();
    bus.publish({ type: "attention-add", item: attn("done") } satisfies WsServerEvent);
    await n.whenIdle();
    expect(f).not.toHaveBeenCalled();
  });
});
