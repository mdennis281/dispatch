/** `ctx.tools` in the fake: register as the host checks it, call as an agent would. */
import { describe, it, expect } from "vitest";
import { createTestContext } from "./testing.js";

describe("createTestContext tools", () => {
  it("registers, lists, describes and calls a tool with the chat it was called from", async () => {
    const t = createTestContext({ id: "remote-host" });
    t.ctx.tools!.register<{ host: string }>({
      name: "machine_status",
      description: "Report the machine's status.",
      inputSchema: { type: "object", properties: { host: { type: "string" } }, required: ["host"] },
      handler: (args, call) => `${args.host} for ${call.chatId}`,
    });
    expect(t.tools.list()).toEqual(["machine_status"]);
    expect(t.tools.get("machine_status")).toMatchObject({
      qualifiedName: "mcp__dispatch-plugin-remote-host__machine_status",
    });
    expect(await t.tools.call("machine_status", { host: "cvx-mac" }, { chatId: "c9" })).toEqual({
      content: [{ type: "text", text: "cvx-mac for c9" }],
    });
  });

  it("a throw is an error result; an unregistered tool is no longer available", async () => {
    const t = createTestContext({ id: "remote-host" });
    const off = t.ctx.tools!.register({
      name: "remote_fetch",
      description: "Fetch a file.",
      handler: () => {
        throw new Error("machine offline");
      },
    });
    expect(await t.tools.call("remote_fetch")).toEqual({ content: [{ type: "text", text: "machine offline" }], isError: true });
    off();
    expect((await t.tools.call("remote_fetch")).isError).toBe(true);
  });

  it("refuses what the host refuses", () => {
    const t = createTestContext({ id: "a".repeat(40) });
    expect(() => t.ctx.tools!.register({ name: "status", description: "d", handler: () => "" })).toThrow(/at most 64/);
    const u = createTestContext({ id: "remote-host" });
    expect(() => u.ctx.tools!.register({ name: "Bad-Name", description: "d", handler: () => "" })).toThrow(/snake case/);
    expect(() => u.ctx.tools!.register({ name: "ok", description: "", handler: () => "" })).toThrow(/description/);
  });
});
