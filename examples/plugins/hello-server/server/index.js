// A server plugin is a plain ESM module exporting `activate` (and optionally
// `deactivate`). No build step, no dependencies: the host hands everything in
// through `ctx`. Written in JavaScript on purpose — it is the lowest bar a
// plugin can clear, and the one the host's own tests load.
//
// What it does, one line per host seam:
//   routes   GET /api/plugins/hello-server/hello            → { greeting, seen }
//            GET /api/plugins/hello-server/chats/:chatId    → { chatId }  (a :param)
//            POST /api/plugins/hello-server/echo            → { echoed: body }
//   bus      counts `chat-message` events while active
//   kv       persists that count across restarts under "seen"
//   settings reads `greeting` / `shout` / `repeat` / `tone` (settings.schema.json)
//   emit     publishes a `plugin-event` { hello: true } once activated

/** @type {(() => void) | undefined} */
let off;

/** @param {import("@dispatch/plugin-sdk").PluginContext} ctx */
export async function activate(ctx) {
  // Counted in memory and written through: two bus events in the same tick
  // would otherwise both read the old value and both write old+1.
  let seen = (await ctx.kv.get("seen")) ?? 0;
  await ctx.kv.set("seen", seen);
  await ctx.kv.set("activatedAt", Date.now());

  // The unsubscribe is returned AND recorded by the host, so forgetting to
  // call it in `deactivate` leaks nothing. Kept here anyway as the example.
  off = ctx.bus.on("chat-message", () => {
    seen += 1;
    void ctx.kv.set("seen", seen);
  });

  ctx.routes((r) => {
    r.get("/hello", async () => {
      const s = ctx.settings.get();
      const base = typeof s.greeting === "string" && s.greeting ? s.greeting : "hello";
      const word = s.shout ? base.toUpperCase() : base;
      const times = Number.isInteger(s.repeat) && s.repeat > 0 ? s.repeat : 1;
      return {
        greeting: Array.from({ length: times }, () => word).join(" "),
        tone: s.tone ?? "friendly",
        seen,
      };
    });
    r.get("/chats/:chatId", async (req) => ({ chatId: req.params.chatId }));
    r.post("/echo", async (req) => ({ echoed: req.body }));
  });

  ctx.settings.onChange((next) => ctx.log.info(`settings changed: ${JSON.stringify(next)}`));
  ctx.emit({ hello: true, version: ctx.version });
}

export async function deactivate() {
  off?.();
  off = undefined;
}
