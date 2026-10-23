/**
 * Plugin terminal backends (#414): selection, async spawn, the loud local
 * fallback, a backend going away mid-session, lifecycle hooks, forwarded
 * ports — and that with NO backend registered nothing about a terminal
 * changes.
 *
 * Everything runs against a fake backend whose shell is a scripted
 * EventEmitter, the same way terminal.test.ts drives a fake PowerShell.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { TerminalBackend, TerminalSpawnInfo, WsServerEvent } from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { TerminalService, type ShellProcess } from "./terminal.js";
import { TerminalBackendRegistry } from "./terminal-backends.js";

/**
 * A scripted shell. `say X` prints X; every write carrying a sentinel marker
 * prints the marker line back. Records what was written, so a test can tell
 * which probe dialect reached it.
 */
class FakeShell extends EventEmitter implements ShellProcess {
  readonly writes: string[] = [];
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  private hanging = false;
  readonly stdin = {
    write: (chunk: string): void => {
      this.writes.push(chunk);
      for (const line of chunk.split("\n")) {
        const say = line.match(/^say\s+(.+)$/);
        if (say) this.stdout.emit("data", Buffer.from(`${say[1]}\n`));
        // `hang` never returns, like a dev server: its marker never prints.
        if (line === "hang") this.hanging = true;
        const marker = line.match(/CMTERMSENTINEL_[A-Za-z0-9_-]+/);
        if (marker && this.hanging) this.hanging = false;
        else if (marker) this.stdout.emit("data", Buffer.from(`${marker[0]}|0|True|${this.cwd}\n`));
      }
    },
  };
  constructor(readonly cwd: string) {
    super();
  }
  kill(): void {
    this.killed = true;
    this.emit("exit", null);
  }
}

let bus: EventBus;
let events: WsServerEvent[];
let services: TerminalService[];

beforeEach(() => {
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  services = [];
});

afterEach(() => {
  for (const s of services) s.dispose();
});

interface Harness {
  registry: TerminalBackendRegistry;
  svc: TerminalService;
  /** Local shells the service spawned. */
  local: FakeShell[];
  chats: Map<string, { terminalBackend?: string; projectId?: string }>;
  projectDefaults: Map<string, string>;
}

function setup(): Harness {
  const chats = new Map<string, { terminalBackend?: string; projectId?: string }>();
  const projectDefaults = new Map<string, string>();
  const registry = new TerminalBackendRegistry({
    bus,
    chat: async (id) => chats.get(id) ?? null,
    projectDefault: (pid) => projectDefaults.get(pid),
    repoPath: async () => "/repo",
  });
  const local: FakeShell[] = [];
  let n = 0;
  const svc = new TerminalService({
    bus,
    backends: registry,
    deps: {
      spawn: (cwd) => {
        const s = new FakeShell(cwd);
        local.push(s);
        return s;
      },
      flavour: "powershell",
      genId: () => `id${++n}`,
    },
  });
  registry.onDetach((id) => svc.detachBackend(id));
  services.push(svc);
  return { registry, svc, local, chats, projectDefaults };
}

/** A backend whose spawn the test controls. */
function fakeBackend(
  over: Partial<TerminalBackend> = {},
): TerminalBackend & { spawned: FakeShell[]; infos: TerminalSpawnInfo[]; idle: string[]; deleted: string[] } {
  const spawned: FakeShell[] = [];
  const infos: TerminalSpawnInfo[] = [];
  const idle: string[] = [];
  const deleted: string[] = [];
  return {
    id: "box",
    label: "Test box",
    shell: "bash",
    spawn: async (info) => {
      infos.push(info);
      const s = new FakeShell("/srv/repo");
      spawned.push(s);
      return s;
    },
    agentNote: () => "Your code reaches the box by magic.",
    onChatIdle: (e) => void idle.push(e.chatId),
    onChatDeleted: (e) => void deleted.push(e.chatId),
    ...over,
    spawned,
    infos,
    idle,
    deleted,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("with no backend registered", () => {
  it("spawns synchronously, sets no location and adds no notice", async () => {
    const { svc, local } = setup();
    const { terminal } = svc.create("c1", "main", "/work");
    // Synchronous: the shell exists the moment create() returns.
    expect(local).toHaveLength(1);
    expect(terminal?.location).toBeUndefined();
    const res = await svc.run({ chatId: "c1", name: "main", command: "say hi", cwd: "/work" });
    expect(res).toEqual({ output: "hi", exitCode: 0, cwd: "/work" });
    expect(events.some((e) => e.type === "terminal-backends")).toBe(false);
    // The PowerShell probe, as before.
    expect(local[0]!.writes.join("")).toContain("Write-Output");
  });
});

describe("selection", () => {
  it("chat pin beats project default beats local", async () => {
    const h = setup();
    h.registry.register(fakeBackend(), "plug");
    h.registry.register(fakeBackend({ id: "other", label: "Other" }), "plug");

    h.chats.set("c1", { projectId: "p1" });
    expect((await h.registry.resolve({ chatId: "c1" })).requested).toBe("local");

    h.projectDefaults.set("p1", "box");
    expect((await h.registry.resolve({ chatId: "c1" })).backend?.id).toBe("box");

    h.chats.set("c1", { projectId: "p1", terminalBackend: "other" });
    expect((await h.registry.resolve({ chatId: "c1" })).backend?.id).toBe("other");

    // An explicit chat `local` overrides a project default.
    h.chats.set("c1", { projectId: "p1", terminalBackend: "local" });
    const r = await h.registry.resolve({ chatId: "c1" });
    expect(r.requested).toBe("local");
    expect(r.backend).toBeUndefined();
  });

  it("a pin to an unregistered backend is reported missing, not read as local", async () => {
    const h = setup();
    h.registry.register(fakeBackend(), "plug");
    h.chats.set("c1", { terminalBackend: "gone" });
    expect(await h.registry.resolve({ chatId: "c1" })).toEqual({ requested: "gone", missing: true });
  });

  it("waits for plugin activation before calling a backend missing", async () => {
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    const registry = new TerminalBackendRegistry({
      bus,
      chat: async () => ({ terminalBackend: "box" }),
      projectDefault: () => undefined,
      settled: () => settled,
    });
    const pending = registry.resolve({ chatId: "c1" });
    registry.register(fakeBackend(), "plug");
    settle();
    expect((await pending).backend?.id).toBe("box");
  });

  it("refuses local, a taken id, and a bad shape", () => {
    const { registry } = setup();
    expect(() => registry.register(fakeBackend({ id: "local" }))).toThrow(/reserved/);
    registry.register(fakeBackend(), "a");
    expect(() => registry.register(fakeBackend(), "b")).toThrow(/already registered by plugin "a"/);
    expect(() => registry.register(fakeBackend({ id: "Bad Id" }))).toThrow(/must match/);
    expect(() => registry.register(fakeBackend({ id: "x", shell: "zsh" as never }))).toThrow(/shell/);
  });
});

describe("async spawn", () => {
  it("queues the command behind provisioning, speaks the backend's dialect, and says where it runs once", async () => {
    const h = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const backend = fakeBackend({
      spawn: async (info) => {
        backend.infos.push(info);
        await gate;
        const s = new FakeShell("/srv/repo");
        backend.spawned.push(s);
        return s;
      },
    });
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box", projectId: "p1" });

    const running = h.svc.run({ chatId: "c1", projectId: "p1", name: "build", command: "say built", cwd: "C:\\work" });
    await flush();
    const connecting = h.svc.listChat("c1")[0]!;
    expect(connecting.location).toEqual({ backend: "box", label: "Test box", state: "connecting" });
    expect(h.local).toHaveLength(0);

    release();
    const res = await running;
    expect(res.output).toBe("built");
    expect(res.cwd).toBe("/srv/repo");
    expect(res.notice).toContain("run on Test box, NOT on the Dispatch host");
    expect(res.notice).toContain("Your code reaches the box by magic.");
    // bash probe, not PowerShell, even though the host flavour is powershell.
    expect(backend.spawned[0]!.writes.join("")).toContain("printf");
    expect(backend.infos[0]).toMatchObject({ chatId: "c1", projectId: "p1", name: "build", cwd: "C:\\work", repoPath: "/repo" });
    // The handle reaches no pid, so nothing local is ever tree-killed for it.
    expect(h.svc.livePids()).toEqual([]);
    expect(h.svc.listChat("c1")[0]!.location?.state).toBe("ready");

    const again = await h.svc.run({ chatId: "c1", name: "build", command: "say again" });
    expect(again.notice).toBeUndefined();
  });

  it("takes the shell's starting cwd from the handle, so a background first command reports the far side's", async () => {
    const h = setup();
    h.registry.register(
      fakeBackend({
        spawn: async () => Object.assign(new FakeShell("/srv/repo"), { cwd: "/srv/repo" }),
      }),
      "plug",
    );
    h.chats.set("c1", { terminalBackend: "box" });
    const res = await h.svc.run({ chatId: "c1", name: "dev", command: "hang", cwd: "C:\\work", background: true });
    expect(res.backgrounded).toBe(true);
    expect(res.cwd).toBe("/srv/repo");
  });

  it("closing a terminal while it connects aborts the spawn and kills a late handle", async () => {
    const h = setup();
    let resolveSpawn!: (s: FakeShell) => void;
    let signal: AbortSignal | undefined;
    h.registry.register(
      fakeBackend({
        spawn: (info) => {
          signal = info.signal as AbortSignal;
          return new Promise((r) => (resolveSpawn = r));
        },
      }),
      "plug",
    );
    h.chats.set("c1", { terminalBackend: "box" });
    const { terminal } = h.svc.create("c1", "t", "/w");
    await flush();
    h.svc.kill(terminal!.id);
    expect(signal?.aborted).toBe(true);
    const late = new FakeShell("/x");
    resolveSpawn(late);
    await flush();
    expect(late.killed).toBe(true);
    expect(h.local).toHaveLength(0);
  });
});

describe("fallback", () => {
  it("a rejecting spawn brings up a local shell and says why — terminal, chat and tool result", async () => {
    const h = setup();
    h.registry.register(fakeBackend({ spawn: async () => Promise.reject(new Error("pveproxy is down")) }), "plug");
    h.chats.set("c1", { terminalBackend: "box" });

    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say local", cwd: "/w" });
    expect(res.output).toBe("local");
    expect(res.notice).toMatch(/Test box could not start a shell: pveproxy is down/);
    expect(res.notice).toMatch(/running LOCALLY/);
    expect(h.local).toHaveLength(1);
    // Local dialect again.
    expect(h.local[0]!.writes.join("")).toContain("Write-Output");

    const info = h.svc.listChat("c1")[0]!;
    expect(info.location).toMatchObject({ backend: "box", state: "fallback" });
    expect(info.location?.fallback).toContain("pveproxy is down");

    const notice = events.find((e) => e.type === "notice");
    expect(notice).toMatchObject({ type: "notice", chatId: "c1", level: "warn" });
    const lines = (await h.svc.scrollback(info.id)).map((l) => l.chunk);
    expect(lines.some((l) => l.includes("[dispatch]") && l.includes("LOCALLY"))).toBe(true);
  });

  it("a spawn that overruns spawnTimeoutMs falls back", async () => {
    const h = setup();
    h.registry.register(fakeBackend({ spawnTimeoutMs: 1_000, spawn: () => new Promise(() => {}) }), "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    const started = Date.now();
    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say ok", cwd: "/w" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(res.notice).toMatch(/no shell after 1s/);
    expect(res.output).toBe("ok");
  });

  it("a pin to a backend that is not installed falls back with that reason", async () => {
    const h = setup();
    h.registry.register(fakeBackend(), "plug");
    h.chats.set("c1", { terminalBackend: "proxmox" });
    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say x", cwd: "/w" });
    expect(res.notice).toMatch(/"proxmox" is not installed/);
    expect(h.svc.listChat("c1")[0]!.location).toMatchObject({ backend: "proxmox", state: "fallback" });
  });
});

describe("a backend going away mid-session", () => {
  it("ends its shells with a message; the next command re-resolves", async () => {
    const h = setup();
    const backend = fakeBackend();
    let disposed = false;
    backend.dispose = () => {
      disposed = true;
    };
    h.registry.register(backend, "plug");
    // Another backend stays registered, so the service keeps resolving.
    h.registry.register(fakeBackend({ id: "keep", label: "Keep" }), "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    const unpublish = h.registry.publishPort("box", { chatId: "c1", remotePort: 5173, url: "http://127.0.0.1:40001" });
    expect(typeof unpublish).toBe("function");

    await h.registry.unregister("box");
    expect(disposed).toBe(true);
    const info = h.svc.listChat("c1")[0]!;
    expect(info.status).toBe("exited");
    const lines = (await h.svc.scrollback(info.id)).map((l) => l.chunk);
    expect(lines.some((l) => l.includes('backend "box" went away'))).toBe(true);
    expect(h.registry.ports("c1")).toEqual([]);

    // The pin still names "box", which is gone now: local, loudly.
    const next = await h.svc.run({ chatId: "c1", name: "main", command: "say back", cwd: "/w" });
    expect(next.output).toBe("back");
    expect(next.notice).toMatch(/"box" is not installed/);
  });

  it("a shell still connecting when its backend goes away ends as exited", async () => {
    const h = setup();
    h.registry.register(fakeBackend({ spawn: () => new Promise(() => {}) }), "plug");
    h.registry.register(fakeBackend({ id: "keep", label: "Keep" }), "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    h.svc.create("c1", "t", "/w");
    await flush();
    await h.registry.unregister("box");
    await flush();
    expect(h.svc.listChat("c1")[0]!.status).toBe("exited");
  });
});

describe("lifecycle hooks and ports", () => {
  it("fans chatIdle / chatDeleted out to every backend; delete drops the chat's ports", async () => {
    const h = setup();
    const a = fakeBackend();
    const b = fakeBackend({ id: "b", label: "B" });
    h.registry.register(a, "plug");
    h.registry.register(b, "plug");
    h.registry.publishPort("box", { chatId: "c1", remotePort: 3000, url: "http://127.0.0.1:40000" });
    h.registry.publishPort("box", { chatId: "c2", remotePort: 3000, url: "http://127.0.0.1:40002" });

    h.registry.chatIdle({ chatId: "c1" });
    h.registry.chatDeleted({ chatId: "c1" });
    await flush();
    expect(a.idle).toEqual(["c1"]);
    expect(b.idle).toEqual(["c1"]);
    expect(a.deleted).toEqual(["c1"]);
    expect(h.registry.ports("c1")).toEqual([]);
    expect(h.registry.ports("c2")).toHaveLength(1);
  });

  it("a throwing hook is contained", async () => {
    const h = setup();
    h.registry.register(fakeBackend({ onChatDeleted: () => { throw new Error("boom"); } }), "plug");
    expect(() => h.registry.chatDeleted({ chatId: "c1" })).not.toThrow();
    await flush();
  });

  it("publishing the same chat + port replaces it, and a stale withdraw does not remove the new one", () => {
    const h = setup();
    h.registry.register(fakeBackend(), "plug");
    const first = h.registry.publishPort("box", { chatId: "c1", remotePort: 5173, url: "http://127.0.0.1:1" });
    h.registry.publishPort("box", { chatId: "c1", remotePort: 5173, url: "http://127.0.0.1:2" });
    first();
    expect(h.registry.ports("c1").map((p) => p.url)).toEqual(["http://127.0.0.1:2"]);
    expect(() => h.registry.publishPort("nope", { chatId: "c1", remotePort: 1, url: "http://x" })).toThrow(/not registered/);
    expect(() => h.registry.publishPort("box", { chatId: "c1", remotePort: 1, url: "file:///x" })).toThrow(/http/);
  });

  it("broadcasts a snapshot on every change", () => {
    const h = setup();
    h.registry.register(fakeBackend(), "plug");
    h.registry.publishPort("box", { chatId: "c1", remotePort: 8080, url: "http://127.0.0.1:9" });
    const last = events.filter((e) => e.type === "terminal-backends").at(-1);
    expect(last).toEqual({
      type: "terminal-backends",
      backends: [{ id: "box", label: "Test box", shell: "bash", pluginId: "plug" }],
      ports: [{ chatId: "c1", backend: "box", remotePort: 8080, url: "http://127.0.0.1:9" }],
    });
  });

  it("agentNote is undefined for a local chat and composed for a backend chat", async () => {
    const h = setup();
    expect(await h.registry.agentNote("c1")).toBeUndefined();
    h.registry.register(fakeBackend(), "plug");
    h.chats.set("c1", {});
    expect(await h.registry.agentNote("c1")).toBeUndefined();
    h.chats.set("c1", { terminalBackend: "box" });
    const note = await h.registry.agentNote("c1");
    expect(note).toContain("Keep git local");
    expect(note).toContain("by magic");
  });
});
