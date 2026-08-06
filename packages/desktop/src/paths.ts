/**
 * Canonical on-disk layout for the installed deployment.
 *
 * MIRROR: `tools/desktop/paths.mjs` computes the same thing for the install /
 * publish / migrate scripts, which must run without a build step. Keep both in
 * sync — they are intentionally small enough that duplicating beats wiring a
 * build dependency between the scripts and this package.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface DesktopPaths {
  root: string;
  /** Payload the shell runs: a built checkout with `packages/server/dist`. */
  app: string;
  /** DISPATCH_DATA_DIR — chats, checkpoints, runners. Per-instance. */
  dataDir: string;
  /** DISPATCH_CONFIG_DIR — settings, projects, agents, modes. Shareable. */
  configDir: string;
  /** Build stamp written by the publish script (commit sha + time). */
  stamp: string;
  /**
   * Written while the shell is up, removed on clean exit. The publish script
   * reads it to refuse updating underneath a running app — swapping the payload
   * mid-turn is exactly how you lose a long-running agent run.
   */
  runtime: string;
}

/**
 * `%LOCALAPPDATA%`, never `%APPDATA%`: the state dir is ~500 MB of transcripts
 * and has no business roaming. `DISPATCH_HOME` overrides the whole root.
 */
export function desktopPaths(env: NodeJS.ProcessEnv = process.env): DesktopPaths {
  // `CM_HOME` fallback: a shortcut created before the rename still sets it.
  const home = env.DISPATCH_HOME ?? env.CM_HOME;
  const root = home
    ? resolve(home)
    : join(
        env.LOCALAPPDATA ??
          env.XDG_DATA_HOME ??
          join(
            homedir(),
            process.platform === "darwin" ? "Library/Application Support" : ".local/share",
          ),
        // Deliberately still the pre-rename name: renaming this root would
        // strand every existing chat transcript behind a one-shot migration,
        // for a directory no user ever opens. Move it with `desktop:migrate`
        // as its own decision, not as a side effect of the branding change.
        "claude-manager",
      );
  return {
    root,
    app: join(root, "app"),
    dataDir: join(root, "data"),
    configDir: join(root, "config"),
    stamp: join(root, "current.json"),
    runtime: join(root, "runtime.json"),
  };
}
