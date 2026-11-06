/**
 * `ctx.approvals` as a plugin receives it: gated by the capability, named
 * from the manifest, passing only the card's fields, and withdrawn when the
 * plugin goes down. The broker's half (who may answer, how it ends) is
 * session-broker.plugin-approval.test.ts.
 */
import { describe, expect, it } from "vitest";
import { PluginManifestSchema, type AttentionItem, type PluginApprovalResult } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { buildPluginContext, newOwnedResources, type PluginApprover, type PluginContextDeps } from "./context.js";

type Call = Parameters<PluginApprover["requestPluginApproval"]>;

function context(capabilities: string[], opts: { attention?: AttentionItem[] } = {}) {
  const manifest = PluginManifestSchema.parse({
    id: "remote-host",
    name: "Remote hosts",
    version: "0.1.0",
    dispatch: ">=1",
    capabilities,
  });
  const calls: Call[] = [];
  const cancelled: string[] = [];
  const answered: string[] = [];
  const approvals: PluginApprover = {
    requestPluginApproval: async (...args) => {
      calls.push(args);
      return { decision: "denied", at: 1 } satisfies PluginApprovalResult;
    },
    cancelPluginApprovals: (pluginId) => {
      cancelled.push(pluginId);
      return 0;
    },
  };
  const never = () => {
    throw new Error("not in this test");
  };
  const items = opts.attention ?? [];
  const deps: PluginContextDeps = {
    store: {} as never,
    bus: new EventBus(),
    secrets: {} as never,
    inspect: {} as never,
    memory: {} as never,
    attention: { list: () => items, get: (id: string) => items.find((i) => i.id === id) } as never,
    messenger: { send: never, ask: never, reply: never, state: never, targetOf: () => undefined } as never,
    broker: {
      answerQuestion: (id) => (answered.push(id), true),
      declineQuestion: (id) => (answered.push(id), true),
    },
    approvals,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    settings: () => ({}),
  };
  const owned = newOwnedResources();
  const ctx = buildPluginContext(manifest, "/plugins/remote-host", deps, owned);
  return { ctx, calls, cancelled, answered, owned };
}

describe("ctx.approvals", () => {
  it("is absent without the `approvals` capability", () => {
    expect(context(["chats:write"]).ctx.approvals).toBeUndefined();
  });

  it("asks in the MANIFEST's name, passing only the card's fields", async () => {
    const { ctx, calls } = context(["approvals"]);
    const ac = new AbortController();
    const r = await ctx.approvals!.request("c1", {
      title: "Run a command as root",
      command: "sudo id -u",
      cwd: "/tmp",
      machine: "CVX Mac",
      detail: "why",
      timeoutSeconds: 60,
      signal: ac.signal,
      // A plugin trying to speak for another, or to sneak a field onto the card.
      ...({ pluginName: "Dispatch", pluginId: "dispatch-core", extra: "x" } as object),
    });
    expect(r.decision).toBe("denied");
    expect(calls).toHaveLength(1);
    const [chatId, origin, req] = calls[0]!;
    expect(chatId).toBe("c1");
    expect(origin).toEqual({ pluginId: "remote-host", pluginName: "Remote hosts" });
    expect(Object.keys(req).sort()).toEqual(["command", "cwd", "detail", "machine", "signal", "timeoutSeconds", "title"]);
    expect(req.signal).toBe(ac.signal);
  });

  it("rejects (never throws synchronously) on a missing chat id", async () => {
    const { ctx, calls } = context(["approvals"]);
    const p = ctx.approvals!.request("", { title: "x" });
    await expect(p).rejects.toThrow(/chatId/);
    expect(calls).toHaveLength(0);
  });

  it("withdraws the plugin's open cards when it goes down", () => {
    const { cancelled, owned } = context(["approvals"]);
    for (const off of owned.offs) off();
    expect(cancelled).toEqual(["remote-host"]);
  });
});

describe("ctx.attention.answer — a plugin cannot answer an approval card, its own included", () => {
  it("refuses the permission item an approval raises", async () => {
    const item: AttentionItem = {
      id: "att-perm-r1",
      chatId: "c1",
      kind: "permission",
      summary: "Remote hosts: Run a command as root",
      permissionRequestId: "r1",
      createdAt: 1,
    };
    const { ctx, answered } = context(["approvals", "chats:read", "chats:write"], { attention: [item] });
    for (const answer of [{ answer: "Allow" }, { optionId: "allow" }, { decline: true as const }]) {
      const r = await ctx.attention!.answer!(item.id, answer);
      expect(r.ok).toBe(false);
    }
    expect(answered).toEqual([]);
  });
});
