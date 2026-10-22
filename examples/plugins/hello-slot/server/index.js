// The server half of hello-slot: two routes under /api/plugins/hello-slot/
// and a plugin-event on activate. Plain JavaScript, no build, like
// hello-server. The client half (src/index.tsx) is what calls these.
//
//   GET  /hello   → { greeting, at }        the settings section's button
//   POST /ping    → emits { pong, at }      the composer menu's round trip;
//                                           the client's onPlugin toasts it

/** @param {import("@dispatch/plugin-sdk").PluginContext} ctx */
export async function activate(ctx) {
  ctx.routes((r) => {
    r.get("/hello", async () => ({ greeting: "hello from the server half", at: Date.now() }));
    r.post("/ping", async (req) => {
      const body = /** @type {{ chatId?: unknown } | undefined} */ (req.body);
      const chatId = typeof body?.chatId === "string" ? body.chatId : undefined;
      ctx.emit({ pong: true, at: Date.now() }, chatId);
      return { ok: true };
    });
  });
  ctx.emit({ hello: true, version: ctx.version });
}
