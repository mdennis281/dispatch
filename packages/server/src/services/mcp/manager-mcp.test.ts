import { describe, it, expect, beforeEach } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ChatStatus, WsServerEvent, ProjectMemory } from "@cm/shared";
import { EventBus } from "../../bus.js";
import {
  createManagerTools,
  createManagerMcpServer,
  WAIT_CAP_SECONDS,
  type ManagerMcpBroker,
  type ManagerMcpMemory,
} from "./manager-mcp.js";

/* ------------------------------------------------------------------ fixtures */

let bus: EventBus;
let events: WsServerEvent[];

beforeEach(() => {
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
});

/** A scriptable broker whose per-chat status the test controls. */
function fakeBroker(states: Record<string, ChatStatus>): ManagerMcpBroker {
  return {
    has: (id) => id in states,
    getStatus: (id) => states[id],
  };
}

function resultText(res: CallToolResult): string {
  const first = res.content[0];
  return first && first.type === "text" ? first.text : "";
}

function statusLabels(): string[] {
  return events
    .filter((e): e is Extract<WsServerEvent, { type: "chat-status" }> => e.type === "chat-status")
    .map((e) => e.activity?.label ?? "");
}

/* -------------------------------------------------------------------- wait */

describe("manager-mcp — wait", () => {
  it("resolves after the delay and publishes a waiting chat-status", async () => {
    const { wait } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
    });

    const res = await wait.handler({ seconds: 0.02, reason: "CI to settle" }, {});

    expect(resultText(res)).toContain("Waited 0.02s");
    expect(resultText(res)).toContain("CI to settle");
    // The self-imposed pause surfaces via the working/typing status header.
    expect(statusLabels().some((l) => l === "waiting 0.02s: CI to settle")).toBe(true);
  });

  it("clamps seconds to the cap", async () => {
    const { wait } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}) });
    // A huge request would hang forever if not clamped — but we abort immediately
    // to keep the test fast while still exercising the clamp in the status label.
    const ac = new AbortController();
    const p = wait.handler({ seconds: 999_999, reason: undefined }, { signal: ac.signal });
    ac.abort();
    await p;
    expect(statusLabels().some((l) => l === `waiting ${WAIT_CAP_SECONDS}s`)).toBe(true);
  });

  it("cancels the wait when the session signal aborts (clears the timer)", async () => {
    const ac = new AbortController();
    const { wait } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      signal: ac.signal,
    });

    // 100s would exceed the test timeout if the abort didn't unwind the timer.
    const p = wait.handler({ seconds: 100, reason: "long" }, {});
    ac.abort();
    const res = await p;

    expect(resultText(res)).toContain("cancelled");
  });

  it("also cancels via the MCP request's extra.signal", async () => {
    const { wait } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}) });
    const ac = new AbortController();
    const p = wait.handler({ seconds: 100, reason: undefined }, { signal: ac.signal });
    ac.abort();
    const res = await p;
    expect(resultText(res)).toContain("cancelled");
  });
});

/* ------------------------------------------------------------ wait_for_chat */

describe("manager-mcp — wait_for_chat", () => {
  it("resolves when the target chat transitions to a terminal state", async () => {
    const { waitForChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({ c2: "running" }),
    });

    const p = waitForChat.handler({ chatId: "c2", timeoutSeconds: undefined }, {});
    // Subscription is registered synchronously before the handler awaits, so a
    // status published now is observed.
    bus.publish({ type: "chat-status", chatId: "c2", status: "done" });
    const res = await p;

    expect(resultText(res)).toContain('Chat c2 reached state "done"');
    expect(resultText(res)).toContain('"finalState":"done"');
    expect(resultText(res)).toContain('"timedOut":false');
  });

  it("ignores status of OTHER chats while waiting", async () => {
    const { waitForChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({ c2: "running" }),
    });

    const p = waitForChat.handler({ chatId: "c2", timeoutSeconds: 0.05 }, {});
    // A terminal state on an unrelated chat must NOT resolve this wait.
    bus.publish({ type: "chat-status", chatId: "c9", status: "done" });
    const res = await p;

    // Only the timeout should end it (c2 never went terminal).
    expect(resultText(res)).toContain("Timed out");
  });

  it("resolves immediately when the chat is already at rest", async () => {
    const { waitForChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({ c2: "idle" }),
    });

    const res = await waitForChat.handler({ chatId: "c2", timeoutSeconds: undefined }, {});
    expect(resultText(res)).toContain('Chat c2 reached state "idle"');
    expect(resultText(res)).toContain('"timedOut":false');
  });

  it("returns an informative (error) result for an unknown chatId", async () => {
    const { waitForChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
    });

    const res = await waitForChat.handler({ chatId: "ghost", timeoutSeconds: undefined }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain('Unknown chatId "ghost"');
  });

  it("times out and reports the last known state", async () => {
    const { waitForChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({ c2: "running" }),
    });

    const res = await waitForChat.handler({ chatId: "c2", timeoutSeconds: 0.02 }, {});
    expect(resultText(res)).toContain("Timed out waiting for chat c2");
    expect(resultText(res)).toContain("running");
    expect(resultText(res)).toContain('"timedOut":true');
  });

  it("cancels when the session signal aborts", async () => {
    const ac = new AbortController();
    const { waitForChat } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({ c2: "running" }),
      signal: ac.signal,
    });

    const p = waitForChat.handler({ chatId: "c2", timeoutSeconds: undefined }, {});
    ac.abort();
    const res = await p;
    expect(resultText(res)).toContain("cancelled");
  });
});

/* -------------------------------------------------------------- terminal */

describe("manager-mcp — terminal", () => {
  it("runs a command in a named terminal and returns output/exit/cwd", async () => {
    const calls: { name: string; command: string }[] = [];
    const { terminal } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      terminals: {
        run: async ({ name, command }) => {
          calls.push({ name, command });
          return { output: "build ok", exitCode: 0, cwd: "C:\\repo" };
        },
      },
    });

    const res = await terminal.handler({ name: "build", command: "pnpm build", timeoutMs: undefined }, {});
    expect(calls).toEqual([{ name: "build", command: "pnpm build" }]);
    expect(res.isError).toBeFalsy();
    expect(resultText(res)).toContain("[build]");
    expect(resultText(res)).toContain("cwd=C:\\repo");
    expect(resultText(res)).toContain("exit=0");
    expect(resultText(res)).toContain("build ok");
  });

  it("surfaces a runner error as an error result", async () => {
    const { terminal } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      terminals: {
        run: async () => ({
          output: "",
          exitCode: null,
          cwd: "",
          error: "Terminal cap reached (8 shells for this chat).",
        }),
      },
    });
    const res = await terminal.handler({ name: "x", command: "ls", timeoutMs: undefined }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("cap reached");
  });

  it("reports unavailable when no TerminalService is wired", async () => {
    const { terminal } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}) });
    const res = await terminal.handler({ name: "x", command: "ls", timeoutMs: undefined }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("not available");
  });

  it("validates a non-empty command", async () => {
    const { terminal } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      terminals: { run: async () => ({ output: "", exitCode: 0, cwd: "" }) },
    });
    const res = await terminal.handler({ name: "x", command: "   ", timeoutMs: undefined }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("requires a command");
  });
});

/* --------------------------------------------------------------- memory */

/** An in-memory ManagerMcpMemory (round-trip without touching the fs). */
function fakeMemory(): ManagerMcpMemory & { data: Map<string, ProjectMemory> } {
  const data = new Map<string, ProjectMemory>();
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return {
    data,
    remember: async (input) => {
      const name = slug(input.name);
      const m: ProjectMemory = {
        projectId: "p1",
        name,
        description: input.description,
        type: input.type,
        body: input.body,
        file: `${name}.md`,
        updatedAt: 1,
      };
      data.set(name, m);
      return m;
    },
    recall: async (query) => {
      const all = [...data.values()];
      const index = `# Project memory\n${all
        .map((m) => `- [${m.name}](${m.file}) — ${m.description}`)
        .join("\n")}`;
      if (!query) return { index, matches: [] };
      const q = query.toLowerCase();
      return {
        index,
        matches: all.filter(
          (m) =>
            m.name.includes(q) ||
            m.description.toLowerCase().includes(q) ||
            m.body.toLowerCase().includes(q),
        ),
      };
    },
    forget: async (name) => data.delete(slug(name)),
  };
}

describe("manager-mcp — memory tools", () => {
  it("remember → recall → forget round-trips a project memory", async () => {
    const mem = fakeMemory();
    const { remember, recall, forget } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      memory: mem,
    });

    const rem = await remember.handler(
      { name: "Deploy Runbook", description: "how we ship", type: "project", body: "run pnpm ship" },
      {},
    );
    expect(rem.isError).toBeFalsy();
    expect(resultText(rem)).toContain("deploy-runbook");
    expect(mem.data.has("deploy-runbook")).toBe(true);

    // recall with no query returns the index…
    const idx = await recall.handler({ query: undefined }, {});
    expect(resultText(idx)).toContain("[deploy-runbook](deploy-runbook.md)");

    // …and a query returns the full body.
    const hit = await recall.handler({ query: "ship" }, {});
    expect(resultText(hit)).toContain("run pnpm ship");

    const gone = await forget.handler({ name: "deploy-runbook" }, {});
    expect(gone.isError).toBeFalsy();
    expect(resultText(gone)).toContain("Forgot");
    expect(mem.data.has("deploy-runbook")).toBe(false);
  });

  it("recall reports no matches (still returns the index) for a miss", async () => {
    const mem = fakeMemory();
    await mem.remember({ name: "x", description: "d", type: "project", body: "b" });
    const { recall } = createManagerTools({ chatId: "c1", bus, broker: fakeBroker({}), memory: mem });
    const res = await recall.handler({ query: "nomatch" }, {});
    expect(resultText(res)).toContain('No memories matched "nomatch"');
  });

  it("forget of a missing memory is an informative error result", async () => {
    const { forget } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      memory: fakeMemory(),
    });
    const res = await forget.handler({ name: "ghost" }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("No memory named");
  });

  it("remember requires a non-empty name", async () => {
    const { remember } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
      memory: fakeMemory(),
    });
    const res = await remember.handler({ name: "   ", description: "", type: "project", body: "b" }, {});
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain("non-empty name");
  });

  it("reports unavailable when no MemoryService is wired", async () => {
    const { remember, recall, forget } = createManagerTools({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
    });
    for (const res of [
      await remember.handler({ name: "a", description: "", type: "project", body: "b" }, {}),
      await recall.handler({ query: undefined }, {}),
      await forget.handler({ name: "a" }, {}),
    ]) {
      expect(res.isError).toBe(true);
      expect(resultText(res)).toContain("not available");
    }
  });
});

/* --------------------------------------------------------- server assembly */

describe("manager-mcp — server factory", () => {
  it("builds an in-process SDK MCP server named 'manager'", () => {
    const server = createManagerMcpServer({
      chatId: "c1",
      bus,
      broker: fakeBroker({}),
    });
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("manager");
    expect(server.instance).toBeDefined();
  });
});
