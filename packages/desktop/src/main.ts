/**
 * Electron main process for Dispatch.
 *
 * Owns exactly one server child (see server-process.ts) and every descendant it
 * spawns, so quitting the app really does stop everything.
 *
 * Design notes worth keeping:
 *   - The window loads `http://127.0.0.1:<port>`, NOT `file://`. The renderer is
 *     then byte-identical to the browser build — same WebSocket origin, same
 *     asset paths, same REST — so nothing about the SPA has to know it's in
 *     Electron.
 *   - Closing the window HIDES it; only the tray's Quit (or an explicit
 *     `app.quit()`) tears the server down. A reflex Alt-F4 must not kill a
 *     three-hour agent run.
 *   - A single-instance lock keeps two shells off one data dir, whose whole-file
 *     maps (`checkpoints.json`, `runners.json`) are guarded by an in-process
 *     mutex only and would silently lose each other's writes.
 */
import { app, BrowserWindow, Tray, Menu, dialog, shell, nativeImage } from "electron";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { desktopPaths } from "./paths";
import { startServer, findFreePort, type ServerHandle } from "./server-process";

/**
 * 4318, not the server's own 4319: the desktop app must coexist with a
 * `pnpm dev` instance out of the box. See findFreePort for the upward scan.
 */
const DEFAULT_PORT = 4318;

const paths = desktopPaths();

/**
 * Which checkout to run the server out of.
 *
 * Default to the one CONTAINING this desktop package (`packages/desktop/../..`)
 * rather than hardcoding the payload. That single rule is correct in both
 * deployments — launched from the payload it resolves to the payload; launched
 * from a dev checkout it resolves to that checkout — so the shortcut works
 * before the first publish instead of dead-ending on a missing payload.
 * `paths.app` remains a fallback for the case where the containing checkout
 * isn't built but the payload is.
 */
function resolveAppDir(): string {
  const built = (dir: string) => existsSync(join(dir, "packages", "server", "dist", "index.js"));
  if (process.env.DISPATCH_APP_DIR) return process.env.DISPATCH_APP_DIR;
  const containing = resolve(app.getAppPath(), "..", "..");
  if (built(containing)) return containing;
  if (built(paths.app)) return paths.app;
  // Nothing built anywhere — hand back the containing checkout so the error
  // names the path the user is most likely to recognise.
  return containing;
}
const appDir = resolveAppDir();

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: ServerHandle | null = null;
/** Set once teardown starts, so `close` stops meaning "hide". */
let quitting = false;

/** Commit/build stamp written by the publish script, shown in the tray tooltip. */
function buildStamp(): string {
  try {
    const raw = JSON.parse(readFileSync(paths.stamp, "utf8")) as {
      sha?: string;
      publishedAt?: string;
    };
    return raw.sha ? `${raw.sha.slice(0, 7)} · ${raw.publishedAt ?? "?"}` : "unknown build";
  } catch {
    return process.env.DISPATCH_APP_DIR ? "dev checkout" : "unknown build";
  }
}

/** Advertise the live instance so the publish script can refuse to clobber it. */
function writeRuntime(url: string, port: number) {
  try {
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(
      paths.runtime,
      JSON.stringify({ pid: process.pid, url, port, appDir, startedAt: Date.now() }, null, 2),
    );
  } catch {
    /* advisory only — never block boot on it */
  }
}

function clearRuntime() {
  try {
    rmSync(paths.runtime, { force: true });
  } catch {
    /* advisory only */
  }
}

function icon() {
  const file = join(__dirname, "..", "assets", "icon.png");
  const img = existsSync(file) ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
  // An empty icon makes Tray throw on Windows; fall back to a 1px placeholder.
  return img.isEmpty()
    ? nativeImage.createFromDataURL(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      )
    : img;
}

function createWindow(url: string) {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    backgroundColor: "#111111",
    title: "Dispatch",
    icon: icon(),
    webPreferences: {
      // The renderer is a plain web app talking to loopback; it needs no Node.
      nodeIntegration: false,
      contextIsolation: true,
      // One narrow bridge: the path of a dropped file, which no browser will
      // disclose. See preload.ts. Sandboxed preloads can require `webUtils`,
      // so this costs none of the isolation above.
      preload: join(__dirname, "preload.js"),
    },
  });

  void win.loadURL(url);
  win.once("ready-to-show", () => win?.show());

  // Close hides to tray. Quitting is explicit — see the module comment.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
  });
  win.on("closed", () => {
    win = null;
  });

  // Keep external links in the real browser rather than a chromeless Electron
  // window with no back button (OAuth flows, GitHub links from the PR panel).
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });

  // Backstop for the classic Electron footgun: a file dropped on any part of the
  // page that doesn't handle the drop navigates the window to `file:///...`,
  // replacing the whole app with a file viewer and no way back. The renderer
  // cancels those drops itself (useFileDrag), but a single gap there would cost
  // the user a running session, so refuse the navigation here too. Anything
  // genuinely external goes to the real browser instead of nowhere.
  win.webContents.on("will-navigate", (e, target) => {
    if (target.startsWith(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(target)) void shell.openExternal(target);
  });
}

function showWindow(url: string) {
  if (!win) return createWindow(url);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray(url: string) {
  tray = new Tray(icon());
  tray.setToolTip(`Dispatch\n${url}\n${buildStamp()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Dispatch — ${buildStamp()}`, enabled: false },
      { type: "separator" },
      { label: "Open", click: () => showWindow(url) },
      { label: "Open in browser", click: () => void shell.openExternal(url) },
      { type: "separator" },
      {
        label: "Quit (stops all agents & subApps)",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", () => showWindow(url));
}

async function boot() {
  let port = 0;
  try {
    port = process.env.DISPATCH_PORT ? Number(process.env.DISPATCH_PORT) : await findFreePort(DEFAULT_PORT);
    server = await startServer({
      appDir,
      dataDir: process.env.DISPATCH_DATA_DIR ?? paths.dataDir,
      configDir: process.env.DISPATCH_CONFIG_DIR ?? paths.configDir,
      port,
      onLog: (line) => process.stdout.write(`${line}\n`),
    });
  } catch (err) {
    dialog.showErrorBox(
      "Dispatch failed to start",
      `${(err as Error).message}\n\n${server?.recentLogs() ?? ""}`,
    );
    quitting = true;
    app.quit();
    return;
  }

  // If the server dies on its own, say so rather than leaving a dead window.
  server.onExit((code) => {
    if (quitting) return;
    dialog.showErrorBox(
      "Dispatch server stopped",
      `The server exited (code ${code}).\n\n${server?.recentLogs() ?? ""}`,
    );
    quitting = true;
    app.quit();
  });

  writeRuntime(server.url, port);
  createWindow(server.url);
  createTray(server.url);
}

// One shell per data dir. A second launch just surfaces the running window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (server) showWindow(server.url);
  });

  void app.whenReady().then(boot);

  // Tray app: outliving the last window is the point.
  app.on("window-all-closed", () => {
    /* keep running */
  });
  app.on("activate", () => {
    if (server) showWindow(server.url);
  });

  // The one place teardown happens. `before-quit` is async-hostile, so we cancel
  // the first quit, run the real shutdown, then quit for good.
  // Belt and braces: any quit path that bypasses the teardown below (a failed
  // boot, an OS session end) still clears the marker. `publish.mjs` tolerates a
  // stale one by probing the port, but a lingering file is confusing on its own.
  app.on("will-quit", clearRuntime);

  let teardown: Promise<void> | null = null;
  app.on("before-quit", (e) => {
    if (!server || teardown) return;
    e.preventDefault();
    quitting = true;
    teardown = server.stop().finally(() => {
      server = null;
      clearRuntime();
      app.quit();
    });
  });
}
