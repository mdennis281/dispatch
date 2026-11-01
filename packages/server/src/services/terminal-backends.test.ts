/**
 * Plugin terminal backends (#414): selection, async spawn, the loud local
 * fallback, a backend going away mid-session, lifecycle hooks, forwarded
 * ports — and that with NO backend registered nothing about a terminal
 * changes.
 *
 * Everything runs against a fake backend whose shell is a scripted
 * EventEmitter, the same way terminal.test.ts drives a fake PowerShell.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  TerminalAfterRunInfo,
  TerminalBackend,
  TerminalRunInfo,
  TerminalSpawnInfo,
  WsServerEvent,
} from "@dispatch/shared";
import { EventBus } from "../bus.js";
import { StateDb } from "../store/db.js";
import { TerminalService, type ShellProcess } from "./terminal.js";
import { unwrapCommandWrite } from "./terminal.testkit.js";
import {
  TerminalBackendRegistry,
  stateDbBackendMemory,
  type KnownTerminalBackend,
  type TerminalBackendMemory,
} from "./terminal-backends.js";

/**
 * A scripted shell. `say X` prints X; every write carrying a sentinel marker
 * prints the marker line back. Records what was written, so a test can tell
 * which probe dialect reached it, and the commands it ran with
 * `commandWrite`'s stdin isolation taken off.
 */
class FakeShell extends EventEmitter implements ShellProcess {
  readonly writes: string[] = [];
  readonly ran: string[] = [];
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  private hanging = false;
  readonly stdin = {
    write: (chunk: string): void => {
      this.writes.push(chunk);
      for (const line of unwrapCommandWrite(chunk).split("\n")) {
        if (line && !line.includes("CMTERMSENTINEL_")) this.ran.push(line);
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
  chats: Map<string, { terminalBackend?: string; projectId?: string; worktreePath?: string }>;
  projectDefaults: Map<string, string>;
  /** The allowed-locations layers, mutable per test. Empty ⇒ no choice (the default). */
  allowed: { project?: string[]; app?: string[] };
  /** Directories the registry asked for a branch, in order. */
  branchAsked: string[];
}

function setup(
  opts: {
    stallPauseMaxMs?: number;
    memory?: TerminalBackendMemory;
    /** Wraps the harness's branch lookup — to hold `resolve` inside its awaits. */
    gateBranch?: () => Promise<void>;
  } = {},
): Harness {
  const { memory, gateBranch, ...svcOpts } = opts;
  const chats = new Map<string, { terminalBackend?: string; projectId?: string; worktreePath?: string }>();
  const projectDefaults = new Map<string, string>();
  const allowed: { project?: string[]; app?: string[] } = {};
  const branchAsked: string[] = [];
  const registry = new TerminalBackendRegistry({
    bus,
    chat: async (id) => chats.get(id) ?? null,
    projectDefault: (pid) => projectDefaults.get(pid),
    allowedLocations: () => allowed,
    repoPath: async () => "/repo",
    branchOf: async (dir) => {
      await gateBranch?.();
      branchAsked.push(dir);
      return dir === "/wt/feat-x" ? "feat/x" : "main";
    },
    ...(memory ? { memory } : {}),
  });
  const local: FakeShell[] = [];
  let n = 0;
  const svc = new TerminalService({
    bus,
    backends: registry,
    ...svcOpts,
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
  // As container.ts wires it.
  registry.onChange((id, change) => svc.backendChanged(id, change));
  services.push(svc);
  return { registry, svc, local, chats, projectDefaults, allowed, branchAsked };
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
    expect(await h.registry.resolve({ chatId: "c1" })).toEqual({ requested: "gone", missing: true, fallback: "local" });
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

/** A {@link TerminalBackendMemory} that outlives the registry it is handed to — a restart. */
function mapMemory(): TerminalBackendMemory & { rows: Map<string, KnownTerminalBackend> } {
  const rows = new Map<string, KnownTerminalBackend>();
  return { rows, remember: (b) => void rows.set(b.id, b), recall: (id) => rows.get(id) };
}

describe("fallback: refuse", () => {
  // A backend whose far side is a different OS (a Mac) must never have its
  // commands handed to PowerShell on the Dispatch host.
  const mac = (over: Partial<TerminalBackend> = {}) =>
    fakeBackend({ id: "mac", label: "cvx-mac", fallback: "refuse", ...over });

  it("a rejecting spawn starts NO local shell: the run fails naming the backend and the reason", async () => {
    const h = setup();
    h.registry.register(mac({ spawn: async () => Promise.reject(new Error("host unreachable")) }), "remote-host");
    h.chats.set("c1", { terminalBackend: "mac" });

    const res = await h.svc.run({ chatId: "c1", name: "build", command: "say rm -rf dist", cwd: "/w" });
    expect(h.local).toHaveLength(0);
    expect(res.output).toBe("");
    expect(res.exitCode).toBeNull();
    expect(res.error).toMatch(/did not start on cvx-mac \(`mac`\): cvx-mac could not start a shell: host unreachable/);
    expect(res.error).toMatch(/Nothing ran/);
    // It ran nowhere, so it must not claim a place.
    expect(res.ranOn).toBeUndefined();

    const info = h.svc.listChat("c1")[0]!;
    expect(info.status).toBe("exited");
    expect(info.location).toMatchObject({ backend: "mac", label: "cvx-mac", state: "failed" });
    expect(info.location?.error).toContain("host unreachable");
    expect(info.location?.fallback).toBeUndefined();
    expect(events.find((e) => e.type === "notice")).toMatchObject({ chatId: "c1", level: "error" });
    const lines = (await h.svc.scrollback(info.id)).map((l) => l.chunk);
    expect(lines.some((l) => l.includes("[dispatch]") && l.includes("never falls back"))).toBe(true);
  });

  it("every run queued behind the failed spawn fails too, and the next one retries the backend", async () => {
    const h = setup();
    let attempts = 0;
    const backend = mac({
      spawn: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("asleep");
        const s = new FakeShell("/Users/dispatch/w");
        backend.spawned.push(s);
        return s;
      },
    });
    h.registry.register(backend, "remote-host");
    h.chats.set("c1", { terminalBackend: "mac" });
    const [a, b] = await Promise.all([
      h.svc.run({ chatId: "c1", name: "build", command: "say one", cwd: "/w" }),
      h.svc.run({ chatId: "c1", name: "build", command: "say two", cwd: "/w" }),
    ]);
    expect(a.error).toMatch(/asleep/);
    expect(b.error).toMatch(/asleep/);
    const again = await h.svc.run({ chatId: "c1", name: "build", command: "say three", cwd: "/w" });
    expect(again.error).toBeUndefined();
    expect(again.output).toBe("three");
    expect(again.ranOn).toEqual({ id: "mac", label: "cvx-mac" });
    // The refused one never started: there was no cwd or env to lose.
    expect(again.notice ?? "").not.toMatch(/is a NEW shell/);
    expect(attempts).toBe(2);
    expect(h.local).toHaveLength(0);
  });

  it("a spawn that overruns spawnTimeoutMs is refused, not run locally", async () => {
    const h = setup();
    h.registry.register(mac({ spawnTimeoutMs: 1_000, spawn: () => new Promise(() => {}) }), "remote-host");
    h.chats.set("c1", { terminalBackend: "mac" });
    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say ok", cwd: "/w" });
    expect(res.error).toMatch(/no shell after 1s/);
    expect(h.local).toHaveLength(0);
  });

  it("an explicit `location` to a refusing backend fails the same way", async () => {
    const h = setup();
    h.registry.register(mac({ spawn: async () => Promise.reject(new Error("offline")) }), "remote-host");
    h.chats.set("c1", {});
    const res = await h.svc.run({ chatId: "c1", name: "ios", command: "say x", cwd: "/w", location: "mac" });
    expect(res.error).toMatch(/did not start on cvx-mac/);
    expect(h.local).toHaveLength(0);
  });

  it("a chat pinned to it while its plugin is switched off is refused — the policy was remembered", async () => {
    // Exactly ONE backend, as on a real install: once it unregisters, the
    // registry is empty and nothing registered can say what it wanted.
    const h = setup();
    h.registry.register(mac(), "remote-host");
    h.chats.set("c1", { terminalBackend: "mac" });
    h.registry.notePin("c1", "mac");
    await h.registry.unregister("mac");
    expect(h.registry.size).toBe(0);

    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say x", cwd: "/w" });
    expect(h.local).toHaveLength(0);
    expect(res.error).toMatch(/the terminal backend "mac" \(cvx-mac\) is not installed, or its plugin is switched off/);
    expect(h.svc.listChat("c1")[0]!.location).toMatchObject({ backend: "mac", label: "cvx-mac", state: "failed" });
  });

  it("the policy survives a restart through the backend memory", async () => {
    const memory = mapMemory();
    const before = setup({ memory });
    before.registry.register(mac(), "remote-host");
    expect(memory.rows.get("mac")).toMatchObject({ label: "cvx-mac", pluginId: "remote-host", fallback: "refuse" });

    // The next boot: the plugin is off, so nothing ever registers "mac".
    const after = setup({ memory });
    after.chats.set("c1", { terminalBackend: "mac" });
    after.registry.notePin("c1", "mac");
    const res = await after.svc.run({ chatId: "c1", name: "main", command: "say x", cwd: "/w" });
    expect(res.error).toMatch(/Nothing ran/);
    expect(after.local).toHaveLength(0);
  });

  it("an id never seen registered still falls back locally (today's behaviour, and proxmox's)", async () => {
    const h = setup({ memory: mapMemory() });
    h.chats.set("c1", { terminalBackend: "proxmox" });
    h.registry.notePin("c1", "proxmox");
    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say x", cwd: "/w" });
    expect(res.output).toBe("x");
    expect(res.notice).toMatch(/"proxmox" is not installed/);
  });

  it("a backend that declares nothing keeps the loud local fallback", async () => {
    const h = setup();
    h.registry.register(fakeBackend({ spawn: async () => Promise.reject(new Error("down")) }), "proxmox-terminal");
    h.chats.set("c1", { terminalBackend: "box" });
    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say here", cwd: "/w" });
    expect(res.output).toBe("here");
    expect(res.notice).toMatch(/running LOCALLY/);
    expect(h.registry.list()[0]).toMatchObject({ id: "box", fallback: "local" });
  });

  it("register refuses a policy it does not know, and lists the one it does", () => {
    const h = setup();
    expect(() => h.registry.register(mac({ fallback: "sometimes" as never }))).toThrow(/fallback must be "local" or "refuse"/);
    h.registry.register(mac(), "remote-host");
    expect(h.registry.list()).toEqual([
      { id: "mac", label: "cvx-mac", shell: "bash", pluginId: "remote-host", fallback: "refuse" },
    ]);
  });

  it("the agent is told a refusing backend's commands FAIL rather than run here", async () => {
    const h = setup();
    h.registry.register(mac(), "remote-host");
    h.chats.set("c1", { terminalBackend: "mac" });
    expect(await h.registry.agentNote("c1")).toContain("When cvx-mac cannot start a shell, the command FAILS");
    h.allowed.app = ["local", "mac"];
    const choice = (await h.registry.agentNote("c1"))!;
    expect(choice).toContain("- `mac` — cvx-mac (the default).\n  When cvx-mac cannot start a shell, the command FAILS");
  });

  it("a memory that cannot be written does not stop the backend registering", () => {
    const h = setup({
      memory: {
        remember: () => {
          throw new Error("disk full");
        },
        recall: () => undefined,
      },
    });
    h.registry.register(mac(), "remote-host");
    expect(h.registry.has("mac")).toBe(true);
    expect(h.registry.fallbackOf("mac")).toBe("refuse");
  });
});

describe("stateDbBackendMemory", () => {
  let dir: string;
  let db: StateDb;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cm-term-backends-"));
    db = new StateDb(dir);
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a backend, updates it in place, and reads an unknown policy as refuse", () => {
    const memory = stateDbBackendMemory(db);
    expect(memory.recall("mac")).toBeUndefined();
    memory.remember({ id: "mac", label: "Mac", pluginId: "remote-host", fallback: "refuse", seenAt: 1 });
    memory.remember({ id: "mac", label: "cvx-mac", pluginId: "remote-host", fallback: "refuse", seenAt: 2 });
    memory.remember({ id: "proxmox", label: "Proxmox", fallback: "local", seenAt: 3 });
    expect(memory.recall("mac")).toEqual({ id: "mac", label: "cvx-mac", pluginId: "remote-host", fallback: "refuse", seenAt: 2 });
    expect(memory.recall("proxmox")).toEqual({ id: "proxmox", label: "Proxmox", fallback: "local", seenAt: 3 });
    db.prepare("UPDATE terminal_backend SET fallback = 'later-policy' WHERE id = 'proxmox'").run();
    expect(memory.recall("proxmox")?.fallback).toBe("refuse");
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
    // Named with the label it was last registered under, not just the bare id.
    expect(next.notice).toMatch(/"box" \(Test box\) is not installed/);
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

describe("with exactly one backend plugin (the real case)", () => {
  // The registry is EMPTY in every one of these — the one backend plugin is
  // off, uninstalled, or not activated yet. `size === 0` must not be read as
  // "nothing to resolve" for a chat that names a backend (review on #415).

  it("a chat pinned to the only backend, while it is unregistered, falls back loudly", async () => {
    const h = setup();
    h.registry.notePin("c1", "proxmox");
    h.chats.set("c1", { terminalBackend: "proxmox" });
    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say x", cwd: "/w" });
    expect(res.notice).toMatch(/"proxmox" is not installed/);
    expect(h.svc.listChat("c1")[0]!.location).toMatchObject({ backend: "proxmox", state: "fallback" });
  });

  it("a project default naming a backend resolves too, pin or no pin", async () => {
    const h = setup();
    h.projectDefaults.set("p1", "proxmox");
    h.chats.set("c1", { projectId: "p1" });
    const res = await h.svc.run({ chatId: "c1", projectId: "p1", name: "main", command: "say x", cwd: "/w" });
    expect(res.notice).toMatch(/"proxmox" is not installed/);
  });

  it("an unpinned chat in an unpinned project still takes the synchronous local path", () => {
    const h = setup();
    h.svc.create("c1", "main", "/w", { projectId: "p1" });
    expect(h.local).toHaveLength(1);
    expect(h.svc.listChat("c1")[0]!.location).toBeUndefined();
  });

  it("pins arrive by seed and by chat-update, and leave by chat-deleted or a local pin", () => {
    const h = setup();
    h.registry.seed([{ id: "a", terminalBackend: "proxmox" }, { id: "b" }, { id: "c", terminalBackend: "local" }]);
    expect(h.registry.wantsResolve({ chatId: "a" })).toBe(true);
    expect(h.registry.wantsResolve({ chatId: "b" })).toBe(false);
    expect(h.registry.wantsResolve({ chatId: "c" })).toBe(false);
    bus.publish({ type: "chat-update", chat: { id: "b", terminalBackend: "proxmox" } as never });
    expect(h.registry.wantsResolve({ chatId: "b" })).toBe(true);
    bus.publish({ type: "chat-update", chat: { id: "b", terminalBackend: "local" } as never });
    expect(h.registry.wantsResolve({ chatId: "b" })).toBe(false);
    bus.publish({ type: "chat-deleted", chatId: "a" });
    expect(h.registry.wantsResolve({ chatId: "a" })).toBe(false);
  });

  it("a pinned chat opened before the plugin activates waits for it, then runs there", async () => {
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    const chats = new Map([["c1", { terminalBackend: "proxmox" }]]);
    const registry = new TerminalBackendRegistry({
      bus,
      chat: async (id) => chats.get(id) ?? null,
      projectDefault: () => undefined,
      settled: () => settled,
    });
    registry.seed([{ id: "c1", terminalBackend: "proxmox" }]);
    const local: FakeShell[] = [];
    const svc = new TerminalService({
      bus,
      backends: registry,
      deps: { spawn: (cwd) => (local.push(new FakeShell(cwd)), local.at(-1)!), flavour: "powershell" },
    });
    services.push(svc);
    const running = svc.run({ chatId: "c1", name: "main", command: "say there", cwd: "/w" });
    await flush();
    const backend = fakeBackend({ id: "proxmox", label: "Proxmox" });
    registry.register(backend, "proxmox-terminal");
    settle();
    const res = await running;
    expect(res.output).toBe("there");
    expect(backend.spawned).toHaveLength(1);
    expect(local).toHaveLength(0);
  });

  it("deactivating the only backend ends its shells, and the next command warns", async () => {
    const h = setup();
    h.registry.register(fakeBackend({ id: "proxmox", label: "Proxmox" }), "proxmox-terminal");
    h.chats.set("c1", { terminalBackend: "proxmox" });
    h.registry.notePin("c1", "proxmox");
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    await h.registry.unregister("proxmox");
    expect(h.registry.size).toBe(0);
    expect(h.svc.listChat("c1")[0]!.status).toBe("exited");
    const next = await h.svc.run({ chatId: "c1", name: "main", command: "say back", cwd: "/w" });
    expect(next.output).toBe("back");
    expect(next.notice).toMatch(/"proxmox" \(Proxmox\) is not installed/);
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
      backends: [{ id: "box", label: "Test box", shell: "bash", pluginId: "plug", fallback: "local" }],
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

describe("persisted ids this version cannot read (E12a)", () => {
  // `future:box` stands for an id a NEWER instance sharing config/ wrote.

  it("a chat pinned to one is refused — never run here — though this instance never saw it", async () => {
    const h = setup();
    h.registry.register(fakeBackend(), "plug");
    h.chats.set("c1", { terminalBackend: "future:box" });
    h.registry.notePin("c1", "future:box");
    expect(h.registry.fallbackOf("future:box")).toBe("refuse");

    const res = await h.svc.run({ chatId: "c1", name: "build", command: "say x", cwd: "/w" });
    expect(res.error).toMatch(
      /did not start on future:box \(`future:box`\): the terminal backend "future:box" is not one this version can use: this version of Dispatch cannot read the id/,
    );
    expect(h.local).toHaveLength(0);
  });

  it("an allowed one is unavailable with that reason, and a pick of it is refused saying so", async () => {
    const h = setup();
    h.registry.register(fakeBackend(), "plug");
    h.chats.set("c1", { projectId: "p1" });
    h.allowed.app = ["local", "box", "future:box"];

    const choices = await h.registry.locations({ chatId: "c1" });
    expect(choices.options.map((o) => o.id)).toEqual(["local", "box"]);
    expect(choices.unavailable).toEqual(["future:box"]);
    expect(choices.reasons?.["future:box"]).toMatch(/^this version of Dispatch cannot read the id/);
    const refused = await h.registry.checkLocation({ chatId: "c1" }, "future:box");
    expect((refused as { error: string }).error).toMatch(
      /"future:box" is allowed but not available right now — this version of Dispatch cannot read the id/,
    );
    expect((await h.registry.agentNote("c1"))!).toContain("- `future:box` — future:box. UNAVAILABLE right now: this version");
  });
});

describe("per-terminal location (the agent's choice)", () => {
  // ONE registered backend throughout, on purpose: the old pin-cache bug hid
  // behind a second backend keeping `size > 0`, and so would a per-terminal
  // pick that only "works" because something else forced a resolve.

  it("is off by default: no list means no choice and no note for an unpinned chat", async () => {
    const h = setup();
    h.registry.register(fakeBackend(), "plug");
    h.chats.set("c1", { projectId: "p1" });
    const choices = await h.registry.locations({ chatId: "c1" });
    expect(choices).toEqual({
      defaultId: "local",
      options: [{ id: "local", label: "this machine (the Dispatch host)", isDefault: true }],
      unavailable: [],
      allowed: [{ id: "local", label: "this machine (the Dispatch host)", isDefault: true }],
      offered: false,
      enabled: false,
    });
    expect(await h.registry.agentNote("c1")).toBeUndefined();
  });

  it("the project list overrides the app's whole, and [] switches the choice off", async () => {
    const h = setup();
    h.registry.register(fakeBackend(), "plug");
    h.chats.set("c1", { projectId: "p1" });
    h.allowed.app = ["local", "box"];
    expect((await h.registry.locations({ chatId: "c1" })).options.map((o) => o.id)).toEqual(["local", "box"]);
    h.allowed.project = [];
    expect((await h.registry.locations({ chatId: "c1" })).enabled).toBe(false);
    // The default is always pickable on top of the list.
    h.allowed.project = ["box"];
    const c = await h.registry.locations({ chatId: "c1" });
    expect(c.enabled).toBe(true);
    expect(c.options).toEqual([
      { id: "local", label: "this machine (the Dispatch host)", isDefault: true },
      { id: "box", label: "Test box", isDefault: false },
    ]);
  });

  it("refuses a location that is not allowed, or allowed but not registered, naming the allowed list", async () => {
    const h = setup();
    h.chats.set("c1", { projectId: "p1" });
    h.allowed.app = ["local", "box"];
    // The only backend plugin is off: `box` is allowed but cannot run.
    const off = await h.registry.checkLocation({ chatId: "c1" }, "box");
    expect(off).toEqual({ ok: false, error: expect.stringMatching(/"box" is allowed but not available right now/) });
    expect((await h.registry.locations({ chatId: "c1" })).unavailable).toEqual(["box"]);

    h.registry.register(fakeBackend(), "plug");
    expect(await h.registry.checkLocation({ chatId: "c1" }, "box")).toEqual({ ok: true, label: "Test box" });
    const nope = await h.registry.checkLocation({ chatId: "c1" }, "elsewhere");
    expect(nope.ok).toBe(false);
    expect(!nope.ok && nope.error).toMatch(/"elsewhere" is not an allowed terminal location.*Allowed: `local`, `box`/);
  });

  it("mixes locations in ONE unpinned chat: a build on the backend, a quick command local", async () => {
    const h = setup();
    const box = fakeBackend();
    h.registry.register(box, "plug");
    h.chats.set("c1", { projectId: "p1" });

    const build = await h.svc.run({ chatId: "c1", projectId: "p1", name: "build", command: "say remote", cwd: "/w", location: "box" });
    expect(build.output).toBe("remote");
    expect(build.ranOn).toEqual({ id: "box", label: "Test box" });
    expect(box.spawned).toHaveLength(1);

    const quick = await h.svc.run({ chatId: "c1", projectId: "p1", name: "quick", command: "say here", cwd: "/w" });
    expect(quick.output).toBe("here");
    expect(quick.ranOn).toEqual({ id: "local", label: "this machine" });
    expect(h.local).toHaveLength(1);

    const byName = Object.fromEntries(h.svc.listChat("c1").map((t) => [t.name, t.location]));
    expect(byName.build).toMatchObject({ backend: "box", state: "ready" });
    expect(byName.quick).toBeUndefined();
  });

  it("a terminal's location is fixed: a different one is refused, the same one or none runs", async () => {
    const h = setup();
    const box = fakeBackend();
    h.registry.register(box, "plug");
    h.chats.set("c1", {});
    await h.svc.run({ chatId: "c1", name: "build", command: "say a", cwd: "/w", location: "box" });

    const moved = await h.svc.run({ chatId: "c1", name: "build", command: "say b", location: "local" });
    expect(moved.error).toMatch(/Terminal 'build' already runs on Test box \(`box`\).*fixed for its life/);
    expect(h.local).toHaveLength(0);
    expect(box.spawned).toHaveLength(1);

    expect((await h.svc.run({ chatId: "c1", name: "build", command: "say c", location: "box" })).output).toBe("c");
    expect((await h.svc.run({ chatId: "c1", name: "build", command: "say d" })).output).toBe("d");
  });

  it("a shell opened with no location learns its placement on resolve, so a later different pick is refused", async () => {
    const h = setup();
    h.registry.register(fakeBackend(), "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    h.registry.notePin("c1", "box");
    // Two calls race the connect: the second carries a location the first's
    // shell will turn out not to have.
    const first = h.svc.run({ chatId: "c1", name: "main", command: "say one", cwd: "/w" });
    const second = h.svc.run({ chatId: "c1", name: "main", command: "say two", location: "local" });
    expect((await first).output).toBe("one");
    expect((await second).error).toMatch(/already runs on Test box/);
  });

  it("`local` in a chat pinned to the backend is a plain local shell, spawned synchronously", () => {
    const h = setup();
    const box = fakeBackend();
    h.registry.register(box, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    h.registry.notePin("c1", "box");
    h.svc.create("c1", "pinned", "/w");
    void h.svc.run({ chatId: "c1", name: "quick", command: "say x", cwd: "/w", location: "local" });
    // `quick` spawned in the same tick, no resolve; `pinned` is still connecting.
    expect(h.local).toHaveLength(1);
    expect(h.svc.listChat("c1").find((t) => t.name === "quick")!.location).toBeUndefined();
  });

  it("an explicit pick to a backend whose spawn fails falls back, and the result says so", async () => {
    const h = setup();
    h.registry.register(fakeBackend({ spawn: async () => { throw new Error("no capacity"); } }), "plug");
    h.chats.set("c1", {});
    const res = await h.svc.run({ chatId: "c1", name: "build", command: "say x", cwd: "/w", location: "box" });
    expect(res.ranOn).toEqual({ id: "local", label: "this machine", fallbackFrom: "Test box" });
    expect(res.notice).toMatch(/could not start a shell: no capacity/);
    // Asking for the same place again is not "a different location".
    expect((await h.svc.run({ chatId: "c1", name: "build", command: "say y", location: "box" })).error).toBeUndefined();
    // And a refusal names where it REALLY runs, not the backend it asked for.
    const moved = await h.svc.run({ chatId: "c1", name: "build", command: "say z", location: "local" });
    expect(moved.error).toMatch(/already runs on this machine \(a fallback — Test box could not start it\)/);
  });

  it("lifecycle hooks reach the backend a chat used only through a per-terminal pick", async () => {
    const h = setup();
    const box = fakeBackend();
    h.registry.register(box, "plug");
    h.chats.set("c1", { projectId: "p1" });
    await h.svc.run({ chatId: "c1", projectId: "p1", name: "build", command: "say x", cwd: "/w", location: "box" });
    h.registry.chatIdle({ chatId: "c1", projectId: "p1" });
    h.svc.killChat("c1");
    h.registry.chatDeleted({ chatId: "c1", projectId: "p1" });
    await flush();
    expect(box.idle).toEqual(["c1"]);
    expect(box.deleted).toEqual(["c1"]);
  });

  it("the agent note lists every option with its backend's lines, for an UNPINNED chat", async () => {
    const h = setup();
    h.registry.register(fakeBackend(), "plug");
    h.chats.set("c1", { projectId: "p1" });
    h.allowed.app = ["local", "box", "gone"];
    const note = (await h.registry.agentNote("c1"))!;
    expect(note).toContain("pass `location` the FIRST time");
    expect(note).toContain("- `local` — this machine (the Dispatch host) (the default).");
    expect(note).toContain("- `box` — Test box.\n  Your code reaches the box by magic.");
    expect(note).toContain("- `gone` — gone. UNAVAILABLE right now: its plugin is switched off or not installed.");
    expect(note).toContain("as of the start of this session");
    expect(note).toContain("keep git local");
  });

  // E29: the session's tool schema is fixed at build, so whether the agent is
  // OFFERED a choice must come from config — not from what is up at that moment.
  it("offers the choice the config gives while the only other location is offline, and tells the agent what it is for", async () => {
    const h = setup();
    h.registry.register(fakeBackend(), "plug");
    h.chats.set("c1", { projectId: "p1" });
    h.allowed.app = ["local", "box"];
    h.registry.setStatus("box", { state: "offline", detail: "asleep" });

    const choices = await h.registry.locations({ chatId: "c1" });
    expect(choices.enabled).toBe(false);
    expect(choices.offered).toBe(true);
    expect(choices.allowed).toEqual([
      { id: "local", label: "this machine (the Dispatch host)", isDefault: true },
      { id: "box", label: "Test box", isDefault: false },
    ]);

    const note = (await h.registry.agentNote("c1"))!;
    expect(note).toContain("pass `location` the FIRST time");
    expect(note).toContain(
      "- `box` — Test box. UNAVAILABLE right now: Test box is offline (asleep).\n  Your code reaches the box by magic.",
    );
    expect(note).toContain("Each call is checked when you make it");

    // Each pick is judged on the registry as it is NOW.
    expect(await h.registry.checkLocation({ chatId: "c1" }, "box")).toMatchObject({ ok: false });
    h.registry.setStatus("box", { state: "online" });
    expect(await h.registry.checkLocation({ chatId: "c1" }, "box")).toEqual({ ok: true, label: "Test box" });
  });

  it("offers a location whose plugin is off, under its remembered label — even with no backend registered at all", async () => {
    const h = setup();
    h.registry.register(fakeBackend({ fallback: "refuse" }), "plug");
    await h.registry.unregister("box");
    h.chats.set("c1", { projectId: "p1" });
    h.allowed.app = ["local", "box"];

    const choices = await h.registry.locations({ chatId: "c1" });
    expect(choices.offered).toBe(true);
    expect(choices.allowed.map((o) => [o.id, o.label])).toEqual([
      ["local", "this machine (the Dispatch host)"],
      ["box", "Test box"],
    ]);
    // The note used to short-circuit on an empty registry, leaving the tool's
    // `location` param unexplained.
    const note = (await h.registry.agentNote("c1"))!;
    expect(note).toContain("- `box` — Test box. UNAVAILABLE right now: its plugin is switched off or not installed.");
    expect(note).toContain("When Test box cannot start a shell, the command FAILS");
  });

  it("a pinned default whose plugin is off is refused as unavailable — what the prompt says — not as not allowed", async () => {
    const h = setup();
    h.registry.register(fakeBackend(), "plug");
    await h.registry.unregister("box");
    h.chats.set("c1", { projectId: "p1", terminalBackend: "box" });
    h.allowed.app = ["local"];

    const choices = await h.registry.locations({ chatId: "c1" });
    expect(choices.offered).toBe(true);
    expect(choices.unavailable).toEqual(["box"]);
    expect(choices.reasons).toEqual({ box: "its plugin is switched off or not installed" });

    const note = (await h.registry.agentNote("c1"))!;
    expect(note).toContain(
      "- `box` — Test box (the default). UNAVAILABLE right now: its plugin is switched off or not installed.",
    );
    const refused = await h.registry.checkLocation({ chatId: "c1" }, "box");
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { error: string }).error).toMatch(
      /^"box" is allowed but not available right now — its plugin is switched off or not installed\. Allowed: `local`\./,
    );
  });

  it("keeps two backends' forwards of the same port in one chat apart", () => {
    const h = setup();
    h.registry.register(fakeBackend(), "plug");
    h.registry.register(fakeBackend({ id: "b", label: "B" }), "plug");
    h.registry.publishPort("box", { chatId: "c1", remotePort: 3000, url: "http://127.0.0.1:1" });
    h.registry.publishPort("b", { chatId: "c1", remotePort: 3000, url: "http://127.0.0.1:2" });
    expect(h.registry.ports("c1").map((p) => `${p.backend}:${p.url}`).sort()).toEqual([
      "b:http://127.0.0.1:2",
      "box:http://127.0.0.1:1",
    ]);
  });
});

describe("per-run hooks (beforeRun / afterRun)", () => {
  /** A backend with hooks, its shell answering every probe. */
  function hooked(over: Partial<TerminalBackend> = {}) {
    const before: TerminalRunInfo[] = [];
    const after: TerminalAfterRunInfo[] = [];
    const backend = fakeBackend({
      beforeRun: (info) => {
        before.push(info);
        return { notices: [`synced for: ${info.command}`] };
      },
      afterRun: (info) => {
        after.push(info);
        return { notices: [`brought back after: ${info.command}`] };
      },
      ...over,
    });
    return { backend, before, after };
  }
  const commandsWritten = (s: FakeShell) => s.writes.filter((w) => !w.includes("CMTERMSENTINEL_"));

  it("a backend with no hooks gets the command, then the probe, as two writes, and the result gains nothing", async () => {
    const h = setup();
    const backend = fakeBackend();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say hi", cwd: "/w" });
    // The published proxmox-terminal plugin syncs before any write that does
    // not start `__cm_ec=`: the probe must stay a write of its own, with that
    // prefix, after a command write that never has it.
    expect(backend.spawned[0]!.writes).toEqual([
      "eval 'say hi\n' </dev/null\n",
      expect.stringMatching(/^__cm_ec=\$\?; printf .*CMTERMSENTINEL_/),
    ]);
    expect(res).not.toHaveProperty("notices");
    expect(res).not.toHaveProperty("refused");
    expect(res.output).toBe("hi");
  });

  it("awaits beforeRun before writing the command, then runs it and reports both hooks' notices in order", async () => {
    const h = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { backend, before, after } = hooked({
      beforeRun: async (info) => {
        before.push(info);
        await gate;
        return { notices: ["Synced 2 local changes."] };
      },
    });
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box", projectId: "p1" });

    const running = h.svc.run({ chatId: "c1", projectId: "p1", name: "build", command: "say built", cwd: "/w" });
    await vi.waitFor(() => expect(before).toHaveLength(1));
    // Held at the hook: nothing reached the shell, and the shell reads busy.
    expect(backend.spawned[0]!.writes).toEqual([]);
    expect(h.svc.listChat("c1")[0]!.busy).toBe(true);
    expect(before[0]).toMatchObject({
      chatId: "c1",
      projectId: "p1",
      terminal: "build",
      command: "say built",
      cwd: "/srv/repo",
      background: false,
    });
    expect(before[0]!.signal.aborted).toBe(false);

    release();
    const res = await running;
    expect(res.output).toBe("built");
    expect(res.exitCode).toBe(0);
    expect(res.notices).toEqual(["Synced 2 local changes.", "brought back after: say built"]);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ terminal: "build", command: "say built", exitCode: 0, outcome: "finished" });
    expect(after[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(h.svc.listChat("c1")[0]!.busy).toBe(false);
    // The human reading the panel sees the same lines, attributed.
    const lines = (await h.svc.scrollback(h.svc.listChat("c1")[0]!.id)).map((l) => l.chunk);
    expect(lines).toContain("[Test box] Synced 2 local changes.");
    expect(lines).toContain("[Test box] brought back after: say built");
  });

  it("a refusal never writes the command: an error result, marked refused, said in the transcript", async () => {
    const h = setup();
    const { backend, after } = hooked({
      beforeRun: () => ({ refuse: "a.txt was edited here and on the box.", notices: ["Conflicting: a.txt"] }),
    });
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });

    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say nope", cwd: "/w" });
    expect(res).toMatchObject({
      output: "",
      exitCode: null,
      refused: true,
      error: "a.txt was edited here and on the box.",
      notices: ["Conflicting: a.txt"],
    });
    expect(commandsWritten(backend.spawned[0]!)).toEqual([]);
    expect(after).toHaveLength(0);
    const term = h.svc.listChat("c1")[0]!;
    expect(term.busy).toBe(false);
    expect(term.lastExitCode).toBeNull();
    const lines = (await h.svc.scrollback(term.id)).map((l) => l.chunk);
    expect(lines).toContain("[dispatch] Not run: a.txt was edited here and on the box.");
  });

  it("a beforeRun that throws refuses too, naming the backend", async () => {
    const h = setup();
    const { backend } = hooked({
      beforeRun: () => {
        throw new Error("ssh: connection refused");
      },
    });
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say x", cwd: "/w" });
    expect(res.refused).toBe(true);
    expect(res.error).toBe("Test box could not prepare this command, so it was not run: ssh: connection refused");
    expect(commandsWritten(backend.spawned[0]!)).toEqual([]);
    // The shell is not wedged by it.
    backend.beforeRun = undefined;
    expect((await h.svc.run({ chatId: "c1", name: "main", command: "say again" })).output).toBe("again");
  });

  it("time in beforeRun is not charged to the command's timeout", async () => {
    const h = setup();
    const { backend } = hooked({
      beforeRun: () => new Promise((r) => setTimeout(() => r({}), 250)),
    });
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    const started = Date.now();
    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say slow-sync", cwd: "/w", timeoutMs: 100 });
    // The sync really did take longer than the command's whole deadline…
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
    // …and the command still got all of its own.
    expect(res.timedOut).toBeUndefined();
    expect(res.error).toBeUndefined();
    expect(res.output).toBe("slow-sync");
  });

  it("a beforeRun that overruns runHookTimeoutMs refuses the command and aborts its signal", async () => {
    const h = setup();
    let seen: AbortSignal | undefined;
    const { backend } = hooked({
      runHookTimeoutMs: 1_000,
      beforeRun: ({ signal }) => {
        seen = signal as AbortSignal;
        return new Promise(() => {});
      },
    });
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say x", cwd: "/w" });
    expect(res.refused).toBe(true);
    expect(res.error).toMatch(/did not finish preparing this command within 1s/);
    expect(seen?.aborted).toBe(true);
    expect(commandsWritten(backend.spawned[0]!)).toEqual([]);
  });

  it("a session interrupt during beforeRun cancels without writing, and aborts the hook", async () => {
    const h = setup();
    let seen: AbortSignal | undefined;
    const { backend, after } = hooked({
      beforeRun: ({ signal }) => {
        seen = signal as AbortSignal;
        return new Promise(() => {});
      },
    });
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    const ctl = new AbortController();
    const running = h.svc.run({ chatId: "c1", name: "main", command: "say x", cwd: "/w", signal: ctl.signal });
    await vi.waitFor(() => expect(seen).toBeDefined());
    ctl.abort();
    const res = await running;
    expect(res.error).toBe("Cancelled (session interrupted).");
    expect(res.refused).toBeUndefined();
    expect(seen!.aborted).toBe(true);
    expect(commandsWritten(backend.spawned[0]!)).toEqual([]);
    expect(after).toHaveLength(0);
    expect(h.svc.listChat("c1")[0]!.busy).toBe(false);
  });

  it("closing the terminal during beforeRun answers at once and writes nothing", async () => {
    const h = setup();
    let seen: AbortSignal | undefined;
    const { backend } = hooked({
      beforeRun: ({ signal }) => {
        seen = signal as AbortSignal;
        return new Promise(() => {});
      },
    });
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    const running = h.svc.run({ chatId: "c1", name: "main", command: "say x", cwd: "/w" });
    await vi.waitFor(() => expect(seen).toBeDefined());
    h.svc.kill(h.svc.listChat("c1")[0]!.id);
    const res = await running;
    expect(res.error).toBe("Terminal has exited.");
    expect(seen!.aborted).toBe(true);
    expect(commandsWritten(backend.spawned[0]!)).toEqual([]);
  });

  it("afterRun failing is a notice, not a failed run — the command already ran", async () => {
    const h = setup();
    const { backend } = hooked({
      afterRun: () => {
        throw new Error("pull-back failed");
      },
    });
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say ran", cwd: "/w" });
    expect(res.error).toBeUndefined();
    expect(res.output).toBe("ran");
    expect(res.notices).toEqual(["synced for: say ran", "Test box failed after the command ran: pull-back failed"]);
  });

  it("the shell stays busy until afterRun settles", async () => {
    const h = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const after: TerminalAfterRunInfo[] = [];
    const { backend } = hooked({
      beforeRun: undefined,
      afterRun: async (info) => {
        after.push(info);
        await gate;
      },
    });
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    const running = h.svc.run({ chatId: "c1", name: "main", command: "say x", cwd: "/w" });
    await vi.waitFor(() => expect(after).toHaveLength(1));
    expect(h.svc.listChat("c1")[0]!.busy).toBe(true);
    release();
    const res = await running;
    expect(res.output).toBe("x");
    expect(res).not.toHaveProperty("notices");
    expect(h.svc.listChat("c1")[0]!.busy).toBe(false);
  });

  it("a timed-out command still gets afterRun, told it may still be running", async () => {
    const h = setup();
    const { backend, after } = hooked();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    const res = await h.svc.run({ chatId: "c1", name: "main", command: "hang", cwd: "/w", timeoutMs: 50 });
    expect(res.timedOut).toBe(true);
    expect(after[0]).toMatchObject({ outcome: "timed-out", exitCode: null });
    expect(res.notices).toEqual(["synced for: hang", "brought back after: hang"]);
  });

  it("a background command: beforeRun gates the start, afterRun reports to the transcript when it ends", async () => {
    const h = setup();
    const { backend, before, after } = hooked();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });

    const res = await h.svc.run({ chatId: "c1", name: "dev", command: "hang", cwd: "/w", background: true });
    expect(res.backgrounded).toBe(true);
    expect(res.notices).toEqual(["synced for: hang"]);
    expect(before[0]!.background).toBe(true);
    expect(after).toHaveLength(0);

    // The dev server exits: its marker finally lands.
    const shell = backend.spawned[0]!;
    const marker = shell.writes.join("").match(/CMTERMSENTINEL_[A-Za-z0-9_-]+/)![0];
    shell.stdout.emit("data", Buffer.from(`${marker}|3|False|/srv/repo\n`));
    await vi.waitFor(() => expect(after).toHaveLength(1));
    expect(after[0]).toMatchObject({ background: true, outcome: "finished", exitCode: 3 });
    await vi.waitFor(async () => {
      const lines = (await h.svc.scrollback(h.svc.listChat("c1")[0]!.id)).map((l) => l.chunk);
      expect(lines).toContain("[Test box] brought back after: hang");
    });
  });

  // A plugin holds a lock and attributes host-side edits per run, from
  // `beforeRun` to `afterRun`. A background run's `afterRun` lands after
  // other runs in the same chat have come and gone, so only an id pairs them.
  it("gives each run one runId, shared by its beforeRun and its afterRun", async () => {
    const h = setup();
    const { backend, before, after } = hooked();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });

    await h.svc.run({ chatId: "c1", name: "dev", command: "hang", cwd: "/w", background: true });
    await h.svc.run({ chatId: "c1", name: "build", command: "say one", cwd: "/w" });
    await h.svc.run({ chatId: "c1", name: "build", command: "say two", cwd: "/w" });
    const dev = backend.spawned[0]!;
    const marker = dev.writes.join("").match(/CMTERMSENTINEL_[A-Za-z0-9_-]+/)![0];
    dev.stdout.emit("data", Buffer.from(`${marker}|0|True|/srv/repo\n`));
    await vi.waitFor(() => expect(after).toHaveLength(3));

    const ids = before.map((b) => b.runId);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(3);
    expect(after.map((a) => a.command)).toEqual(["say one", "say two", "hang"]);
    for (const a of after) expect(a.runId).toBe(before.find((b) => b.command === a.command)!.runId);
  });

  it("is never called for a shell that fell back to local", async () => {
    const h = setup();
    const { backend, before, after } = hooked({ spawn: async () => Promise.reject(new Error("offline")) });
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say local", cwd: "/w" });
    expect(res.output).toBe("local");
    expect(res).not.toHaveProperty("notices");
    expect(before).toHaveLength(0);
    expect(after).toHaveLength(0);
  });

  it("spawn is told the chat's worktree and the branch checked out there", async () => {
    const h = setup();
    const backend = fakeBackend();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box", projectId: "p1", worktreePath: "/wt/feat-x" });
    h.chats.set("c2", { terminalBackend: "box", projectId: "p1" });
    await h.svc.run({ chatId: "c1", name: "main", command: "say a", cwd: "/wt/feat-x" });
    await h.svc.run({ chatId: "c2", name: "main", command: "say b", cwd: "/repo" });
    expect(backend.infos[0]).toMatchObject({ worktreePath: "/wt/feat-x", branch: "feat/x", repoPath: "/repo" });
    // No worktree: the branch is the primary checkout's.
    expect(backend.infos[1]).toMatchObject({ branch: "main", repoPath: "/repo" });
    expect(backend.infos[1]).not.toHaveProperty("worktreePath");
    // A local shell never pays for the git call.
    h.chats.set("c3", {});
    await h.svc.run({ chatId: "c3", name: "main", command: "say c", cwd: "/w" });
    expect(h.branchAsked).toEqual(["/wt/feat-x", "/repo"]);
  });
});

describe("why a shell ended (exit reasons) and respawn notices", () => {
  const lostReason = { kind: "transport-lost" as const, detail: "ssh: connection reset" };
  const transcript = async (h: Harness, chatId = "c1") =>
    (await h.svc.scrollback(h.svc.listChat(chatId)[0]!.id)).map((l) => l.chunk);

  it("a lost transport mid-command is an ERROR whose outcome is unknown, said in the result and the panel", async () => {
    const h = setup();
    const backend = fakeBackend();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    await h.svc.run({ chatId: "c1", name: "build", command: "say up", cwd: "/w" });

    const running = h.svc.run({ chatId: "c1", name: "build", command: "hang" });
    await vi.waitFor(() => expect(backend.spawned[0]!.ran.includes("hang")).toBe(true));
    backend.spawned[0]!.stdout.emit("data", Buffer.from("migrating 3 of 7\n"));
    backend.spawned[0]!.emit("exit", null, lostReason);
    const res = await running;

    expect(res.exitCode).toBeNull();
    expect(res.output).toBe("migrating 3 of 7");
    expect(res.shellExit).toEqual(lostReason);
    expect(res.error).toMatch(/lost its connection to Test box \(ssh: connection reset\) while the command was running/);
    expect(res.error).toMatch(/is unknown/);
    const info = h.svc.listChat("c1")[0]!;
    expect(info.status).toBe("exited");
    expect(info.exitReason).toEqual(lostReason);
    expect(await transcript(h)).toContain(
      "[dispatch] This shell lost its connection to Test box (ssh: connection reset). The next command starts a new one.",
    );
  });

  it("the next command on that name gets a NEW shell, and is told its cwd/env started over — once", async () => {
    const h = setup();
    const backend = fakeBackend();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    await h.svc.run({ chatId: "c1", name: "build", command: "say up", cwd: "/w" });
    backend.spawned[0]!.emit("exit", null, lostReason);

    const next = await h.svc.run({ chatId: "c1", name: "build", command: "say again", cwd: "/w" });
    expect(next.output).toBe("again");
    expect(backend.spawned).toHaveLength(2);
    expect(next.notice).toContain(
      "Terminal 'build' is a NEW shell: the one before it under this name lost its connection to Test box (ssh: connection reset).",
    );
    expect(next.notice).toMatch(/starts in its default directory with a fresh environment/);
    // The backend's own note is still there too.
    expect(next.notice).toContain("Your code reaches the box by magic.");
    expect((await h.svc.run({ chatId: "c1", name: "build", command: "say third" })).notice).toBeUndefined();
  });

  it("a killed shell's in-flight command did not finish, and says so", async () => {
    const h = setup();
    const backend = fakeBackend();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    const running = h.svc.run({ chatId: "c1", name: "main", command: "hang" });
    await vi.waitFor(() => expect(backend.spawned[0]!.ran.includes("hang")).toBe(true));
    backend.spawned[0]!.emit("exit", null, { kind: "killed", detail: "idle stop" });
    const res = await running;
    expect(res.error).toMatch(/was stopped on Test box \(idle stop\) while the command was running, so the command did not finish/);
    expect(res.shellExit).toEqual({ kind: "killed", detail: "idle stop" });
  });

  it("an `exited` reason — or a ChildProcess's signal string — reads exactly like no reason: not an error", async () => {
    const h = setup();
    const backend = fakeBackend();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    const running = h.svc.run({ chatId: "c1", name: "main", command: "hang" });
    await vi.waitFor(() => expect(backend.spawned[0]!.ran.includes("hang")).toBe(true));
    backend.spawned[0]!.emit("exit", 0, { kind: "exited" });
    const res = await running;
    expect(res.error).toBeUndefined();
    expect(res.shellExit).toEqual({ kind: "exited" });

    // A local shell: Node hands the exit listener the SIGNAL NAME second.
    h.chats.set("c2", {});
    await h.svc.run({ chatId: "c2", name: "main", command: "say up", cwd: "/w" });
    const local = h.svc.run({ chatId: "c2", name: "main", command: "hang" });
    await vi.waitFor(() => expect(h.local[0]!.ran.includes("hang")).toBe(true));
    h.local[0]!.emit("exit", null, "SIGTERM");
    const l = await local;
    expect(l.error).toBeUndefined();
    expect(l).not.toHaveProperty("shellExit");
    expect(h.svc.listChat("c2")[0]).not.toHaveProperty("exitReason");
  });

  it("a local shell that died between calls is reopened with the same notice", async () => {
    const h = setup();
    h.chats.set("c1", {});
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    h.local[0]!.emit("exit", 1);
    const next = await h.svc.run({ chatId: "c1", name: "main", command: "say back", cwd: "/w" });
    expect(next.output).toBe("back");
    expect(next.notice).toBe(
      "Terminal 'main' is a NEW shell: the one before it under this name exited. Nothing carried over — it " +
        "starts in its default directory with a fresh environment, so `cd` and set any variables again.",
    );
  });

  it("a brand-new name gets no respawn notice", async () => {
    const h = setup();
    h.chats.set("c1", {});
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    h.local[0]!.emit("exit", 1);
    const fresh = await h.svc.run({ chatId: "c1", name: "other", command: "say hi", cwd: "/w" });
    expect(fresh.notice).toBeUndefined();
  });

  it("afterRun hears the reason a shell ended under the command", async () => {
    const h = setup();
    const seen: TerminalAfterRunInfo[] = [];
    const backend = fakeBackend({ afterRun: (info) => void seen.push(info) });
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    const running = h.svc.run({ chatId: "c1", name: "main", command: "hang" });
    await vi.waitFor(() => expect(backend.spawned[0]!.ran.includes("hang")).toBe(true));
    backend.spawned[0]!.emit("exit", null, lostReason);
    await running;
    expect(seen.at(-1)).toMatchObject({ outcome: "shell-exited", exitReason: lostReason });
  });

  it("a backend going away mid-command loses the transport: an error, not a quiet exit=n/a", async () => {
    const h = setup();
    const backend = fakeBackend();
    h.registry.register(backend, "plug");
    h.registry.register(fakeBackend({ id: "keep", label: "Keep" }), "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    const running = h.svc.run({ chatId: "c1", name: "main", command: "hang" });
    await vi.waitFor(() => expect(backend.spawned[0]!.ran.includes("hang")).toBe(true));
    await h.registry.unregister("box");
    const res = await running;
    expect(res.shellExit?.kind).toBe("transport-lost");
    expect(res.error).toMatch(/backend "box" went away/);
  });
});

describe("stalled / resumed transports", () => {
  it("a stall pauses the command's timeout: a run that outlives its deadline only by the stall still finishes", async () => {
    const h = setup();
    const backend = fakeBackend();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    const shell = backend.spawned[0]!;

    const running = h.svc.run({ chatId: "c1", name: "main", command: "hang", timeoutMs: 300 });
    await vi.waitFor(() => expect(shell.ran.includes("hang")).toBe(true));
    shell.emit("stalled", { detail: "no keepalive answer for 15 s" });
    let info = h.svc.listChat("c1")[0]!;
    expect(info.location).toMatchObject({ state: "stalled", stalled: "no keepalive answer for 15 s" });
    expect(typeof info.location?.stalledSince).toBe("number");

    // Well past the 300 ms deadline, but all of it stalled.
    await new Promise((r) => setTimeout(r, 500));
    shell.emit("resumed");
    info = h.svc.listChat("c1")[0]!;
    expect(info.location?.state).toBe("ready");
    expect(info.location).not.toHaveProperty("stalled");

    const marker = shell.writes.join("").match(/CMTERMSENTINEL_[A-Za-z0-9_-]+/g)!.at(-1)!;
    shell.stdout.emit("data", Buffer.from(`done\n${marker}|0|True|/srv/repo\n`));
    const res = await running;
    expect(res.timedOut).toBeUndefined();
    expect(res.exitCode).toBe(0);
    expect(res.output).toBe("done");
    expect(res.notices?.[0]).toMatch(/^The connection to Test box stalled for \d+s during this command; its timeout was paused meanwhile\.$/);
    const lines = (await h.svc.scrollback(info.id)).map((l) => l.chunk);
    expect(lines.some((l) => l.startsWith("[dispatch] Test box stopped answering (no keepalive answer for 15 s)"))).toBe(true);
    expect(lines.some((l) => l.startsWith("[dispatch] Test box is answering again"))).toBe(true);
  });

  it("the deadline is paused, not cancelled: what is left of it still runs out after the resume", async () => {
    const h = setup();
    const backend = fakeBackend();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    const shell = backend.spawned[0]!;
    const started = Date.now();
    const running = h.svc.run({ chatId: "c1", name: "main", command: "hang", timeoutMs: 200 });
    await vi.waitFor(() => expect(shell.ran.includes("hang")).toBe(true));
    shell.emit("stalled");
    await new Promise((r) => setTimeout(r, 300));
    shell.emit("resumed");
    const res = await running;
    expect(res.timedOut).toBe(true);
    // 200 ms of deadline + ~300 ms stalled.
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  });

  it("a command started while stalled waits for the resume before its clock starts", async () => {
    const h = setup();
    const backend = fakeBackend();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    const shell = backend.spawned[0]!;
    shell.emit("stalled");
    const running = h.svc.run({ chatId: "c1", name: "main", command: "hang", timeoutMs: 100 });
    await new Promise((r) => setTimeout(r, 250));
    const marker = shell.writes.join("").match(/CMTERMSENTINEL_[A-Za-z0-9_-]+/g)!.at(-1)!;
    shell.emit("resumed");
    shell.stdout.emit("data", Buffer.from(`${marker}|0|True|/srv/repo\n`));
    const res = await running;
    expect(res.timedOut).toBeUndefined();
    expect(res.exitCode).toBe(0);
  });

  it("an exit while stalled clears the stalled state", async () => {
    const h = setup();
    const backend = fakeBackend();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    backend.spawned[0]!.emit("stalled");
    expect(h.svc.listChat("c1")[0]!.location?.state).toBe("stalled");
    backend.spawned[0]!.emit("exit", null, { kind: "transport-lost" });
    const info = h.svc.listChat("c1")[0]!;
    expect(info.status).toBe("exited");
    expect(info.location?.state).toBe("ready");
  });
});

describe("review fixes on #476", () => {
  it("a backend handle that ERRORS before its exit still reads as a lost transport", async () => {
    const h = setup();
    const backend = fakeBackend();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    const running = h.svc.run({ chatId: "c1", name: "main", command: "hang" });
    await vi.waitFor(() => expect(backend.spawned[0]!.ran.includes("hang")).toBe(true));
    backend.spawned[0]!.emit("error", new Error("read ECONNRESET"));
    backend.spawned[0]!.emit("exit", null, { kind: "transport-lost", detail: "ssh: closed" });
    const res = await running;
    expect(res.shellExit).toEqual({ kind: "transport-lost", detail: "read ECONNRESET" });
    expect(res.error).toMatch(/lost its connection to Test box \(read ECONNRESET\).*is unknown/);
  });

  it("a stdin EPIPE on a backend shell is a lost transport too; on a local shell it is not", async () => {
    const h = setup();
    const backend = fakeBackend({
      spawn: async () => {
        const s = new FakeShell("/srv/repo");
        Object.assign(s.stdin, { on: (_e: string, l: (err: Error) => void) => s.on("stdin-error", l) });
        backend.spawned.push(s);
        return s;
      },
    });
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    backend.spawned[0]!.emit("stdin-error", new Error("write EPIPE"));
    expect(h.svc.listChat("c1")[0]!.exitReason).toEqual({ kind: "transport-lost", detail: "write EPIPE" });

    h.chats.set("c2", {});
    await h.svc.run({ chatId: "c2", name: "main", command: "say up", cwd: "/w" });
    h.local[0]!.emit("error", new Error("spawn EPERM"));
    expect(h.svc.listChat("c2")[0]!.status).toBe("exited");
    expect(h.svc.listChat("c2")[0]).not.toHaveProperty("exitReason");
  });

  it("a reason that arrives after a reasonless exit still reaches the respawn notice", async () => {
    const h = setup();
    const backend = fakeBackend();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    backend.spawned[0]!.emit("exit", null);
    backend.spawned[0]!.emit("exit", null, { kind: "killed", detail: "idle stop" });
    expect(h.svc.listChat("c1")[0]!.exitReason).toEqual({ kind: "killed", detail: "idle stop" });
    const next = await h.svc.run({ chatId: "c1", name: "main", command: "say back", cwd: "/w" });
    expect(next.notice).toContain("the one before it under this name was stopped on Test box (idle stop)");
  });

  it("a stall that never ends cannot hang the call: past the pause budget the deadline runs again", async () => {
    const h = setup({ stallPauseMaxMs: 200 });
    const backend = fakeBackend();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    await h.svc.run({ chatId: "c1", name: "main", command: "say up", cwd: "/w" });
    const shell = backend.spawned[0]!;
    const started = Date.now();
    const running = h.svc.run({ chatId: "c1", name: "main", command: "hang", timeoutMs: 100 });
    await vi.waitFor(() => expect(shell.ran.includes("hang")).toBe(true));
    // Stalled, and the backend never says another word.
    shell.emit("stalled");
    const res = await running;
    expect(res.timedOut).toBe(true);
    // ~200 ms of paused budget + the 100 ms deadline (less whatever ran before the stall).
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(res.notices?.at(-1)).toMatch(/up to the limit, after which the clock ran again\.$/);
  });
});

describe("backend status and in-place updates (E1/E21)", () => {
  const mac = (over: Partial<TerminalBackend> = {}) =>
    fakeBackend({ id: "mac", label: "cvx-mac", fallback: "refuse", ...over });

  it("an offline backend fails a new shell AT ONCE under refuse — spawn is never called", async () => {
    const h = setup();
    const backend = mac();
    h.registry.register(backend, "remote-host");
    h.chats.set("c1", { terminalBackend: "mac" });
    h.registry.setStatus("mac", { state: "offline", detail: "asleep", lastSeenAt: Date.now() - 4 * 60_000 });

    const started = Date.now();
    const res = await h.svc.run({ chatId: "c1", name: "build", command: "say x", cwd: "/w" });
    // Not the 120 s spawn timeout: nothing was asked of the backend at all.
    expect(Date.now() - started).toBeLessThan(500);
    expect(backend.infos).toHaveLength(0);
    expect(h.local).toHaveLength(0);
    expect(res.error).toMatch(/did not start on cvx-mac \(`mac`\): cvx-mac is offline \(asleep\), last seen 4m ago/);
    expect(h.svc.listChat("c1")[0]!.location).toMatchObject({ state: "failed", label: "cvx-mac" });
  });

  it("an offline backend under the default policy falls back locally at once, saying why", async () => {
    const h = setup();
    const backend = fakeBackend();
    h.registry.register(backend, "plug");
    h.chats.set("c1", { terminalBackend: "box" });
    h.registry.setStatus("box", { state: "offline" });
    const res = await h.svc.run({ chatId: "c1", name: "main", command: "say here", cwd: "/w" });
    expect(backend.infos).toHaveLength(0);
    expect(res.output).toBe("here");
    expect(res.notice).toMatch(/Test box is offline\. This shell is running LOCALLY/);
  });

  it("going offline cuts short a spawn that is already waiting, and kills a handle that lands late", async () => {
    const h = setup();
    let land!: (s: FakeShell) => void;
    const late = new FakeShell("/Users/dispatch/w");
    const backend = mac({ spawn: (info) => (backend.infos.push(info), new Promise<FakeShell>((r) => (land = r))) });
    h.registry.register(backend, "remote-host");
    h.chats.set("c1", { terminalBackend: "mac" });

    const running = h.svc.run({ chatId: "c1", name: "build", command: "say x", cwd: "/w" });
    await flush();
    await flush();
    expect(h.svc.listChat("c1")[0]!.location?.state).toBe("connecting");
    const started = Date.now();
    h.registry.setStatus("mac", { state: "offline", detail: "lid closed" });
    const res = await running;
    expect(Date.now() - started).toBeLessThan(500);
    expect(res.error).toMatch(/cvx-mac could not start a shell: it went offline \(lid closed\) while the shell was starting/);
    expect(backend.infos[0]!.signal.aborted).toBe(true);
    expect(h.local).toHaveLength(0);
    land(late);
    await flush();
    expect(late.killed).toBe(true);
  });

  it("re-checks after resolve's awaits: an offline flip or a rename while git answers is not missed", async () => {
    // TerminalService cuts only a spawn it has marked `connecting`, which it
    // does once `resolve` returns. Checked only BEFORE the branch lookup, an
    // offline flip during it found nothing to cut, and the stale online answer
    // waited out the whole spawn timeout (review on #482).
    let release!: () => void;
    let entered!: () => void;
    const inBranch = new Promise<void>((r) => (entered = r));
    const h = setup({
      gateBranch: () => {
        entered();
        return new Promise<void>((r) => (release = r));
      },
    });
    const backend = mac({ spawnTimeoutMs: 30_000, spawn: () => new Promise(() => {}) });
    h.registry.register(backend, "remote-host");
    // A worktree, so `resolve` has a root to ask git about.
    h.chats.set("c1", { terminalBackend: "mac", worktreePath: "/wt/feat-x" });

    const running = h.svc.run({ chatId: "c1", name: "build", command: "say x", cwd: "/w" });
    await inBranch;
    h.registry.update("mac", { label: "Garage Mac" });
    h.registry.setStatus("mac", { state: "offline", detail: "asleep" });
    const started = Date.now();
    release();
    const res = await running;
    expect(Date.now() - started).toBeLessThan(500);
    expect(backend.infos).toHaveLength(0);
    expect(res.error).toMatch(/did not start on Garage Mac \(`mac`\): Garage Mac is offline \(asleep\)/);
  });

  it("does not touch a shell already running there when the backend reports offline", async () => {
    const h = setup();
    const backend = mac();
    h.registry.register(backend, "remote-host");
    h.chats.set("c1", { terminalBackend: "mac" });
    await h.svc.run({ chatId: "c1", name: "build", command: "say up", cwd: "/w" });
    h.registry.setStatus("mac", { state: "offline" });
    const info = h.svc.listChat("c1")[0]!;
    expect(info.status).toBe("live");
    expect(backend.spawned[0]!.killed).toBe(false);
    // Its own transport is what says whether it still works.
    expect((await h.svc.run({ chatId: "c1", name: "build", command: "say still" })).output).toBe("still");
  });

  it("back online, the next shell spawns there again", async () => {
    const h = setup();
    const backend = mac();
    h.registry.register(backend, "remote-host");
    h.chats.set("c1", { terminalBackend: "mac" });
    h.registry.setStatus("mac", { state: "offline" });
    expect((await h.svc.run({ chatId: "c1", name: "build", command: "say x", cwd: "/w" })).error).toMatch(/offline/);
    h.registry.setStatus("mac", { state: "online" });
    const res = await h.svc.run({ chatId: "c1", name: "build", command: "say back", cwd: "/w" });
    expect(res.output).toBe("back");
    expect(backend.spawned).toHaveLength(1);
  });

  it("locations: offline is unavailable with its reason — the default too; degraded stays offered and says so", async () => {
    const h = setup();
    h.registry.register(mac(), "remote-host");
    h.registry.register(fakeBackend(), "plug");
    h.chats.set("c1", { terminalBackend: "mac" });
    h.allowed.app = ["local", "box", "mac", "gone"];
    h.registry.setStatus("mac", { state: "offline", detail: "asleep" });
    h.registry.setStatus("box", { state: "degraded", detail: "disk 95% full" });

    const choices = await h.registry.locations({ chatId: "c1" });
    expect(choices.defaultId).toBe("mac");
    expect(choices.options.map((o) => o.id)).toEqual(["local", "box"]);
    expect(choices.options.find((o) => o.id === "box")?.degraded).toBe("disk 95% full");
    expect(choices.unavailable).toEqual(["mac", "gone"]);
    expect(choices.reasons).toEqual({
      mac: "cvx-mac is offline (asleep)",
      gone: "its plugin is switched off or not installed",
    });

    const refused = await h.registry.checkLocation({ chatId: "c1" }, "mac");
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { error: string }).error).toMatch(/"mac" is allowed but not available right now — cvx-mac is offline \(asleep\)/);

    const note = (await h.registry.agentNote("c1"))!;
    expect(note).toContain("- `box` — Test box. Degraded right now: disk 95% full.");
    expect(note).toContain("- `mac` — cvx-mac (the default). UNAVAILABLE right now: cvx-mac is offline (asleep).");
  });

  it("setStatus validates, moves `since` only on a state change, and broadcasts only real changes", () => {
    let now = 1_000;
    const registry = new TerminalBackendRegistry({
      bus,
      chat: async () => null,
      projectDefault: () => undefined,
      now: () => now,
    });
    registry.register(mac(), "remote-host");
    expect(() => registry.setStatus("nope", { state: "online" })).toThrow(/not registered/);
    expect(() => registry.setStatus("mac", { state: "asleep" as never })).toThrow(/state must be/);
    expect(() => registry.setStatus("mac", { state: "online", lastSeenAt: Number.NaN })).toThrow(/lastSeenAt/);

    const broadcasts = () => events.filter((e) => e.type === "terminal-backends").length;
    const before = broadcasts();
    registry.setStatus("mac", { state: "offline", detail: "  asleep\n since   noon " });
    expect(registry.list()[0]!.status).toEqual({ state: "offline", detail: "asleep since noon", since: 1_000 });
    now = 5_000;
    registry.setStatus("mac", { state: "offline", detail: "asleep since noon", lastSeenAt: 4_000 });
    expect(registry.list()[0]!.status).toEqual({ state: "offline", detail: "asleep since noon", lastSeenAt: 4_000, since: 1_000 });
    // Only the first of those two changed what a client shows.
    expect(broadcasts() - before).toBe(1);
    registry.setStatus("mac", { state: "online" });
    expect(registry.list()[0]!.status).toEqual({ state: "online", since: 5_000 });
    expect(broadcasts() - before).toBe(2);
  });

  it("updateBackend relabels live shells without ending them, replaces the note, and never writes the plugin's object", async () => {
    const memory = mapMemory();
    const h = setup({ memory });
    const backend = mac({ agentNote: () => "Old note." });
    h.registry.register(backend, "remote-host");
    h.chats.set("c1", { terminalBackend: "mac" });
    await h.svc.run({ chatId: "c1", name: "build", command: "say up", cwd: "/w" });

    h.registry.update("mac", { label: "Garage Mac", agentNote: () => "New note." });
    expect(backend.label).toBe("cvx-mac");
    expect(h.registry.list()[0]!.label).toBe("Garage Mac");
    expect(memory.rows.get("mac")?.label).toBe("Garage Mac");
    const info = h.svc.listChat("c1")[0]!;
    expect(info.status).toBe("live");
    expect(info.location).toMatchObject({ backend: "mac", label: "Garage Mac", state: "ready" });
    expect(backend.spawned[0]!.killed).toBe(false);
    expect((await h.svc.run({ chatId: "c1", name: "build", command: "say same" })).ranOn).toEqual({
      id: "mac",
      label: "Garage Mac",
    });

    let note = (await h.registry.agentNote("c1"))!;
    expect(note).toContain("run on Garage Mac, NOT on the Dispatch host");
    expect(note).toContain("New note.");
    expect(note).not.toContain("Old note.");
    h.registry.update("mac", { agentNote: undefined });
    note = (await h.registry.agentNote("c1"))!;
    expect(note).not.toContain("New note.");

    expect(() => h.registry.update("mac", { label: "  " })).toThrow(/label must be a non-empty string/);
    expect(() => h.registry.update("mac", { agentNote: "text" as never })).toThrow(/agentNote must be a function/);
    expect(() => h.registry.update("nope", { label: "x" })).toThrow(/not registered/);
  });

  it("a class-based backend's updated note still runs with the backend as `this`", async () => {
    class Box {
      readonly id = "cls";
      readonly label = "Class box";
      readonly shell = "bash" as const;
      private readonly host = "cls.lan";
      async spawn(): Promise<FakeShell> {
        return new FakeShell("/srv");
      }
      note(): string {
        return `Reached at ${this.host}.`;
      }
    }
    const h = setup();
    const box = new Box();
    h.registry.register(box as unknown as TerminalBackend, "plug");
    h.chats.set("c1", { terminalBackend: "cls" });
    h.registry.update("cls", { agentNote: Box.prototype.note as TerminalBackend["agentNote"] });
    expect(await h.registry.agentNote("c1")).toContain("Reached at cls.lan.");
    // And the registration still spawns through its prototype method.
    expect((await h.svc.run({ chatId: "c1", name: "t", command: "say ok", cwd: "/w" })).output).toBe("ok");
  });
});
