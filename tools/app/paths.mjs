/**
 * Canonical on-disk layout for the installed deployment.
 *
 * MIRROR: `tools/app/launch.py` computes the same thing for the launcher. Keep
 * the two in sync — they are intentionally small.
 *
 *   <root>/
 *     app/          payload: the built server + client, a real git checkout
 *     data/         DISPATCH_DATA_DIR  — chats, checkpoints, runners (per-instance)
 *     config/       DISPATCH_CONFIG_DIR — settings, projects, agents, modes (shared)
 *     backups/      pre-update / pre-migration copies
 *
 * `%LOCALAPPDATA%`, never `%APPDATA%`: the state dir is already ~500 MB of chat
 * transcripts and has no business in a roaming profile.
 *
 * There is no `shell/` any more. Dispatch used to ship a branded Electron
 * runtime here — ~270 MB copied per version and stamped with rcedit, purely so
 * Windows would pin the right icon. As an installed PWA the browser provides
 * that identity itself, so the whole directory and the tooling that filled it
 * are gone.
 *
 * NOTE: `<root>` is still literally `claude-manager`. Renaming it would strand
 * every existing chat transcript behind a one-shot migration, which is a poor
 * trade for a directory no user ever looks at. Rename it deliberately later with
 * `pnpm app:migrate`, not as a side effect of the branding change.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
export const STATE_ENTRIES = [
  "chats",
  // The SQLite state database and its WAL sidecars. All three, because moving
  // `state.db` without `-wal` silently drops every commit still in the log.
  "state.db",
  "state.db-wal",
  "state.db-shm",
  "checkpoints.json",
  "runners.json",
];

/**
 * The JSON/JSONL state that `state.db` replaced, in the order the migration
 * reports them. Still listed in STATE_ENTRIES above because `app:migrate` must
 * keep moving them: the tree stays on disk as the rollback path until
 * `app:migrate-store --prune` removes it.
 *
 * MIRROR: `LEGACY_STATE_ENTRIES` in packages/server/src/store/db.ts, which the
 * server's startup guard reads. Same reason this file already mirrors
 * `launch.py` — one is a `.mjs` tool, the other is bundled TypeScript.
 */
export const LEGACY_STATE_ENTRIES = [
  "runners.json",
  "mcp-ports.json",
  "worktrees.json",
  "terminals.json",
  "terminals",
  "prs.json",
  "checkpoints.json",
];
