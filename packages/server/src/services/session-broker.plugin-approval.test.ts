/**
 * `ctx.approvals.request` on the broker: a plugin's approval card.
 *
 * It guards things like "run this as root on the Mac", so the REFUSAL paths
 * get as much attention here as the happy path: every resolver other than
 * `answerPluginApproval` must be unable to settle it, a non-owner must be
 * unable to answer it either way, and every ending without a person must come
 * out as something other than `approved`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLUGIN_APPROVAL_TOOL,
  readPluginApproval,
  readPluginApprovalOutcome,
  type Chat,
  type ChatMessage,
  type WsServerEvent,
} from "@dispatch/shared";
import type { QueryFn } from "@dispatch/plugin-claude/harness";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import { claudeOnlyRegistry } from "../harness/registry.testkit.js";
import { SessionBroker } from "./session-broker.js";
import { AttentionQueue } from "./attention.js";
import { answerAttentionItem, AttentionAnswerError } from "./mcp/attention-tools.js";
import { dispatchClientAction } from "../routes/dispatch.js";
import { socketActor } from "../routes/ws.js";
import type { Services } from "./container.js";

let dir: string;
let store: Store;
let bus: EventBus;
let events: WsServerEvent[];
let brokers: SessionBroker[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-approval-"));
  store = new Store(dir);
  await store.init();
  bus = new EventBus();
  events = [];
  brokers = [];
  bus.subscribe((e) => events.push(e));
});
afterEach(async () => {
  await Promise.all(brokers.map((b) => b.dispose().catch(() => {})));
  store.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function chatFor(id: string): Chat {
  return {
    id,
    projectId: "p1",
    harness: "claude",
    title: "Untitled",
    modeId: "auto",
    effort: "medium",
    worktrees: [],
    prs: [],
    createdAt: 1,
  };
}

/** No turn ever runs in these tests: the session only has to exist to be asked through. */
const unusedQuery = (() => {
  throw new Error("no turn runs in this test");
}) as unknown as QueryFn;

async function liveBroker(chatId = "c1"): Promise<SessionBroker> {
  let idc = 0;
  const broker = new SessionBroker({
    harnesses: claudeOnlyRegistry(unusedQuery),
    store,
    bus,
    maxActiveSessions: 6,
    deps: { genId: () => `id-${++idc}` },
  });
  brokers.push(broker);
  await store.saveChat(chatFor(chatId));
  broker.create(chatFor(chatId));
  return broker;
}

const ORIGIN = { pluginId: "remote-host", pluginName: "Remote hosts" };
const SUDO = {
  title: "Run a command as root",
  command: "sudo installer -pkg /tmp/x.pkg -target /",
  cwd: "/Users/dispatch/repo",
  machine: "CVX Mac",
};

function nextRequestId(): Promise<string> {
  return new Promise((resolve) => {
    const off = bus.on("permission-request", (e) => {
      off();
      resolve(e.request.id);
    });
  });
}

async function transcript(chatId = "c1"): Promise<ChatMessage[]> {
  // Rows are appended on the session's write chain; give it a beat to land.
  for (let i = 0; i < 50; i++) {
    const rows = await store.readMessages(chatId);
    if (rows.some((r) => r.kind === "notice")) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
  return store.readMessages(chatId);
}

async function audit(): Promise<Awaited<ReturnType<Store["listApprovalAudit"]>>> {
  for (let i = 0; i < 50; i++) {
    const rows = await store.listApprovalAudit();
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
  return [];
}

const OWNER = { owner: true, name: "Michael" };

describe("plugin approvals — the card", () => {
  it("raises a permission card in the Attention Queue, named for the plugin, and blocks the chat on the human", async () => {
    const broker = await liveBroker();
    const idP = nextRequestId();
    const resultP = broker.requestPluginApproval("c1", ORIGIN, SUDO);
    const id = await idP;

    const req = events.find(
      (e): e is Extract<WsServerEvent, { type: "permission-request" }> => e.type === "permission-request",
    )!.request;
    expect(req.toolName).toBe(PLUGIN_APPROVAL_TOOL);
    expect(req.displayName).toBe("Remote hosts");
    const card = readPluginApproval(req.toolName, req.input)!;
    expect(card).toMatchObject({ pluginId: "remote-host", pluginName: "Remote hosts", ...SUDO });
    // Default timeout: five minutes.
    expect(card.expiresAt - (req.createdAt ?? 0)).toBe(300_000);

    const att = events.find(
      (e): e is Extract<WsServerEvent, { type: "attention-add" }> => e.type === "attention-add",
    )!.item;
    expect(att).toMatchObject({ kind: "permission", permissionRequestId: id, chatId: "c1", projectId: "p1" });
    expect(att.summary).toBe("Remote hosts: Run a command as root");
    expect(broker.getStatus("c1")).toBe("awaiting-input");

    expect(broker.answerPluginApproval(id, "deny", OWNER)).toEqual({ ok: true });
    await resultP;
  });

  it("approved by the owner: resolves approved with their name, and leaves a transcript notice and an audit row", async () => {
    const broker = await liveBroker();
    const idP = nextRequestId();
    const resultP = broker.requestPluginApproval("c1", ORIGIN, SUDO);
    const id = await idP;

    expect(broker.answerPluginApproval(id, "allow", OWNER)).toEqual({ ok: true });
    const result = await resultP;
    expect(result).toMatchObject({ decision: "approved", by: "Michael" });
    expect(typeof result.at).toBe("number");

    const rows = await transcript();
    const notice = rows.find((r) => r.kind === "notice");
    expect(notice && notice.kind === "notice" && notice.text).toBe(
      "Approved by Michael: `sudo installer -pkg /tmp/x.pkg -target /` on CVX Mac (asked by Remote hosts)",
    );
    const perm = rows.find((r) => r.kind === "permission");
    expect(perm?.kind === "permission" && perm.decision).toBe("allow");
    expect(perm?.kind === "permission" && readPluginApprovalOutcome(perm.input)).toBe("approved");

    const [row] = await audit();
    expect(row).toMatchObject({
      requestId: id,
      pluginId: "remote-host",
      chatId: "c1",
      projectId: "p1",
      command: SUDO.command,
      machine: "CVX Mac",
      decision: "approved",
      by: "Michael",
    });
    // The card is gone from the queue and the chat is no longer waiting on anyone.
    expect(events.some((e) => e.type === "attention-resolve" && e.id === `att-perm-${id}`)).toBe(true);
    expect(broker.getStatus("c1")).not.toBe("awaiting-input");
  });

  it("denied by the owner: resolves denied, and says so", async () => {
    const broker = await liveBroker();
    const idP = nextRequestId();
    const resultP = broker.requestPluginApproval("c1", ORIGIN, SUDO);
    broker.answerPluginApproval(await idP, "deny", OWNER);
    expect(await resultP).toMatchObject({ decision: "denied", by: "Michael" });
    const notice = (await transcript()).find((r) => r.kind === "notice");
    expect(notice?.kind === "notice" && notice.text).toMatch(/^Denied by Michael: /);
    expect((await audit())[0]).toMatchObject({ decision: "denied" });
  });

  it("an install without sign-in answers as the owner, with no name", async () => {
    const broker = await liveBroker();
    const idP = nextRequestId();
    const resultP = broker.requestPluginApproval("c1", ORIGIN, SUDO);
    broker.answerPluginApproval(await idP, "allow", socketActor(undefined));
    const result = await resultP;
    expect(result.decision).toBe("approved");
    expect(result.by).toBeUndefined();
  });
});

describe("plugin approvals — nobody but the owner can answer", () => {
  async function pending() {
    const broker = await liveBroker();
    const idP = nextRequestId();
    let settled: unknown;
    const resultP = broker.requestPluginApproval("c1", ORIGIN, SUDO).then((r) => (settled = r));
    const id = await idP;
    return { broker, id, resultP, settled: () => settled };
  }
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it("refuses an answer with no actor, or a non-owner's — either way, approve or deny", async () => {
    const { broker, id, settled } = await pending();
    for (const actor of [undefined, { owner: false }, { owner: false, name: "guest" }]) {
      for (const decision of ["allow", "deny"] as const) {
        const r = broker.answerPluginApproval(id, decision, actor);
        expect(r.ok).toBe(false);
      }
    }
    await tick();
    expect(settled()).toBeUndefined();
    expect(broker.isPluginApproval(id)).toBe(true);
  });

  it("cannot be granted through the generic resolver, even as a human with remember", async () => {
    const { broker, id, settled } = await pending();
    expect(broker.resolvePermission(id, { decision: "allow", remember: true }, { human: true })).toBe(false);
    expect(broker.resolvePermission(id, { decision: "deny" })).toBe(false);
    await tick();
    expect(settled()).toBeUndefined();
    // And "always allow" was not written for the pseudo tool.
    expect((await store.getSettings()).autoAllowTools ?? []).not.toContain(PLUGIN_APPROVAL_TOOL);
  });

  it("cannot be answered or declined as a question", async () => {
    const { broker, id, settled } = await pending();
    expect(broker.answerQuestion(id, { answer: "yes" })).toBe(false);
    expect(broker.answerQuestion(id, { answers: [{ questionIndex: 0, answer: "Allow" }] })).toBe(false);
    expect(broker.declineQuestion(id)).toBe(false);
    expect(broker.touchQuestion("c1", id)).toBe(false);
    await tick();
    expect(settled()).toBeUndefined();
  });

  it("is refused by the integration answer path (REST, MCP attention_answer, ctx.attention.answer)", async () => {
    const { broker, id, settled } = await pending();
    const attention = new AttentionQueue({ bus });
    for (const e of events) if (e.type === "attention-add") attention.add(e.item);
    const itemId = `att-perm-${id}`;
    expect(attention.get(itemId)?.kind).toBe("permission");

    for (const input of [{ answer: "Allow" }, { optionId: "allow" }, { decline: true as const }]) {
      let err: unknown;
      try {
        answerAttentionItem({ attention, broker }, itemId, input, () => true);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AttentionAnswerError);
      expect((err as AttentionAnswerError).status).toBe(409);
    }
    await tick();
    expect(settled()).toBeUndefined();
  });

  it("over the socket: answer-permission needs the owner, answer-question never works, remember and an edited input are ignored", async () => {
    const { broker, id, resultP, settled } = await pending();
    const services = { broker, bus, store } as unknown as Services;
    const base = { chatId: "c1", requestId: id };

    // A non-owner's socket, and a socket of unknown provenance.
    await dispatchClientAction(services, { type: "answer-permission", ...base, decision: "allow" }, { owner: false, name: "guest" });
    await dispatchClientAction(services, { type: "answer-permission", ...base, decision: "allow" });
    // The question actions name the same id.
    await dispatchClientAction(services, { type: "answer-question", ...base, answer: "Allow" }, OWNER);
    await dispatchClientAction(services, { type: "decline-question", ...base }, OWNER);
    await tick();
    expect(settled()).toBeUndefined();
    const errors = events.filter((e) => e.type === "error");
    expect(errors.some((e) => e.type === "error" && /Only the owner/.test(e.message))).toBe(true);

    // The owner's allow lands — and its `remember` and edited input are dropped.
    await dispatchClientAction(
      services,
      {
        type: "answer-permission",
        ...base,
        decision: "allow",
        remember: true,
        updatedInput: { pluginApproval: { command: "rm -rf /" } },
      },
      OWNER,
    );
    expect(await resultP).toMatchObject({ decision: "approved", by: "Michael" });
    expect((await store.getSettings()).autoAllowTools ?? []).not.toContain(PLUGIN_APPROVAL_TOOL);
    expect((await audit())[0]?.command).toBe(SUDO.command);
  });

  it("answers once: a second answer after the first finds nothing pending", async () => {
    const { broker, id, resultP } = await pending();
    expect(broker.answerPluginApproval(id, "deny", OWNER)).toEqual({ ok: true });
    expect(broker.answerPluginApproval(id, "allow", OWNER).ok).toBe(false);
    expect(await resultP).toMatchObject({ decision: "denied" });
    expect(await store.listApprovalAudit()).toHaveLength(1);
  });
});

describe("plugin approvals — endings without a person are never approved", () => {
  it("times out after timeoutSeconds, with no name, and withdraws the card", async () => {
    const broker = await liveBroker();
    const idP = nextRequestId();
    const result = await broker.requestPluginApproval("c1", ORIGIN, { ...SUDO, timeoutSeconds: 0.05 });
    const id = await idP;
    expect(result.decision).toBe("timeout");
    expect(result.by).toBeUndefined();
    expect(events.some((e) => e.type === "attention-resolve" && e.id === `att-perm-${id}`)).toBe(true);
    expect(broker.isPluginApproval(id)).toBe(false);
    // Too late to answer now.
    expect(broker.answerPluginApproval(id, "allow", OWNER).ok).toBe(false);
    const notice = (await transcript()).find((r) => r.kind === "notice");
    expect(notice?.kind === "notice" && notice.text).toMatch(/^Not approved — nobody answered in time/);
    expect((await audit())[0]).toMatchObject({ decision: "timeout" });
    expect((await audit())[0]?.by).toBeUndefined();
  });

  it("an aborted signal withdraws the card: cancelled", async () => {
    const broker = await liveBroker();
    const ac = new AbortController();
    const idP = nextRequestId();
    const resultP = broker.requestPluginApproval("c1", ORIGIN, { ...SUDO, signal: ac.signal });
    const id = await idP;
    ac.abort();
    expect(await resultP).toMatchObject({ decision: "cancelled" });
    expect(broker.isPluginApproval(id)).toBe(false);
    expect(events.some((e) => e.type === "permission-resolved" && e.requestId === id && e.decision === "deny")).toBe(true);
    expect((await audit())[0]).toMatchObject({ decision: "cancelled" });
  });

  it("a signal already aborted shows no card at all", async () => {
    const broker = await liveBroker();
    const ac = new AbortController();
    ac.abort();
    expect(await broker.requestPluginApproval("c1", ORIGIN, { ...SUDO, signal: ac.signal })).toMatchObject({
      decision: "cancelled",
    });
    expect(events.some((e) => e.type === "permission-request")).toBe(false);
  });

  it("the session stopping cancels it", async () => {
    const broker = await liveBroker();
    const idP = nextRequestId();
    const resultP = broker.requestPluginApproval("c1", ORIGIN, SUDO);
    await idP;
    await broker.stop("c1");
    expect(await resultP).toMatchObject({ decision: "cancelled" });
  });

  it("the plugin going down cancels its own cards, and only its own", async () => {
    const broker = await liveBroker();
    const mineP = broker.requestPluginApproval("c1", ORIGIN, SUDO);
    let other: unknown;
    void broker
      .requestPluginApproval("c1", { pluginId: "other", pluginName: "Other" }, { title: "Something else" })
      .then((r) => (other = r));
    expect(broker.cancelPluginApprovals("remote-host")).toBe(1);
    expect(await mineP).toMatchObject({ decision: "cancelled" });
    await new Promise((r) => setTimeout(r, 20));
    expect(other).toBeUndefined();
    expect(broker.cancelPluginApprovals("other")).toBe(1);
  });
});

describe("plugin approvals — requests that cannot be shown are rejected, not answered", () => {
  it("rejects with no live session to ask through", async () => {
    const broker = await liveBroker();
    await expect(broker.requestPluginApproval("nobody", ORIGIN, SUDO)).rejects.toThrow(/no live session/);
  });

  it("rejects a missing title, an over-long field, or a timeout out of range", async () => {
    const broker = await liveBroker();
    await expect(broker.requestPluginApproval("c1", ORIGIN, { title: "  " })).rejects.toThrow(/title/);
    await expect(
      broker.requestPluginApproval("c1", ORIGIN, { title: "x", command: "a".repeat(8001) }),
    ).rejects.toThrow(/command is over/);
    await expect(
      broker.requestPluginApproval("c1", ORIGIN, { title: "x", machine: 42 as unknown as string }),
    ).rejects.toThrow(/machine must be a string/);
    for (const timeoutSeconds of [0, -1, 3601, Number.NaN]) {
      await expect(broker.requestPluginApproval("c1", ORIGIN, { title: "x", timeoutSeconds })).rejects.toThrow(
        /timeoutSeconds/,
      );
    }
    expect(events.some((e) => e.type === "permission-request")).toBe(false);
  });
});

describe("socketActor", () => {
  const user = (owner: boolean, disabled = false) => ({
    kind: "user" as const,
    sessionId: "s",
    securityVersion: 1,
    authEpoch: 1,
    user: {
      id: "u",
      username: "mike",
      displayName: "Michael",
      owner,
      disabled,
      createdAt: 1,
      hasPassword: true,
      passkeyCount: 0,
      totpEnabled: false,
    },
  });

  it("is the owner only for the owner's own session — or for anyone when sign-in is off", () => {
    expect(socketActor(user(true))).toEqual({ owner: true, name: "Michael" });
    expect(socketActor(user(false))).toEqual({ owner: false, name: "Michael" });
    expect(socketActor(user(true, true)).owner).toBe(false);
    expect(socketActor(undefined)).toEqual({ owner: true });
    expect(
      socketActor({ kind: "integration" } as unknown as Parameters<typeof socketActor>[0]).owner,
    ).toBe(false);
  });
});
