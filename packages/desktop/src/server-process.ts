/**
 * Supervises the Dispatch server as a child of the Electron shell.
 *
 * ── Why a child process and not just `import('./start.js')` in main ─────────
 * The Agent SDK spawns the `claude` CLI, and tooling that resolves a Node binary
 * via `process.execPath` would get `electron.exe` inside the main process — a
 * confusing class of spawn failure. Running the server under a real `node`
 * removes the ambiguity entirely. It also means:
 *   - a server crash shows an error dialog instead of killing the window, and
 *   - "stop everything" is one pid to tree-kill, since every SDK session and
 *     subApp dev server is a descendant of this child.
 *
 * ── Shutdown ────────────────────────────────────────────────────────────────
 * Windows can't deliver SIGTERM, so we ask over stdin (see server/shutdown.ts),
 * give the server a grace window to run `services.dispose()` → `runner.stopAll()`,
 * and only then tree-kill. Skipping the polite step would orphan every subApp —
 * the precise failure the Ports & processes panel exists to mop up.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import treeKill from "tree-kill";

/** How long the server gets to tear down before we tree-kill it. */
const STOP_GRACE_MS = 25_000;
/** How long to wait for the server's "ready" line before giving up. */
const BOOT_TIMEOUT_MS = 60_000;

export interface ServerHandle {
  url: string;
  stop(): Promise<void>;
  onExit(fn: (code: number | null) => void): void;
  /** Last N log lines, for the error dialog when boot fails. */
  recentLogs(): string;
}

export interface StartServerOptions {
  /** Payload root — a checkout containing `packages/server/dist/index.js`. */
  appDir: string;
  dataDir: string;
  configDir: string;
  port: number;
  /** Absolute path to a real `node`. Falls back to whatever is on PATH. */
  nodePath?: string;
  onLog?: (line: string) => void;
}

/** Is `port` bindable on loopback right now? */
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/**
 * First free port at or above `from`. The desktop app defaults to 4318 rather
 * than the server's own 4319 so it can run alongside a `pnpm dev` instance with
 * no configuration; the scan then covers the case where 4318 is taken too. The
 * user never types this URL — they click the app — and the tray menu reports
 * whatever was actually bound.
 */
export async function findFreePort(from: number, tries = 20): Promise<number> {
  for (let p = from; p < from + tries; p++) if (await isFree(p)) return p;
  throw new Error(`no free port in ${from}..${from + tries - 1}`);
}

function serverEntry(appDir: string): string {
  const entry = join(appDir, "packages", "server", "dist", "index.js");
  if (!existsSync(entry)) {
    throw new Error(
      `server build not found at:\n  ${entry}\n\n` +
        `Build that checkout with \`pnpm build\`, or publish a payload with the\n` +
        `"Dispatch: Publish to stable" task (\`pnpm desktop:publish\`).`,
    );
  }
  return entry;
}

export async function startServer(opts: StartServerOptions): Promise<ServerHandle> {
  const entry = serverEntry(opts.appDir);
  const logs: string[] = [];
  const record = (line: string) => {
    logs.push(line);
    if (logs.length > 200) logs.shift();
    opts.onLog?.(line);
  };

  const child: ChildProcess = spawn(opts.nodePath ?? "node", [entry], {
    cwd: opts.appDir,
    // 'ipc' is deliberately absent: stdin IS the control channel (portable to
    // Windows, and it doubles as a liveness signal — see server/shutdown.ts).
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      DISPATCH_IPC: "1",
      DISPATCH_PORT: String(opts.port),
      DISPATCH_DATA_DIR: opts.dataDir,
      DISPATCH_CONFIG_DIR: opts.configDir,
      // The shell owns the lifecycle; don't let a stale value leak in.
      ELECTRON_RUN_AS_NODE: undefined as unknown as string,
    },
    windowsHide: true,
  });

  let exited = false;
  const exitListeners: Array<(code: number | null) => void> = [];
  child.on("exit", (code) => {
    exited = true;
    for (const fn of exitListeners) fn(code);
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not become ready within ${BOOT_TIMEOUT_MS / 1000}s`)),
      BOOT_TIMEOUT_MS,
    );
    const scan = (buf: Buffer) => {
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        record(line);
        const ready = /\[(?:dispatch|claude-manager)\] ready (\S+)/.exec(line);
        if (ready) {
          clearTimeout(timer);
          resolve(ready[1]!);
        }
      }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn node: ${err.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited during boot (code ${code})`));
    });
  });

  return {
    url,
    onExit: (fn) => exitListeners.push(fn),
    recentLogs: () => logs.slice(-40).join("\n"),
    async stop() {
      if (exited || child.pid === undefined) return;
      const pid = child.pid;
      // 1. Ask politely — this is what runs runner.stopAll() and kills subApps.
      await new Promise<void>((done) => {
        const finish = () => {
          clearTimeout(timer);
          done();
        };
        const timer = setTimeout(finish, STOP_GRACE_MS);
        child.once("exit", finish);
        try {
          child.stdin?.write("shutdown\n");
          child.stdin?.end();
        } catch {
          finish(); // stdin already gone; fall through to the tree-kill
        }
      });
      // 2. Whatever survived the grace window goes with the tree. Descendants
      //    (SDK sessions, dev servers) are the point — killing only `pid` would
      //    leave exactly the orphans this is meant to prevent.
      if (!exited) {
        await new Promise<void>((done) => treeKill(pid, "SIGKILL", () => done()));
      }
    },
  };
}
