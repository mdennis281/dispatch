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
    // The host's text: the plugin's display name, then the message.
    expect(await t.tools.call("remote_fetch")).toEqual({
      content: [{ type: "text", text: "remote-host: machine offline" }],
      isError: true,
    });
    off();
    expect((await t.tools.call("remote_fetch")).isError).toBe(true);
  });

  it("normalizes results exactly as the host does: images checked, long text cut, the name from `name`", async () => {
    const t = createTestContext({ id: "remote-host", name: "Remote hosts" });
    let out: unknown = "x".repeat(300_000);
    t.ctx.tools!.register({ name: "shot", description: "d", handler: () => out as never });
    const long = await t.tools.call("shot");
    expect(long.isError).toBeUndefined();
    expect(long.content.at(-1)).toEqual({
      type: "text",
      text: "[… cut: the result's text was 300000 characters; the limit is 200000]",
    });
    out = { content: [{ type: "image", data: "AAA", mimeType: "image/tiff" }] };
    expect((await t.tools.call("shot")).isError).toBe(true);
    out = () => {};
    t.ctx.tools!.register({
      name: "boom",
      description: "d",
      handler: () => {
        throw new Error("no");
      },
    });
    expect((await t.tools.call("boom")).content).toEqual([{ type: "text", text: "Remote hosts: no" }]);
  });

  it("refuses what the host refuses", () => {
    const t = createTestContext({ id: "a".repeat(40) });
    expect(() => t.ctx.tools!.register({ name: "status", description: "d", handler: () => "" })).toThrow(/at most 64/);
    const u = createTestContext({ id: "remote-host" });
    expect(() => u.ctx.tools!.register({ name: "Bad-Name", description: "d", handler: () => "" })).toThrow(/snake case/);
    expect(() => u.ctx.tools!.register({ name: "ok", description: "", handler: () => "" })).toThrow(/description/);
  });
});
