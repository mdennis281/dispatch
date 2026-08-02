/**
 * Canonical on-disk layout for the installed (desktop) deployment.
 *
 * MIRROR: `packages/desktop/src/paths.ts` computes the same thing for the
 * Electron main process. Keep the two in sync — they are intentionally small.
 *
 *   <root>/
 *     app/          payload: the built server + client the desktop shell runs
 *     shell/        branded Electron runtime — `claude-manager.exe` + resources
 *     data/         CM_DATA_DIR  — chats, checkpoints, runners (per-instance)
 *     config/       CM_CONFIG_DIR — settings, projects, agents, modes (shared)
 *     backups/      pre-update / pre-migration copies
 *
 * `%LOCALAPPDATA%`, never `%APPDATA%`: the state dir is already ~500 MB of chat
 * transcripts and has no business in a roaming profile.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Root of the installed deployment. `CM_HOME` overrides for testing. */
export function desktopRoot(env = process.env) {
  if (env.CM_HOME) return resolve(env.CM_HOME);
  const local =
    env.LOCALAPPDATA ??
    env.XDG_DATA_HOME ??
    join(homedir(), process.platform === "darwin" ? "Library/Application Support" : ".local/share");
  return join(local, "claude-manager");
}

/** Every path the desktop deployment cares about, derived from one root. */
export function desktopPaths(env = process.env) {
  const root = desktopRoot(env);
  return {
    root,
    app: join(root, "app"),
    shell: join(root, "shell"),
    /**
     * The app's OWN executable. Windows identifies a pinned taskbar item by its
     * target exe, so launching the shared `electron.exe` makes Windows pin
     * "Electron" — icon and all — no matter what the shortcut says. A renamed,
     * icon-stamped copy is what gives the app its own identity.
     */
    exe: join(root, "shell", process.platform === "win32" ? "claude-manager.exe" : "claude-manager"),
    dataDir: join(root, "data"),
    configDir: join(root, "config"),
    backups: join(root, "backups"),
    stamp: join(root, "current.json"),
    runtime: join(root, "runtime.json"),
  };
}

/**
 * How a single-root `.data` dir splits across the two roots. Anything NOT named
 * here is treated as unknown state and copied to `data/` rather than dropped —
 * losing an unrecognised file is strictly worse than misfiling it.
 */
export const CONFIG_ENTRIES = ["config.json", "projects", "agents", "modes"];
export const STATE_ENTRIES = ["chats", "checkpoints.json", "runners.json"];
