/**
 * Integration tests for the routes/WS layer. Real Fastify app (listening on an
 * ephemeral port), real Store + EventBus + service container, with only the SDK
 * `query` (SessionBroker) and `gh`/execa (GitHubService) replaced by scripted
 * fakes — no subprocess, no network, no real git/gh. Exercises REST CRUD, the
 * multiplexed WS event stream, inbound-action dispatch (send-message, permission
 * answer), the global Attention Queue, and a gh-action.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { SessionBroker, type QueryFn } from "../services/session-broker.js";
import { GitHubService, type ExecaLike } from "../services/github.js";
import { DEFAULT_MAX_ACTIVE_SESSIONS, type WsServerEvent } from "@dispatch/shared";

/* --------------------------------------------------------------- scripted SDK */

interface FakeCtl {
  canUseTool?: (
    n: string,
    i: Record<string, unknown>,
    o: Record<string, unknown>,
  ) => Promise<{ behavior: string; [k: string]: unknown }>;
  pushed: string[];
}
type PerTurn = (
  text: string,
  ctl: FakeCtl,
) => Promise<Record<string, unknown>[]> | Record<string, unknown>[];

function extractText(um: unknown): string {
  const content = (um as { message?: { content?: unknown } })?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
  }
  return "";
}
function initMsg(sessionId: string) {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "claude-test",
    apiKeySource: "none",
    tools: [],
    mcp_servers: [],
    permissionMode: "default",
  };
}
function assistantText(text: string) {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: "a-uuid",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}
function resultMsg() {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result: "ok",
    duration_ms: 5,
  };
}

/** A turn killed by a subscription limit — how the SDK actually reports it. */
function limitResultMsg(text: string) {
  return {
    type: "result",
    subtype: "success",
    is_error: true,
    num_turns: 1,
    result: text,
    duration_ms: 5,
  };
}

function makeFakeQuery(perTurn: PerTurn, sessionId = "sess-1"): QueryFn {
  return ({ prompt, options }) => {
    const ctl: FakeCtl = {
      canUseTool: (options as { canUseTool?: FakeCtl["canUseTool"] } | undefined)?.canUseTool,
      pushed: [],
    };
    async function* gen(): AsyncGenerator<unknown, void> {
      yield initMsg(sessionId);
      for await (const um of prompt as AsyncIterable<unknown>) {
        const text = extractText(um);
        ctl.pushed.push(text);
        const msgs = await perTurn(text, ctl);
        for (const m of msgs) yield m;
      }
    }
    const g = gen() as unknown as Record<string, unknown>;
    g.interrupt = async () => {};
    g.setPermissionMode = async () => {};
    g.setModel = async () => {};
    g.setMaxThinkingTokens = async () => {};
    g.setMcpPermissionModeOverride = async () => ({});
    return g as unknown as ReturnType<QueryFn>;
  };
}

/* ------------------------------------------------------------- scripted gh */

const PR_JSON = {
  number: 5,
  url: "https://github.com/acme/widget/pull/5",
  title: "Test PR",
  state: "OPEN",
  headRefName: "feat/x",
  baseRefName: "main",
  isDraft: false,
  labels: [] as Array<{ name: string }>,
  mergeable: "MERGEABLE",
};

const fakeGhExec: ExecaLike = async (_file, args = []) => {
  const a = args.join(" ");
  if (a.includes("repo view")) return { stdout: "acme/widget", exitCode: 0 };
  if (a.startsWith("pr view")) return { stdout: JSON.stringify(PR_JSON), exitCode: 0 };
  if (a.startsWith("pr checks")) return { stdout: "[]", exitCode: 0 };
  if (a.startsWith("api graphql")) {
    return {
      stdout: JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
      }),
      exitCode: 0,
    };
  }
  return { stdout: "", exitCode: 0 };
};

/* --------------------------------------------------------------- ws helpers */

interface WsClient {
  events: WsServerEvent[];
  send(obj: unknown): void;
  waitFor(pred: (e: WsServerEvent) => boolean, ms?: number): Promise<WsServerEvent>;
  close(): void;
}

function connect(port: number): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events: WsServerEvent[] = [];
    const waiters: Array<{ pred: (e: WsServerEvent) => boolean; resolve: (e: WsServerEvent) => void }> = [];
    ws.addEventListener("message", (ev) => {
      const e = JSON.parse(String((ev as MessageEvent).data)) as WsServerEvent;
      events.push(e);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(e)) {
          waiters[i].resolve(e);
          waiters.splice(i, 1);
        }
      }
    });
    ws.addEventListener("error", () => reject(new Error("ws error")));
    ws.addEventListener("open", () => {
      resolve({
        events,
        send: (obj) => ws.send(JSON.stringify(obj)),
        waitFor: (pred, ms = 3000) =>
          new Promise<WsServerEvent>((res, rej) => {
            const hit = events.find(pred);
            if (hit) return res(hit);
            const t = setTimeout(() => rej(new Error("waitFor: timeout")), ms);
            waiters.push({ pred, resolve: (e) => { clearTimeout(t); res(e); } });
          }),
        close: () => ws.close(),
      });
    });
  });
}

/* ------------------------------------------------------------------ fixtures */

let dir: string;
let store: Store;
let bus: EventBus;
let app: FastifyInstance;
let port: number;

async function boot(query: QueryFn): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "cm-routes-"));
  store = new Store(dir);
  await store.init();
  bus = new EventBus();
  const broker = new SessionBroker({ store, bus, deps: { query } });
  const github = new GitHubService({ bus, store, exec: fakeGhExec });
  const config = { ...loadConfig(), dataDir: dir };
  app = await buildApp({ config, store, bus, serviceOverrides: { broker, github } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
}

afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

async function makeProject(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Widget", repoPath: dir, worktreeRoot: "wt" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/* -------------------------------------------------------------------- tests */

describe("routes — REST CRUD", () => {
  beforeEach(async () => {
    await boot(makeFakeQuery(() => [assistantText("hi"), resultMsg()]));
  });

  it("health, project + chat CRUD, messages, attention snapshot", async () => {
    // Only the environment-independent half is asserted here: whether the SPA
    // shell is on disk depends on whether the client happens to have been
    // built, and app.test.ts drives both sides of that deliberately.
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().store).toBe(true);
    expect(health.json().pid).toBe(process.pid);

    const projectId = await makeProject();
    const projects = await app.inject({ method: "GET", url: "/api/projects" });
    expect(projects.json().map((p: { id: string }) => p.id)).toContain(projectId);

    const chatRes = await app.inject({
      method: "POST",
      url: "/api/chats",
      payload: { projectId, title: "First" },
    });
    expect(chatRes.statusCode).toBe(201);
    const chatId = chatRes.json().id as string;

    const chats = await app.inject({
      method: "GET",
      url: `/api/chats?projectId=${projectId}`,
    });
    expect(chats.json().map((c: { id: string }) => c.id)).toContain(chatId);

    const msgs = await app.inject({ method: "GET", url: `/api/chats/${chatId}/messages` });
    expect(msgs.json()).toEqual([]);

    const att = await app.inject({ method: "GET", url: "/api/attention" });
    expect(att.json()).toEqual([]);
  });

  it("PUT /api/settings hands the concurrency cap to the LIVE broker", async () => {
    // The cap is held in memory and never re-read per turn, so a save that only
    // reached config.json would be a setting that does nothing until the next
    // restart — which is what it was before it became a setting at all.
    const saved = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { theme: "dark", maxActiveSessions: 2 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().maxActiveSessions).toBe(2);
    expect(app.services.broker.maxActive).toBe(2);

    // Cleared → the value the server booted with, NOT "unlimited".
    const cleared = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { theme: "dark" },
    });
    expect(cleared.statusCode).toBe(200);
    expect(app.services.broker.maxActive).toBe(DEFAULT_MAX_ACTIVE_SESSIONS);

    // Zero is refused rather than silently clamped to one: a cap of nothing is a
    // typo, and honouring it would wedge every chat in the app.
    const bad = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { theme: "dark", maxActiveSessions: 0 },
    });
    expect(bad.statusCode).toBe(400);
    expect(app.services.broker.maxActive).toBe(DEFAULT_MAX_ACTIVE_SESSIONS);
  });

  it("GET /messages serves a LEAN window, and /messages/full rehydrates it", async () => {
    const projectId = await makeProject();
    const chatRes = await app.inject({
      method: "POST",
      url: "/api/chats",
      payload: { projectId, title: "Long" },
    });
    const chatId = chatRes.json().id as string;

    const big = "z".repeat(20_000);
    for (let i = 0; i < 12; i++) {
      await store.appendMessage({
        kind: "tool_use",
        id: `u${i}`,
        chatId,
        ts: i * 2,
        toolUseId: `t${i}`,
        name: "Bash",
        input: { command: `run ${i}`, script: big },
      });
      await store.appendMessage({
        kind: "tool_result",
        id: `r${i}`,
        chatId,
        ts: i * 2 + 1,
        toolUseId: `t${i}`,
        ok: true,
        content: big,
      });
    }

    // Default: a bounded window of CLIPPED rows — the collapsed cards' data only.
    const lean = await app.inject({ method: "GET", url: `/api/chats/${chatId}/messages?limit=6` });
    const leanRows = lean.json() as Array<Record<string, unknown>>;
    expect(leanRows).toHaveLength(6);
    expect(leanRows.map((r) => r.id)).toEqual(["u9", "r9", "u10", "r10", "u11", "r11"]);
    expect(lean.body.length).toBeLessThan(6_000); // vs ~120 KB unclipped
    const leanUse = leanRows.find((r) => r.id === "u11")!;
    expect(leanUse.inputOmitted).toBe(true);
    expect((leanUse.input as Record<string, unknown>).command).toBe("run 11");
    expect((leanUse.input as Record<string, unknown>).script).toBeUndefined();

    // Paging upward from the oldest row we hold.
    const older = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages?limit=4&beforeId=u9`,
    });
    expect((older.json() as Array<{ id: string }>).map((r) => r.id)).toEqual([
      "u7",
      "r7",
      "u8",
      "r8",
    ]);

    // Hydrate-on-expand: the verbatim rows behind two clipped ones.
    const full = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages/full?ids=u11,r11`,
    });
    const fullRows = full.json() as Array<Record<string, unknown>>;
    expect(fullRows.map((r) => r.id)).toEqual(["u11", "r11"]);
    expect((fullRows[0]!.input as Record<string, unknown>).script).toBe(big);
    expect(fullRows[1]!.content).toBe(big);
    expect(fullRows[0]!.inputOmitted).toBeUndefined();

    // `full=1` opts the window itself out of the projection.
    const rawWindow = await app.inject({
      method: "GET",
      url: `/api/chats/${chatId}/messages?limit=2&full=1`,
    });
    expect((rawWindow.json() as Array<{ content?: string }>)[1]!.content).toBe(big);

    const noIds = await app.inject({ method: "GET", url: `/api/chats/${chatId}/messages/full` });
    expect(noIds.statusCode).toBe(400);
  });

  it("POST /api/projects auto-scaffolds a .dispatch/ into an existing repo", async () => {
    const repo = await mkdtemp(join(tmpdir(), "cm-repo-"));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "Widget", repoPath: repo, worktreeRoot: "wt" },
      });
      expect(res.statusCode).toBe(201);
      const manifest = join(repo, ".dispatch", "project.yaml");
      expect(existsSync(manifest)).toBe(true);
      expect(readFileSync(manifest, "utf8")).toContain("name: Widget");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("POST /api/projects with a non-existent repoPath creates no stray dirs", async () => {
    const missing = join(dir, "does-not-exist-repo");
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Ghost", repoPath: missing, worktreeRoot: "wt" },
    });
    expect(res.statusCode).toBe(201);
    expect(existsSync(missing)).toBe(false);
  });

  it("POST /api/projects with initRepo creates the directory and git-inits it", async () => {
    // The new-project page's "I'm starting a project" path: the human names a
    // directory that doesn't exist yet, and create makes it a repo on the trunk
    // the project record already committed to.
    const fresh = join(dir, "brand-new-project");
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Brand New",
        repoPath: fresh,
        worktreeRoot: ".worktrees",
        defaultBranch: "trunk",
        initRepo: true,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(existsSync(join(fresh, ".git"))).toBe(true);
    // The initial branch matches the project's declared trunk — a repo that
    // landed on `master` while the config says otherwise breaks diff-vs-base.
    expect(readFileSync(join(fresh, ".git", "HEAD"), "utf8")).toContain("refs/heads/trunk");
    // The repo now exists, so the scaffold ran too.
    expect(existsSync(join(fresh, ".dispatch", "project.yaml"))).toBe(true);
  });

  it("initRepo leaves an existing checkout's git dir alone", async () => {
    const repo = await mkdtemp(join(tmpdir(), "cm-existing-"));
    try {
      // A `.git` that is deliberately NOT a real repo: if create touched it,
      // `git init` would have replaced this with a directory.
      await writeFile(join(repo, ".git"), "gitdir: /elsewhere");
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "Adopted", repoPath: repo, worktreeRoot: "wt", initRepo: true },
      });
      expect(res.statusCode).toBe(201);
      expect(readFileSync(join(repo, ".git"), "utf8")).toBe("gitdir: /elsewhere");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("initRepo never nests a repo inside an existing checkout", async () => {
    const outer = await mkdtemp(join(tmpdir(), "cm-monorepo-"));
    try {
      await writeFile(join(outer, ".git"), "gitdir: /elsewhere");
      // A path INSIDE that repo has no `.git` of its own but is already tracked;
      // git-initting it would give it a second, empty history.
      const inner = join(outer, "apps", "service");
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "Nested", repoPath: inner, worktreeRoot: ".worktrees", initRepo: true },
      });
      expect(res.statusCode).toBe(201);
      expect(existsSync(join(inner, ".git"))).toBe(false);
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  it("initRepo refuses a relative repoPath instead of git-initting the server's cwd", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Relative",
        repoPath: "some-relative-dir",
        worktreeRoot: ".worktrees",
        initRepo: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/absolute/i);
    expect(existsSync("some-relative-dir")).toBe(false);
  });

  it("initRepo creates nothing when the branch name isn't a legal ref", async () => {
    // `main..` passes the shell-safety filter but git rejects it. The repo must
    // not be left behind on `master` — the create guard would then skip the fix.
    const fresh = join(dir, "bad-branch-project");
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Bad Branch",
        repoPath: fresh,
        worktreeRoot: ".worktrees",
        defaultBranch: "main..",
        initRepo: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(existsSync(join(fresh, ".git"))).toBe(false);
  });

  it("rejects a chat with no projectId and a project with no name", async () => {
    const badChat = await app.inject({ method: "POST", url: "/api/chats", payload: {} });
    expect(badChat.statusCode).toBe(400);
    const badProject = await app.inject({ method: "POST", url: "/api/projects", payload: {} });
    expect(badProject.statusCode).toBe(400);
  });

  it("DELETE /api/chats/:id removes the chat + its transcript", async () => {
    const projectId = await makeProject();
    const chatId = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        payload: { projectId, title: "Junk" },
      })
    ).json().id as string;

    const del = await app.inject({ method: "DELETE", url: `/api/chats/${chatId}` });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({ method: "GET", url: `/api/chats/${chatId}` });
    expect(after.statusCode).toBe(404);

    const list = await app.inject({
      method: "GET",
      url: `/api/chats?projectId=${projectId}`,
    });
    expect(list.json().map((c: { id: string }) => c.id)).not.toContain(chatId);
  });

  it("DELETE broadcasts chat-deleted + resolves the 'Session ended' attention of an interacted chat", async () => {
    const projectId = await makeProject();
    const chatId = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        payload: { projectId, title: "Junk" },
      })
    ).json().id as string;

    // Interact so a live broker session exists — delete then settles it via
    // onDone, which publishes the "Session ended" attention item that (pre-fix)
    // stranded on every client because no resolve/delete event ever followed.
    const ws = await connect(port);
    await ws.waitFor((e) => e.type === "hello");
    ws.send({ type: "send-message", chatId, text: "hi" });
    await ws.waitFor(
      (e) => e.type === "chat-status" && e.chatId === chatId && e.status === "idle",
    );

    // Subscribe just before delete so we capture the delete-driven fan-out.
    const seen: WsServerEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const del = await app.inject({ method: "DELETE", url: `/api/chats/${chatId}` });
    expect(del.statusCode).toBe(204);

    const added = seen.find(
      (e) => e.type === "attention-add" && e.item.chatId === chatId && e.item.kind === "done",
    );
    expect(added).toBeDefined();
    const addedId = (added as Extract<WsServerEvent, { type: "attention-add" }>).item.id;
    expect(
      seen.some((e) => e.type === "attention-resolve" && e.id === addedId),
    ).toBe(true);
    expect(
      seen.some((e) => e.type === "chat-deleted" && e.chatId === chatId),
    ).toBe(true);

    ws.close();
    // Server queue is empty too (no phantom lingers server-side).
    const att = await app.inject({ method: "GET", url: "/api/attention" });
    expect(att.json()).toEqual([]);
  });
});

describe("routes — usage-limit auto-resume", () => {
  const LIMIT = "You've hit your session limit · resets 4:50pm (America/Chicago)";

  /** Drive a chat into the limit state and hand back its id. */
  async function hitLimit(): Promise<string> {
    const projectId = await makeProject();
    const chatId = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        payload: { projectId, title: "Long job" },
      })
    ).json().id as string;
    const done = new Promise<void>((resolve) => {
      const off = bus.on("chat-status", (e) => {
        if (e.chatId === chatId && e.status === "failed") {
          off();
          resolve();
        }
      });
    });
    const ws = await connect(port);
    ws.send({ type: "send-message", chatId, text: "do the long thing" });
    await done;
    ws.close();
    return chatId;
  }

  it("schedules a resume off the limit result, and cancels it on request", async () => {
    await boot(makeFakeQuery(() => [assistantText(LIMIT), limitResultMsg(LIMIT)]));
    // The plan is persisted just AFTER the turn fails (the scheduler reads
    // and rewrites the chat), so wait for the broadcast that carries it.
    const planned$ = new Promise<void>((resolve) => {
      const off = bus.on("chat-update", (e) => {
        if (e.chat.resume) {
          off();
          resolve();
        }
      });
    });
    const chatId = await hitLimit();
    await planned$;

    // The chat now carries a plan pointing at the next 4:50pm America/Chicago.
    const planned = (await app.inject({ method: "GET", url: `/api/chats/${chatId}` })).json();
    expect(planned.resume).toMatchObject({ reason: LIMIT });
    expect(planned.resume.at).toBeGreaterThan(Date.now());
    expect(planned.resume.cancelledAt).toBeUndefined();

    // Cancelling records it and returns the updated chat…
    const cancel = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/resume/cancel`,
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().resume.cancelledAt).toBeGreaterThan(0);

    // …and a second cancel is a 409, not a silent success.
    const again = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/resume/cancel`,
    });
    expect(again.statusCode).toBe(409);

    const missing = await app.inject({
      method: "POST",
      url: "/api/chats/nope/resume/cancel",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("leaves an ordinary turn error alone — nothing is scheduled to cancel", async () => {
    await boot(
      makeFakeQuery(() => [assistantText("boom"), limitResultMsg("Error: ECONNRESET")]),
    );
    const chatId = await hitLimit();

    const chat = (await app.inject({ method: "GET", url: `/api/chats/${chatId}` })).json();
    expect(chat.resume).toBeUndefined();
    const cancel = await app.inject({
      method: "POST",
      url: `/api/chats/${chatId}/resume/cancel`,
    });
    expect(cancel.statusCode).toBe(409);
  });
});

describe("routes — WebSocket", () => {
  it("connect gets hello; send-message streams assistant + status over the socket", async () => {
    await boot(makeFakeQuery(() => [assistantText("echo"), resultMsg()]));
    const projectId = await makeProject();
    const chatRes = await app.inject({
      method: "POST",
      url: "/api/chats",
      payload: { projectId },
    });
    const chatId = chatRes.json().id as string;

    const ws = await connect(port);
    await ws.waitFor((e) => e.type === "hello");

    const parts = [{ kind: "instructions" as const, label: "Re-answer", text: "hello" }];
    ws.send({ type: "send-message", chatId, parts });

    const user = await ws.waitFor(
      (e) => e.type === "chat-message" && e.chatId === chatId && e.message.kind === "user",
    );
    expect(user.type === "chat-message" && user.message.kind === "user" && user.message.parts).toEqual(
      parts,
    );
    expect(user.type === "chat-message" && user.message.kind === "user" && user.message.text).toBe(
      "**Re-answer**\n\nhello",
    );

    const asst = await ws.waitFor(
      (e) => e.type === "chat-message" && e.chatId === chatId && e.message.kind === "assistant",
    );
    expect(asst.type).toBe("chat-message");
    await ws.waitFor((e) => e.type === "chat-status" && e.chatId === chatId && e.status === "idle");
    ws.close();
  });

  it("set-title renames the chat and broadcasts chat-update", async () => {
    await boot(makeFakeQuery(() => [resultMsg()]));
    const projectId = await makeProject();
    const chatId = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        payload: { projectId, title: "Old title" },
      })
    ).json().id as string;

    const ws = await connect(port);
    await ws.waitFor((e) => e.type === "hello");
    ws.send({ type: "set-title", chatId, title: "Renamed" });

    const upd = await ws.waitFor(
      (e) => e.type === "chat-update" && e.chat.id === chatId && e.chat.title === "Renamed",
    );
    expect(upd.type).toBe("chat-update");

    const persisted = await app.inject({ method: "GET", url: `/api/chats/${chatId}` });
    expect(persisted.json().title).toBe("Renamed");
    ws.close();
  });

  it("detach-worktree unlinks a mis-attributed worktree from the chat (no disk delete)", async () => {
    await boot(makeFakeQuery(() => [resultMsg()]));
    const projectId = await makeProject();
    const chatId = (
      await app.inject({
        method: "POST",
        url: "/api/chats",
        payload: { projectId, title: "Task 1" },
      })
    ).json().id as string;

    // Simulate a stale mis-attribution: a sibling task's worktree wrongly recorded
    // on this chat's `worktrees[]`.
    const chat = await store.getChat(chatId);
    await store.saveChat({
      ...chat!,
      worktrees: [`${dir}/wt/feat-mine`, `${dir}/wt/feat-wrong`],
    });

    const ws = await connect(port);
    await ws.waitFor((e) => e.type === "hello");
    ws.send({ type: "detach-worktree", chatId, worktreePath: `${dir}/wt/feat-wrong` });

    const upd = await ws.waitFor(
      (e) =>
        e.type === "chat-update" &&
        e.chat.id === chatId &&
        !e.chat.worktrees.includes(`${dir}/wt/feat-wrong`),
    );
    expect(upd.type).toBe("chat-update");
    if (upd.type === "chat-update") {
      expect(upd.chat.worktrees).toEqual([`${dir}/wt/feat-mine`]);
    }

    // The record is persisted (disk worktree — had there been one — is untouched).
    const persisted = await app.inject({ method: "GET", url: `/api/chats/${chatId}` });
    expect(persisted.json().worktrees).toEqual([`${dir}/wt/feat-mine`]);
    ws.close();
  });

  it("permission request lands in the Attention Queue and answer-permission resolves it", async () => {
    // The fake awaits the broker's canUseTool promise, which only settles once
    // the host answers the permission (via the answer-permission action).
    const query = makeFakeQuery(async (_text, ctl) => {
      if (!ctl.canUseTool) return [assistantText("no-tool"), resultMsg()];
      await ctl.canUseTool("Write", { file_path: "a.txt" }, {});
      return [assistantText("done"), resultMsg()];
    });
    await boot(query);
    const projectId = await makeProject();
    const chatId = (
      await app.inject({ method: "POST", url: "/api/chats", payload: { projectId } })
    ).json().id as string;

    const ws = await connect(port);
    await ws.waitFor((e) => e.type === "hello");
    ws.send({ type: "send-message", chatId, text: "edit the file" });

    const permEvt = await ws.waitFor((e) => e.type === "permission-request");
    const requestId =
      permEvt.type === "permission-request" ? permEvt.request.id : "";
    expect(requestId).toBeTruthy();

    // The global Attention Queue REST snapshot now shows the pending permission.
    const att = await app.inject({ method: "GET", url: "/api/attention" });
    const items = att.json() as Array<{ kind: string; chatId: string }>;
    expect(items.some((i) => i.kind === "permission" && i.chatId === chatId)).toBe(true);

    ws.send({ type: "answer-permission", chatId, requestId, decision: "allow" });
    await ws.waitFor((e) => e.type === "permission-resolved");
    // The canUseTool promise resolved → the fake proceeds to its result → idle.
    await ws.waitFor((e) => e.type === "chat-status" && e.chatId === chatId && e.status === "idle");
    ws.close();
  });
});

describe("routes — WebSocket liveness", () => {
  it("answers a ping with a pong carrying the same nonce", async () => {
    // The client's only way to tell an idle socket from a dead one. The
    // transport ping the server already sends cannot do it: browsers expose no
    // ping/pong event to JavaScript, so nothing observes those.
    await boot(makeFakeQuery(() => [resultMsg()]));
    const ws = await connect(port);
    await ws.waitFor((e) => e.type === "hello");

    ws.send({ type: "ping", nonce: "abc123" });
    const pong = await ws.waitFor((e) => e.type === "pong");
    expect(pong.type === "pong" && pong.nonce).toBe("abc123");
    ws.close();
  });

  it("does not answer a ping with an error the way an unknown action would", async () => {
    await boot(makeFakeQuery(() => [resultMsg()]));
    const ws = await connect(port);
    await ws.waitFor((e) => e.type === "hello");

    ws.send({ type: "ping", nonce: "n1" });
    await ws.waitFor((e) => e.type === "pong");
    expect(ws.events.some((e) => e.type === "error")).toBe(false);

    // …whereas something genuinely unknown still is an error, so the heartbeat
    // isn't accidentally swallowing schema failures.
    ws.send({ type: "definitely-not-an-action" });
    const err = await ws.waitFor((e) => e.type === "error");
    expect(err.type === "error" && err.message).toBe("invalid client action");
    ws.close();
  });
});

describe("routes — gh-action", () => {
  it("POST /api/github/action refresh publishes a pr-update", async () => {
    await boot(makeFakeQuery(() => [resultMsg()]));
    const projectId = await makeProject();
    const seen: WsServerEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const res = await app.inject({
      method: "POST",
      url: "/api/github/action",
      payload: { op: "refresh", projectId, prNumber: 5 },
    });
    expect(res.statusCode).toBe(202);
    const pr = seen.find((e) => e.type === "pr-update");
    expect(pr && pr.type === "pr-update" && pr.pr.number).toBe(5);
  });
});
