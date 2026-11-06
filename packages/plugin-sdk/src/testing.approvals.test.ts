/**
 * `ctx.approvals` in the fake: scriptable decisions, the host's refusals, and
 * a withdrawal through `signal` — what a plugin like remote-host's elevation
 * needs to test its approve / deny / timeout / cancel branches with no server.
 */
import { describe, it, expect } from "vitest";
import { createTestContext } from "./testing.js";

const SUDO = { title: "Run a command as root", command: "sudo id -u", machine: "CVX Mac" };

describe("createTestContext approvals", () => {
  it("is absent without the capability", () => {
    expect(createTestContext({ capabilities: ["kv"] }).ctx.approvals).toBeUndefined();
  });

  it("defaults to timeout — a card nobody is watching", async () => {
    const t = createTestContext();
    const r = await t.ctx.approvals!.request("c1", SUDO);
    expect(r.decision).toBe("timeout");
    expect(r.by).toBeUndefined();
    expect(t.approvals).toEqual([{ chatId: "c1", request: SUDO, result: r }]);
  });

  it("plays the human: a decision, or a whole result with a name", async () => {
    const answers = ["approved", { decision: "denied", by: "Michael" }] as const;
    let i = 0;
    const t = createTestContext({ approve: () => answers[i++]! });
    expect((await t.ctx.approvals!.request("c1", SUDO)).decision).toBe("approved");
    expect(await t.ctx.approvals!.request("c1", SUDO)).toMatchObject({ decision: "denied", by: "Michael" });
  });

  it("never names anyone on a timeout or cancel, as the host doesn't", async () => {
    const t = createTestContext({ approve: () => ({ decision: "timeout", by: "Michael" }) });
    expect((await t.ctx.approvals!.request("c1", SUDO)).by).toBeUndefined();
  });

  it("an answer that never comes is withdrawn by the signal: cancelled", async () => {
    const t = createTestContext({ approve: () => new Promise(() => {}) });
    const ac = new AbortController();
    const p = t.ctx.approvals!.request("c1", { ...SUDO, signal: ac.signal });
    expect(t.approvals[0]?.result).toBeUndefined();
    ac.abort();
    expect((await p).decision).toBe("cancelled");
  });

  it("refuses what the host refuses", async () => {
    const t = createTestContext({ approve: () => "approved" });
    await expect(t.ctx.approvals!.request("c1", { title: "" })).rejects.toThrow(/title/);
    await expect(t.ctx.approvals!.request("", SUDO)).rejects.toThrow(/chatId/);
    await expect(t.ctx.approvals!.request("c1", { ...SUDO, command: "x".repeat(8001) })).rejects.toThrow(/command/);
    await expect(t.ctx.approvals!.request("c1", { ...SUDO, timeoutSeconds: 3601 })).rejects.toThrow(/timeoutSeconds/);
    expect(t.approvals).toEqual([]);
  });
});
