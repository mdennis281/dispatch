/**
 * The forwarder under `createTestContext`: no server, a stubbed `fetch`, and
 * the signature verified the way a receiver would.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createTestContext } from "@dispatch/plugin-sdk/testing";
import plugin, { SECRET_NAME, parseConfig, sign } from "../src/server.js";

type Call = { url: string; init: { headers: Record<string, string>; body: string } };

function stubFetch(status = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: Call["init"]) => {
    calls.push({ url, init });
    return { ok: status < 400, status };
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const CAPS = ["events", "routes", "secrets", "kv"] as const;

describe("event-forwarder", () => {
  it("forwards only the configured event types, signed with the listed secret", async () => {
    const calls = stubFetch();
    const t = createTestContext({
      id: "event-forwarder",
      capabilities: CAPS,
      settings: { url: "https://hooks.example/in", events: "chat-status" },
      secrets: { [SECRET_NAME]: "s3cret" },
    });
    await plugin.activate(t.ctx);

    t.publish({ type: "chat-status", chatId: "c1", status: "idle" });
    t.publish({ type: "attention-add", item: { id: "a1" } } as never);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const [call] = calls;
    expect(call!.url).toBe("https://hooks.example/in");
    const body = JSON.parse(call!.init.body) as { type: string; chatId?: string; data: unknown };
    expect(body.type).toBe("chat-status");
    expect(body.chatId).toBe("c1");
    expect(body.data).toEqual({ type: "chat-status", chatId: "c1", status: "idle" });
    expect(call!.init.headers["x-dispatch-event"]).toBe("chat-status");

    // Verify as a receiver would: HMAC over "<t>.<raw body>".
    const sig = call!.init.headers["x-dispatch-signature"]!;
    const [, t0, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig)!;
    expect(createHmac("sha256", "s3cret").update(`${t0}.${call!.init.body}`).digest("hex")).toBe(v1);
    expect(sign("s3cret", call!.init.body, Number(t0))).toBe(sig);

    await vi.waitFor(() => expect(t.kv.get("stats")).toMatchObject({ forwarded: 1, failed: 0 }));
    expect((await t.routes.call("GET", "/status")).body).toMatchObject({ forwarded: 1, signing: "hmac-sha256", events: ["chat-status"] });
  });

  it("does nothing without a URL, picks up a URL from a live settings change, and counts failures", async () => {
    const calls = stubFetch(500);
    const t = createTestContext({ capabilities: CAPS, kv: { stats: { forwarded: 4, failed: 0 } } });
    await plugin.activate(t.ctx);

    t.publish({ type: "chat-status", chatId: "c1", status: "idle" });
    expect(calls).toHaveLength(0);
    expect((await t.routes.call("POST", "/test")).status).toBe(409);

    t.settings.set({ url: "https://hooks.example/in" });
    const res = await t.routes.call("POST", "/test");
    expect(res.body).toEqual({ ok: false, error: "HTTP 500" });
    expect(calls).toHaveLength(1);
    // Unsigned when the secret is not set — and the status says so rather than hiding it.
    expect(calls[0]!.init.headers["x-dispatch-signature"]).toBeUndefined();
    expect((await t.routes.call("GET", "/status")).body).toMatchObject({ forwarded: 4, failed: 1, signing: "unsigned", lastError: "HTTP 500" });
    expect(t.log.at(-1)).toMatchObject({ level: "warn" });
  });

  it("parses the settings form's strings", () => {
    expect(parseConfig(undefined)).toEqual({ url: undefined, events: new Set(["chat-status", "attention-add"]) });
    expect(parseConfig({ url: "  ", events: " a , b ,, " })).toEqual({ url: undefined, events: new Set(["a", "b"]) });
  });
});
