/**
 * Launching the release installer from inside the app it is about to replace.
 *
 * This is the whole reason the update button is not just "run a command":
 * `tools/install.mjs:424-428` stops the running server itself (via
 * `launch.py --stop`) before it renames `app/` out from under it. Anything we
 * spawn the ordinary way dies with us, halfway through the swap, with the old
 * payload already moved aside — the exact failure `tools/app/upgrade.mjs`'s
 * `detachSwap()` was written to avoid. So the installer is spawned **detached
 * and unref'd**, in its own process group, and outlives the shutdown it causes.
 *
 * Three details are load-bearing and each one is a real Windows failure:
 *
 *   - **cwd must be outside `app/`.** Windows refuses to rename a directory that
 *     is any process's current directory, so an installer launched with the
 *     server's cwd (`app/packages/server`) would block its own swap. This is the
 *     same hazard `install.ps1:29-35` handles by exporting `DISPATCH_INSTALL_CWD`
 *     and stepping out to the temp dir; we start there to begin with.
 *   - **stdio goes to a file, not `"ignore"`.** The installer reports progress
 *     only as prose on stdout (`tools/install.mjs:384-400`), and once we are
 *     gone there is no console left to inherit. Without `update.log` a failed
 *     update leaves nothing to read but a server that never came back.
 *   - **the installer script is COPIED out of the payload before it runs.** Node
 *     reads a module fully at load, so running it in place would probably
 *     survive the rename — but `app/` cannot be renamed while a process holds an
 *     open handle inside it, and betting the swap on load-timing is not worth
 *     the two lines it saves.
 *
 * Everything the update itself needs — checksum verification, staging, atomic
 * swap, health gating, rollback, rewriting `current.json` — is already the
 * installer's job (`tools/install.mjs:393-528`). Nothing here reimplements any
 * of it; this module's entire responsibility is to start that script in a way
 * that survives us.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Repo the installer defaults to; `DISPATCH_INSTALL_REPO` overrides. */
const DEFAULT_REPO = "mdennis281/dispatch";

/** A download that has not answered by now is not going to; the bundled copy is right there. */
const DOWNLOAD_TIMEOUT_MS = 20_000;

export interface LaunchUpdateOptions {
  /** Release to install, e.g. `v2026.08.14.85068`. */
  tag: string;
  /** The running payload directory (`<root>/app`). */
  appDir: string;
  repo?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
}

export interface LaunchUpdateResult {
  /** Pid of the detached installer, when the platform reported one. */
  pid?: number;
  /** Where its output is being written. */
  logFile: string;
  /** `"release"` when we fetched the current installer, `"payload"` on the bundled fallback. */
  installerSource: "release" | "payload";
}

/**
 * Fetch the release's own `install.mjs`, exactly as the documented one-liner
 * does (`install.ps1:7-18`), so the update runs the CURRENT installer rather
 * than whatever shipped with the build being replaced — installer fixes have to
 * be able to reach an install that is already broken.
 *
 * Falls back to the copy inside the payload. That copy is by definition older,
 * but an installer we cannot download is worth less than one we can.
 */
async function stageInstaller(
  dir: string,
  opts: LaunchUpdateOptions,
): Promise<{ path: string; source: "release" | "payload" }> {
  const path = join(dir, "install.mjs");
  const repo = opts.repo ?? opts.env?.DISPATCH_INSTALL_REPO ?? DEFAULT_REPO;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = opts.env?.GITHUB_TOKEN ?? opts.env?.GH_TOKEN;

  try {
    const response = await fetchImpl(
      `https://github.com/${repo}/releases/download/${encodeURIComponent(opts.tag)}/install.mjs`,
      {
        headers: {
          "User-Agent": "dispatch-update-install",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const body = await response.text();
    // A redirect to a login page or an error blob is still a 200. Refuse
    // anything that is not recognisably the installer rather than handing
    // `node` an HTML file and reading the failure out of update.log later.
    if (!body.includes("desktopRoot")) throw new Error("downloaded install.mjs is not the installer");
    await writeFile(path, body, "utf8");
    return { path, source: "release" };
  } catch {
    await copyFile(join(opts.appDir, "tools", "install.mjs"), path);
    return { path, source: "payload" };
  }
}

/**
 * Start the installer for `tag` and return once it is safely detached.
 *
 * Resolves as soon as the child is spawned — by design. The caller is about to
 * be shut down BY that child, so there is nothing left to await; the browser
 * learns how it went by polling `/api/health` until the new build answers.
 */
export async function launchUpdate(opts: LaunchUpdateOptions): Promise<LaunchUpdateResult> {
  const root = resolve(opts.appDir, "..");
  const workDir = await mkdtemp(join(tmpdir(), "dispatch-update-"));
  const { path: installer, source } = await stageInstaller(workDir, opts);

  const logFile = join(root, "update.log");
  const log = await open(logFile, "a");
  try {
    // Where THIS install's output begins. The log is opened in append mode and
    // never rotated, so without this every reader sees the whole history — and
    // `services/update-progress.ts` would report a previous update's `done` (or
    // its failure) as the current one's outcome. Sampled from the handle we just
    // opened, so it cannot race a write.
    const logOffset = (await log.stat()).size;

    // Written BEFORE the spawn: if the machine dies mid-update this file is the
    // only record that an update was even attempted, and it sits beside the
    // `upgrade.json` the dev tooling writes for the same reason.
    await writeFile(
      join(root, "update.json"),
      `${JSON.stringify(
        {
          phase: "launched",
          tag: opts.tag,
          installerSource: source,
          startedAt: new Date().toISOString(),
          logOffset,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const spawnImpl = opts.spawnImpl ?? spawn;
    const child = spawnImpl(
      process.execPath,
      [
        installer,
        "--version",
        opts.tag,
        "--target",
        root,
        // The shortcut already exists and points at a path that does not move.
        // Re-creating it on every update is churn on the user's Start menu.
        "--no-shortcut",
      ],
      {
        cwd: workDir,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log.fd, log.fd],
        env: {
          ...(opts.env ?? process.env),
          // Do not open a browser when the update finishes. The tab that
          // clicked Update is already on the updating screen and reloads itself
          // the moment the new build answers (see UpdatingScreen), so the
          // installer's `openBrowser` only ever adds a duplicate — and someone
          // updating remotely comes back to one stray tab per update.
          //
          // An env var rather than `--no-open`: the installer is fetched from
          // the TARGET release, so installing an older tag runs an older
          // install.mjs that would reject the unknown flag outright and fail
          // the whole update. An unknown env var is ignored.
          DISPATCH_INSTALL_NO_OPEN: "1",
          // Belt and braces for the cwd hazard above: the installer resolves a
          // relative --target against this, and we are handing it an absolute
          // one, but a future installer that consults it must not be pointed
          // back inside app/.
          DISPATCH_INSTALL_CWD: workDir,
        },
      },
    );
    child.unref();
    return { ...(child.pid ? { pid: child.pid } : {}), logFile, installerSource: source };
  } finally {
    // The child holds its own duplicated descriptor; ours has no further use and
    // would otherwise keep the log handle open across the shutdown.
    await log.close();
  }
}
