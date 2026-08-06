/**
 * Canonical on-disk layout for the installed (desktop) deployment.
 *
 * MIRROR: `packages/desktop/src/paths.ts` computes the same thing for the
 * Electron main process. Keep the two in sync — they are intentionally small.
 *
 *   <root>/
 *     app/          payload: the built server + client the desktop shell runs
 *     shell/        branded Electron runtime — `dispatch.exe` + resources
 *     data/         DISPATCH_DATA_DIR  — chats, checkpoints, runners (per-instance)
 *     config/       DISPATCH_CONFIG_DIR — settings, projects, agents, modes (shared)
 *     backups/      pre-update / pre-migration copies
 *
 * `%LOCALAPPDATA%`, never `%APPDATA%`: the state dir is already ~500 MB of chat
 * transcripts and has no business in a roaming profile.
 *
 * NOTE: `<root>` is still literally `claude-manager`. Renaming it would strand
 * every existing chat transcript behind a one-shot migration, which is a poor
 * trade for a directory no user ever looks at. Rename it deliberately later with
 * `desktop:migrate`, not as a side effect of the branding change.
 */
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** Executable basenames in preference order — current first, pre-rename last. */
const EXE_NAMES = ["dispatch", "claude-manager"];

/**
 * The shell executable inside `shellDir`: the branded name, unless only a
 * pre-rename copy is on disk. Returns the branded path when neither exists, so
 * a fresh install writes the current name.
 */
function exeIn(shellDir) {
  const ext = process.platform === "win32" ? ".exe" : "";
  for (const name of EXE_NAMES) {
    const candidate = join(shellDir, name + ext);
    if (existsSync(candidate)) return candidate;
  }
  return join(shellDir, EXE_NAMES[0] + ext);
}

/** Root of the installed deployment. `DISPATCH_HOME` overrides for testing. */
export function desktopRoot(env = process.env) {
  // `CM_HOME` fallback: a shortcut created before the rename still sets it.
  const home = env.DISPATCH_HOME ?? env.CM_HOME;
  if (home) return resolve(home);
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
     *
     * Falls back to the pre-rename name when only that copy is installed, so an
     * existing shortcut keeps launching until `desktop:install-shell` re-runs.
     */
    exe: exeIn(join(root, "shell")),
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
