/**
 * event-forwarder — bus event → signed POST, through `ctx`.
 *
 * What it exercises, one line per host seam:
 *   bus       `subscribe` to every event, filter by the configured types
 *   settings  `url` and `events`, re-read live through `onChange`
 *   secrets   the HMAC key (`EVENT_FORWARDER_SECRET`, listed in plugin.yaml)
 *   kv        the running delivery count, so a restart does not reset it
 *   routes    `GET  /status`  → counts, last error, the effective config
 *             `POST /test`    → one synthetic delivery, so the receiver can be
 *                                checked without waiting for a real event
 *
 * The envelope and the `X-Dispatch-Signature` header are the host's outbound
 * webhook scheme (`t=<unix>,v1=<hex HMAC-SHA256 over "<t>.<body>">`), so a
 * receiver written for Settings → Integrations → Webhooks accepts these
 * unchanged. Deliberately NO retries: the host's webhooks already do retry
 * with a delivery log, and the point here is the plugin side of the seam —
 * a plugin that needs durable delivery should create a host subscription
 * rather than re-implement one.
 *
 * Built by vite.config.mjs (`dispatchServerBuild`) into server/index.js with
 * `node:crypto` left external and everything else inlined. Nothing here may
 * `import` an npm package at runtime: the host loads the file from the plugin
 * directory, where no node_modules exists.
 */
import { createHmac, randomUUID } from "node:crypto";
import { definePlugin, type WsServerEvent } from "@dispatch/plugin-sdk";

export const SECRET_NAME = "EVENT_FORWARDER_SECRET";
const DEFAULT_EVENTS = "chat-status,attention-add";

interface Config {
  url: string | undefined;
  events: Set<string>;
}

interface Stats {
  forwarded: number;
  failed: number;
  lastAt?: number;
  lastError?: string;
}

/** The settings form writes strings; a blank URL means "off", not "POST to ''". */
export function parseConfig(raw: unknown): Config {
  const s = (raw ?? {}) as { url?: unknown; events?: unknown };
  const url = typeof s.url === "string" && s.url.trim() ? s.url.trim() : undefined;
  const list = typeof s.events === "string" && s.events.trim() ? s.events : DEFAULT_EVENTS;
  return { url, events: new Set(list.split(",").map((e) => e.trim()).filter(Boolean)) };
}

/** `t=<unix>,v1=<hex>` over `"<t>.<body>"` — byte-for-byte the host's scheme. */
export function sign(secret: string, body: string, unixSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${unixSeconds}.${body}`).digest("hex");
  return `t=${unixSeconds},v1=${mac}`;
}

export default definePlugin({
  async activate(ctx) {
    const stats: Stats = (await ctx.kv!.get<Stats>("stats")) ?? { forwarded: 0, failed: 0 };
    let config = parseConfig(ctx.settings.get());
    ctx.settings.onChange((next) => {
      config = parseConfig(next);
    });

    async function deliver(type: string, data: unknown, chatId?: string): Promise<boolean> {
      if (!config.url) return false;
      const body = JSON.stringify({ id: randomUUID(), type, at: Date.now(), ...(chatId ? { chatId } : {}), data });
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-dispatch-event": type,
        "x-dispatch-delivery": randomUUID(),
      };
      const secret = await ctx.secrets!.get(SECRET_NAME);
      if (secret) headers["x-dispatch-signature"] = sign(secret, body, Math.floor(Date.now() / 1000));
      try {
        const res = await fetch(config.url, { method: "POST", headers, body });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        stats.forwarded += 1;
        stats.lastAt = Date.now();
        delete stats.lastError;
      } catch (err) {
        stats.failed += 1;
        stats.lastError = err instanceof Error ? err.message : String(err);
        ctx.log.warn(`delivery of ${type} failed: ${stats.lastError}`);
      }
      await ctx.kv!.set("stats", stats);
      return !stats.lastError;
    }

    ctx.bus!.subscribe((evt: WsServerEvent) => {
      if (!config.events.has(evt.type)) return;
      // `chatId` rides the envelope when the event has one, like the host's.
      const chatId = "chatId" in evt && typeof evt.chatId === "string" ? evt.chatId : undefined;
      void deliver(evt.type, evt, chatId);
    });

    ctx.routes!((r) => {
      r.get("/status", async () => ({
        ...stats,
        url: config.url ?? null,
        events: [...config.events],
        signing: (await ctx.secrets!.get(SECRET_NAME)) ? "hmac-sha256" : "unsigned",
      }));
      r.post("/test", async (_req, reply) => {
        if (!config.url) return reply.code(409).send({ ok: false, error: "no URL configured" });
        const ok = await deliver("event-forwarder-test", { hello: ctx.id, version: ctx.version });
        return { ok, ...(ok ? {} : { error: stats.lastError }) };
      });
    });

    ctx.log.info(`forwarding ${[...config.events].join(", ")} → ${config.url ?? "(no URL yet)"}`);
  },
});
