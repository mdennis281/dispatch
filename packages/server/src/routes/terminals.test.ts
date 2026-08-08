/**
 * Integration tests for the terminal routes. Real Fastify app + Store, with the
 * TerminalService's shell spawn replaced by a scripted fake — no real
 * powershell.exe, and no risk of a test leaking a live child process.
 *
 * These routes are the human-facing half of a feature that shipped agent-only:
 * `mcp__manager__terminal` was the sole way to get a shell, so the Terminals tab
 * was permanently empty for anyone who'd never watched an agent open one. The
 * behaviour worth pinning here is that the two doors reach the SAME shell (cwd
 * resolved by the same rule) and that the failure modes are honest status codes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { TerminalInfo } from "@dispatch/shared";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { EventBus } from "../bus.js";
import { Store } from "../store/index.js";
import { TerminalService, type ShellProcess, type SpawnShell } from "../services/terminal.js";

/** A shell that only knows how to echo the service's sentinel marker back. */
class FakeShell extends EventEmitter implements ShellProcess {
  killed = false;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: { write: (c: string) => void };

  constructor(readonly cwd: string) {
    super();
    this.stdin = {
      write: (chunk) => {
        for (const line of chunk.split("\n")) {
          const marker = line.match(/CMTERM[A-Za-z0-9_-]+/);
          if (marker) {
            this.stdout.emit("data", Buffer.from(`${marker[0]}|0|True|${this.cwd}\n`));
          } else if (line.trim()) {
            this.stdout.emit("data", Buffer.from(`ran: ${line.trim()}\n`));
          }
        }
      },
    };
  }

  kill(): void {
    this.killed = true;
    this.emit("exit", 0);
  }
}

let app: FastifyInstance;
let dir: string;
let shells: FakeShell[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-terminals-"));
  shells = [];
  const spawn: SpawnShell = (cwd) => {
    const s = new FakeShell(cwd);
    shells.push(s);
    return s;
  };
  const store = new Store(dir);
  await store.init();
  const bus = new EventBus();
  app = await buildApp({
    config: { ...loadConfig(), dataDir: dir },
    store,
    bus,
    serviceOverrides: { terminals: new TerminalService({ bus, deps: { spawn } }) },
  });
});

afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

async function makeChat(): Promise<string> {
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "Widget", repoPath: dir, worktreeRoot: "wt" },
  });
  const chat = await app.inject({
    method: "POST",
    url: "/api/chats",
    payload: { projectId: project.json().id, title: "First" },
  });
  return chat.json().id as string;
}

describe("POST /api/terminals", () => {
  it("opens an empty shell rooted at the chat's working directory", async () => {
    const chatId = await makeChat();
    const res = await app.inject({
      method: "POST",
      url: "/api/terminals",
      payload: { chatId, name: "shell" },
    });
    expect(res.statusCode).toBe(200);

    const info = res.json() as TerminalInfo;
    expect(info).toMatchObject({ chatId, name: "shell", status: "live", cwd: dir });
    expect(info.lastCommand).toBeUndefined();
    expect(shells).toHaveLength(1);

    // And it shows up in the chat's list, exactly like an agent-opened one.
    const list = await app.inject({ method: "GET", url: `/api/terminals?chatId=${chatId}` });
    expect((list.json() as TerminalInfo[]).map((t) => t.name)).toEqual(["shell"]);
  });

  it("400s without a chatId or a name; 404s for an unknown chat", async () => {
    const chatId = await makeChat();
    const noChat = await app.inject({ method: "POST", url: "/api/terminals", payload: {} });
    expect(noChat.statusCode).toBe(400);
    const noName = await app.inject({
      method: "POST",
      url: "/api/terminals",
      payload: { chatId, name: "  " },
    });
    expect(noName.statusCode).toBe(400);
    const unknown = await app.inject({
      method: "POST",
      url: "/api/terminals",
      payload: { chatId: "nope", name: "shell" },
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("POST /api/terminals/run", () => {
  it("runs in the shell POST /api/terminals opened — one shell, not two", async () => {
    const chatId = await makeChat();
    await app.inject({ method: "POST", url: "/api/terminals", payload: { chatId, name: "shell" } });

    const res = await app.inject({
      method: "POST",
      url: "/api/terminals/run",
      payload: { chatId, name: "shell", command: "echo hi" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ exitCode: 0, cwd: dir });
    expect(res.json().output).toContain("ran: echo hi");
    expect(shells).toHaveLength(1);

    // The scrollback the panel re-hydrates from carries the command echo.
    const out = await app.inject({
      method: "GET",
      url: `/api/terminals/${encodeURIComponent(`${chatId}::shell`)}/output`,
    });
    expect((out.json() as { stream: string; chunk: string }[])).toContainEqual(
      expect.objectContaining({ stream: "command", chunk: "echo hi" }),
    );
  });

  it("spawns lazily when the name is new — same as the MCP tool's behaviour", async () => {
    const chatId = await makeChat();
    const res = await app.inject({
      method: "POST",
      url: "/api/terminals/run",
      payload: { chatId, name: "build", command: "echo hi" },
    });
    expect(res.statusCode).toBe(200);
    expect(shells).toHaveLength(1);
  });

  it("400s on an empty command rather than opening a shell for nothing", async () => {
    const chatId = await makeChat();
    const res = await app.inject({
      method: "POST",
      url: "/api/terminals/run",
      payload: { chatId, name: "shell", command: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(shells).toHaveLength(0);
  });
});

describe("DELETE /api/terminals/:id", () => {
  it("kills the shell and drops it from the list", async () => {
    const chatId = await makeChat();
    await app.inject({ method: "POST", url: "/api/terminals", payload: { chatId, name: "shell" } });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/terminals/${encodeURIComponent(`${chatId}::shell`)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(shells[0]!.killed).toBe(true);

    const list = await app.inject({ method: "GET", url: `/api/terminals?chatId=${chatId}` });
    expect(list.json()).toEqual([]);
  });

  it("404s for an unknown terminal", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/terminals/nope" });
    expect(res.statusCode).toBe(404);
  });
});
