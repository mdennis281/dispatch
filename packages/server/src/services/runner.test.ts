import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SubApp, WsServerEvent } from "@dispatch/shared";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import {
  RunnerService,
  substitutePorts,
  detectBoundPort,
  scrubManagerEnv,
  MANAGER_ENV_VARS,
  type ChildLike,
  type RunOnceFn,
  type SpawnFn,
} from "./runner.js";
import { loadConfig } from "../config.js";

let dir: string;
let store: Store;
let bus: EventBus;
let events: WsServerEvent[];
let service: RunnerService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-runner-"));
  store = new Store(dir);
  await store.init();
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
});

afterEach(async () => {
  if (service) await service.stopAll().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeout = 8000,
  interval = 20,
): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, interval));
  }
}

function logLines(runnerId: string): string[] {
  return events
    .filter((e): e is Extract<WsServerEvent, { type: "runner-log" }> => e.type === "runner-log")
    .filter((e) => e.runnerId === runnerId)
    .map((e) => e.line);
}

/* ----------------------------------------------- real process (node -e loop) */

describe("RunnerService — real process", () => {
  it(
    "registers, streams logs, and stops a long-running node process",
    async () => {
      // A trivial long-running process that prints a line (echoing the injected PORT)
      // then stays alive on an interval.
      await writeFile(
        join(dir, "loop.js"),
        "console.log('RUNNER-UP:' + process.env.PORT);\nsetInterval(() => {}, 1000);\n",
      );
      const subApp: SubApp = {
        id: "loop",
        name: "Loop",
        path: ".",
        dev: "node loop.js",
        ports: [45231],
      };

      service = new RunnerService({ store, bus });
      const runner = await service.start(dir, subApp, { projectId: "p1", chatId: "c1" });

      expect(runner.status).toBe("running");
      expect(runner.pid).toBeGreaterThan(0);
      expect(runner.port).toBeGreaterThan(0);
      expect(runner.kind).toBe("process");

      // Persisted to runners.json.
      expect(await store.getRunner(runner.id)).toMatchObject({ id: runner.id, status: "running" });
      expect(await service.list()).toHaveLength(1);

      // runner-update was emitted.
      expect(
        events.some((e) => e.type === "runner-update" && e.runner.id === runner.id),
      ).toBe(true);

      // The child's stdout line arrives as a runner-log event, carrying the PORT.
      await waitFor(() => logLines(runner.id).some((l) => l.startsWith("RUNNER-UP:")));
      const up = logLines(runner.id).find((l) => l.startsWith("RUNNER-UP:"))!;
      expect(up).toBe(`RUNNER-UP:${runner.port}`);
      // logs() ring buffer holds it too.
      expect(service.logs(runner.id).some((l) => l.line === up)).toBe(true);

      // Stop tree-kills the process and flips it to stopped.
      await service.stop(runner.id);
      await waitFor(async () => (await store.getRunner(runner.id))?.status === "stopped");
      expect((await store.getRunner(runner.id))?.status).toBe("stopped");
    },
    20000,
  );
});

/* --------------------------------------------------- mocked docker + process */

class MockChild extends EventEmitter implements ChildLike {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("RunnerService — docker path (mocked)", () => {
  it("runs docker compose up before spawn and down on stop", async () => {
    const dockerCalls: { args: string[]; cwd: string }[] = [];
    const runOnce: RunOnceFn = async (file, args, opts) => {
      dockerCalls.push({ args: [file, ...args], cwd: opts.cwd.replace(/\\/g, "/") });
      return { exitCode: 0 };
    };

    let child: MockChild | undefined;
    const spawn: SpawnFn = (command, opts) => {
      expect(command).toBe("node server.js");
      expect(opts.env.PORT).toBe("8080");
      child = new MockChild();
      return child;
    };

    const killed: number[] = [];
    service = new RunnerService({
      store,
      bus,
      spawn,
      runOnce,
      getPort: async (preferred) => preferred ?? 9999,
      killTree: async (pid) => {
        killed.push(pid);
        child?.emit("exit", 0); // killing the tree causes the child to exit
      },
    });

    const subApp: SubApp = {
      id: "metrics",
      name: "Metrics",
      path: ".",
      dev: "node server.js",
      dockerCompose: "services/metrics/docker-compose.yml",
      ports: [8080],
    };

    const runner = await service.start("C:/wt", subApp);
    expect(runner.kind).toBe("process");
    expect(runner.pid).toBe(4242);
    expect(runner.status).toBe("running");
    expect(runner.port).toBe(8080);

    // docker compose up -d ran first, in the compose file's directory.
    expect(dockerCalls[0].args).toEqual([
      "docker",
      "compose",
      "-f",
      "docker-compose.yml",
      "up",
      "-d",
    ]);
    expect(dockerCalls[0].cwd).toBe("C:/wt/services/metrics");

    // A stdout line from the child becomes a runner-log event.
    child!.stdout.write("metrics listening on 8080\n");
    await waitFor(() => logLines(runner.id).includes("metrics listening on 8080"));

    // Stop tree-kills the pid and runs docker compose down.
    await service.stop(runner.id);
    await waitFor(async () => (await store.getRunner(runner.id))?.status === "stopped");
    expect(killed).toEqual([4242]);
    expect(dockerCalls.some((c) => c.args.includes("down"))).toBe(true);
    expect((await store.getRunner(runner.id))?.status).toBe("stopped");
  });

  it("tears docker down with the same port overlay it was brought up with", async () => {
    // Review found `down` receiving only the scrubbed parent env while `up` got
    // the overlay too. A compose file interpolating `${PORT}` or `${SERVER_PORT}`
    // then describes a DIFFERENT stack at teardown than at startup, and can leave
    // the real one running. Ports come from the persisted record, so this has to
    // hold without the live map as well.
    const envs: Record<string, string | undefined>[] = [];
    const runOnce: RunOnceFn = async (_file, args, opts) => {
      if (args.includes("up") || args.includes("down")) envs.push(opts.env ?? {});
      return { exitCode: 0 };
    };

    service = new RunnerService({
      store,
      bus,
      runOnce,
      getPort: async (preferred) => preferred ?? 9999,
      killTree: async () => {},
    });

    const subApp: SubApp = {
      id: "stack",
      name: "Stack",
      path: ".",
      dockerCompose: "services/stack/docker-compose.yml",
      ports: [8080, 2567],
      // The Hivebreak shape documented in RUNNING.md: the port has to cross a
      // process boundary the runner can't pass argv to.
      env: { SERVER_PORT: "{port2}", CLIENT_PORT: "{port}" },
    };

    const runner = await service.start("C:/wt", subApp);
    await service.stop(runner.id);

    const [up, down] = envs;
    expect(up).toBeDefined();
    expect(down).toBeDefined();
    for (const key of ["PORT", "CLIENT_PORT", "SERVER_PORT"] as const) {
      expect(down![key]).toBe(up![key]);
    }
    expect(down!.PORT).toBe("8080");
    expect(down!.SERVER_PORT).toBe("2567");
    // Still scrubbed — the fix must not have handed the manager's identity back.
    expect(down!.DISPATCH_DATA_DIR).toBeUndefined();
  });

  it("marks the runner crashed when docker compose up fails", async () => {
    const runOnce: RunOnceFn = async () => ({ exitCode: 1 });
    service = new RunnerService({
      store,
      bus,
      runOnce,
      // dev is spawned only if docker succeeds; provide a spawn that would fail the test if called.
      spawn: () => {
        throw new Error("dev should not spawn when docker up fails");
      },
      getPort: async (p) => p ?? 9999,
    });
    const subApp: SubApp = {
      id: "d",
      name: "D",
      path: ".",
      dev: "node server.js",
      dockerCompose: "docker-compose.yml",
      ports: [8080],
    };
    const runner = await service.start("C:/wt", subApp);
    expect(runner.status).toBe("crashed");
    expect(runner.exitCode).toBe(1);
    expect((await store.getRunner(runner.id))?.status).toBe("crashed");
  });
});

/* --------------------------------------------- port placeholders + detection */

describe("substitutePorts", () => {
  it("replaces {port}/{portN}, leaving out-of-range placeholders", () => {
    expect(substitutePorts("vite --port {port}", [5173])).toBe("vite --port 5173");
    expect(substitutePorts("{port} {port1} {port2}", [10, 20])).toBe("10 10 20");
    expect(substitutePorts("srv {port3}", [10, 20])).toBe("srv {port3}");
    expect(substitutePorts("no placeholders", [10])).toBe("no placeholders");
  });
});

describe("detectBoundPort", () => {
  it("extracts the port from a localhost/loopback URL line", () => {
    expect(detectBoundPort("  ➜  Local:   http://localhost:5175/")).toBe(5175);
    expect(detectBoundPort("Listening on http://127.0.0.1:2568")).toBe(2568);
    expect(detectBoundPort("http://[::1]:3000/")).toBe(3000);
  });
  it("returns null when there's no bound URL with a port", () => {
    expect(detectBoundPort("building for production…")).toBeNull();
    expect(detectBoundPort("open http://example.com/foo")).toBeNull();
    expect(detectBoundPort("http://localhost/")).toBeNull();
  });
});

describe("RunnerService — port injection + reconciliation (mocked)", () => {
  it("substitutes {port} in the command and overlays subApp.env", async () => {
    let seen: { command: string; env: Record<string, string> } | undefined;
    const spawn: SpawnFn = (command, opts) => {
      seen = { command, env: opts.env };
      return new MockChild();
    };
    service = new RunnerService({
      store,
      bus,
      spawn,
      // primary 5173 (base), second 2567 (base) — return the base unchanged.
      getPort: async (p) => p ?? 0,
    });
    const subApp: SubApp = {
      id: "game",
      name: "game",
      path: ".",
      dev: "pnpm dev --port {port}",
      ports: [5173, 2567],
      env: { CLIENT_PORT: "{port}", SERVER_PORT: "{port2}" },
    };
    await service.start("C:/wt", subApp);
    expect(seen?.command).toBe("pnpm dev --port 5173");
    expect(seen?.env.PORT).toBe("5173");
    expect(seen?.env.CLIENT_PORT).toBe("5173");
    expect(seen?.env.SERVER_PORT).toBe("2567");
  });

  it("reconciles the recorded port/url to the port the child prints", async () => {
    let child: MockChild | undefined;
    const spawn: SpawnFn = () => (child = new MockChild());
    service = new RunnerService({
      store,
      bus,
      spawn,
      getPort: async (p) => p ?? 0,
    });
    const subApp: SubApp = {
      id: "game",
      name: "game",
      path: ".",
      dev: "vite",
      ports: [5173],
      url: "http://localhost:{port}",
    };
    const runner = await service.start("C:/wt", subApp);
    expect(runner.port).toBe(5173);

    // Vite hopped to 5175 (base busy) and printed its real URL.
    child!.stdout.write("  ➜  Local:   http://localhost:5175/\n");
    await waitFor(async () => (await store.getRunner(runner.id))?.port === 5175);
    const after = await store.getRunner(runner.id);
    expect(after?.url).toBe("http://localhost:5175");
    expect(after?.ports).toEqual([5175]);
  });
});

/* ------------------------------------------------- manager env quarantine */

/**
 * The regression these cover: launched from the installed app (whose env
 * tools/app/launch.py fills with DISPATCH_DATA_DIR & co), this repo's own
 * `dev-server` subApp came up on the INSTALLED instance's data dir — two
 * processes read-modify-writing one `runners.json`, silently losing each
 * other's entries. See MANAGER_ENV_VARS in runner.ts.
 */
const MANAGER_ENV: NodeJS.ProcessEnv = {
  // What launch.py exports, plus the rest of RUNNING.md's "Config (env)" table.
  DISPATCH_IPC: "1",
  DISPATCH_PORT: "4318",
  DISPATCH_DATA_DIR: "C:/prod/data",
  DISPATCH_CONFIG_DIR: "C:/prod/config",
  DISPATCH_HOME: "C:/prod",
  DISPATCH_HOST: "0.0.0.0",
  DISPATCH_MAX_ACTIVE_SESSIONS: "6",
  // The pre-rename spelling `envVar()` still falls back to — a start-menu
  // shortcut created before the rename sets exactly this.
  CM_DATA_DIR: "C:/prod/data",
  CM_HOME: "C:/prod",
  // Machine/user facts and preferences a subApp is entitled to inherit.
  PATH: "/usr/bin",
  HOME: "/home/me",
  GH_TOKEN: "s3cret",
  DISPATCH_THEME: "dark",
  DISPATCH_CLAUDE_PATH: "/usr/local/bin/claude",
};

/** Start `subApp` with `parentEnv` inherited, returning the child's env. */
async function envForChild(
  subApp: SubApp,
  parentEnv: NodeJS.ProcessEnv = MANAGER_ENV,
): Promise<Record<string, string>> {
  let seen: Record<string, string> = {};
  service = new RunnerService({
    store,
    bus,
    parentEnv,
    spawn: (_command, opts) => {
      seen = opts.env;
      return new MockChild();
    },
    getPort: async (p) => p ?? 0,
  });
  await service.start("C:/wt", subApp);
  return seen;
}

const DEV_SERVER: SubApp = {
  id: "dev-server",
  name: "Dev server",
  path: ".",
  dev: "pnpm dev",
  ports: [4319],
};

describe("RunnerService — manager env quarantine", () => {
  it("drops the manager's identity vars from the inherited env", async () => {
    const env = await envForChild(DEV_SERVER);

    for (const name of MANAGER_ENV_VARS) expect(env[name]).toBeUndefined();

    // The point of all of it: a child server booting on this env resolves its
    // OWN roots, not the installed instance's.
    const child = loadConfig(env);
    expect(child.dataDir).not.toBe(resolve("C:/prod/data"));
    expect(child.configDir).toBeUndefined();
  });

  it("leaves unrelated env — machine facts, credentials, preferences — alone", async () => {
    const env = await envForChild(DEV_SERVER);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/me"); // the USER's home, not DISPATCH_HOME
    expect(env.GH_TOKEN).toBe("s3cret");
    expect(env.DISPATCH_THEME).toBe("dark");
    expect(env.DISPATCH_CLAUDE_PATH).toBe("/usr/local/bin/claude");
  });

  it("drops the legacy CM_* spelling, whatever its case", async () => {
    // Only the old names are set here: scrubbing `DISPATCH_*` alone would let
    // these through and `envVar()` would read them, reproducing the bug.
    const env = await envForChild(DEV_SERVER, {
      PATH: "/usr/bin",
      CM_DATA_DIR: "C:/prod/data",
      CM_CONFIG_DIR: "C:/prod/config",
      // Windows env names are case-insensitive; the plain object we build is not.
      cm_home: "C:/prod",
    });
    expect(env.CM_DATA_DIR).toBeUndefined();
    expect(env.CM_CONFIG_DIR).toBeUndefined();
    expect(env.cm_home).toBeUndefined();
    expect(loadConfig(env).dataDir).not.toBe(resolve("C:/prod/data"));
    expect(env.PATH).toBe("/usr/bin");
  });

  it("lets an explicit manifest env value win over the scrub", async () => {
    // A subApp may genuinely want a specific root — including ours.
    const env = await envForChild({
      ...DEV_SERVER,
      env: {
        DISPATCH_DATA_DIR: "C:/wt/.data",
        DISPATCH_IPC: "0",
        DISPATCH_PORT: "{port}",
      },
    });
    expect(env.DISPATCH_DATA_DIR).toBe("C:/wt/.data");
    expect(env.DISPATCH_IPC).toBe("0");
    expect(env.DISPATCH_PORT).toBe("4319"); // placeholder still substituted
    expect(loadConfig(env).dataDir).toBe(resolve("C:/wt/.data"));
  });

  it("still injects PORT and substitutes {port} placeholders", async () => {
    const env = await envForChild({
      id: "game",
      name: "game",
      path: ".",
      dev: "pnpm dev --port {port}",
      ports: [5173, 2567],
      env: { CLIENT_PORT: "{port}", SERVER_PORT: "{port2}" },
    });
    expect(env.PORT).toBe("5173");
    expect(env.CLIENT_PORT).toBe("5173");
    expect(env.SERVER_PORT).toBe("2567");
  });

  it("hands docker compose the scrubbed env too", async () => {
    let composeEnv: Record<string, string> | undefined;
    const runOnce: RunOnceFn = async (_file, _args, opts) => {
      composeEnv = opts.env;
      return { exitCode: 0 };
    };
    service = new RunnerService({
      store,
      bus,
      parentEnv: MANAGER_ENV,
      runOnce,
      spawn: () => new MockChild(),
      getPort: async (p) => p ?? 0,
    });
    await service.start("C:/wt", {
      id: "stack",
      name: "Stack",
      path: ".",
      dev: "node server.js",
      dockerCompose: "docker-compose.yml",
      ports: [8080],
    });
    expect(composeEnv?.DISPATCH_DATA_DIR).toBeUndefined();
    expect(composeEnv?.CM_DATA_DIR).toBeUndefined();
    expect(composeEnv?.PORT).toBe("8080");
    expect(composeEnv?.PATH).toBe("/usr/bin");
  });
});

describe("scrubManagerEnv", () => {
  it("covers both prefixes for every manager suffix", () => {
    // Derived from config.ts's ENV_PREFIXES, so this can't drift from envVar().
    expect(MANAGER_ENV_VARS).toContain("DISPATCH_DATA_DIR");
    expect(MANAGER_ENV_VARS).toContain("CM_DATA_DIR");
    expect(MANAGER_ENV_VARS).toContain("DISPATCH_IPC");
    expect(MANAGER_ENV_VARS).toContain("CM_IPC");
  });

  it("keeps empty strings and skips undefined entries", () => {
    // "" is a SET variable (the belt-and-braces `DISPATCH_DATA_DIR: ""` some
    // manifests use); undefined is simply absent and must not become "undefined".
    const out = scrubManagerEnv({ EMPTY: "", GONE: undefined, KEEP: "v" });
    expect(out).toEqual({ EMPTY: "", KEEP: "v" });
  });
});

/* ---------------------------------------------------------------- reconcile */

describe("RunnerService — reconcile", () => {
  it("stops dead runners, REAPS live orphans, and leaves terminal ones", async () => {
    await store.saveRunner({
      id: "dead",
      worktreePath: "C:/wt",
      subAppId: "a",
      kind: "process",
      pid: 111,
      status: "running",
    });
    await store.saveRunner({
      id: "alive",
      worktreePath: "C:/wt",
      subAppId: "b",
      kind: "process",
      pid: 222,
      status: "running",
    });
    await store.saveRunner({
      id: "done",
      worktreePath: "C:/wt",
      subAppId: "c",
      kind: "process",
      pid: 333,
      status: "exited",
    });

    const killed: number[] = [];
    service = new RunnerService({
      store,
      bus,
      isPidAlive: (pid) => pid === 222,
      killTree: async (pid) => {
        killed.push(pid);
      },
    });
    await service.reconcile();

    expect((await store.getRunner("dead"))?.status).toBe("stopped");
    expect((await store.getRunner("done"))?.status).toBe("exited");
    expect(
      events.some((e) => e.type === "runner-update" && e.runner.id === "dead"),
    ).toBe(true);

    // The live pid belongs to the previous server process: unmanageable from
    // here (no child handle, no streams, no exit event), so it is tree-killed
    // rather than left holding its port and pushing the next launch upward.
    expect(killed).toEqual([222]);
    expect((await store.getRunner("alive"))?.status).toBe("stopped");
    // A pid that was already gone must not be signalled.
    expect(killed).not.toContain(111);
  });
});
