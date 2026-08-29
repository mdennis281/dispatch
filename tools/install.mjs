#!/usr/bin/env node
/**
 * Install or update Dispatch from a checksum-verified GitHub Release archive.
 *
 * This file is intentionally dependency-free: install.ps1/install.sh download
 * it to the OS temp directory, so an end user needs Node but not Git or a clone.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO = "mdennis281/dispatch";
const PNPM_VERSION = "11.5.0";
const MIN_NODE_MAJOR = 24;
/**
 * Backup payloads kept under `backups/` after a successful update.
 *
 * ONE, because one is all a rollback can reach: `current.json` records exactly
 * one `previous`, and putting that directory back is the only recovery this
 * installer supports. Every older payload is a copy of a release still
 * downloadable from GitHub — and they are not small. A payload is ~350 MB, so
 * an install updated daily passes 10 GB inside a month. A real store had 63 of
 * them totalling 22 GB, against 1.2 GB of the chat history the app exists for.
 */
const BACKUP_KEEP = 1;
/** Directories under `backups/` this prunes: the two the swap below creates. */
const BACKUP_NAME = /^(?:app|failed)-.+-(\d{10,})$/;
const REQUIRED_PAYLOAD = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "packages/server/dist/index.js",
  "packages/client/dist/index.html",
  "packages/shared/dist/index.js",
  "packages/cli/dist/index.js",
  "tools/app/launch.py",
];

function usage() {
  console.log(`Install or update Dispatch from GitHub Releases.

Usage: node install.mjs [options]

  --version <tag>     install a release tag instead of the channel head
  --channel <name>    stable (default) or unstable; ignored with --version
  --repo <owner/name> release repository (default: ${DEFAULT_REPO})
  --target <path>     installation root (default: the platform user-data dir)
  --no-start          install without starting Dispatch
  --no-open           start Dispatch without opening it in a browser
  --no-shortcut       do not create a Start-menu/PATH launcher
  --dry-run           resolve and verify the release without changing the install
  --help              show this help

Set GITHUB_TOKEN for private repositories or to avoid anonymous API limits.
Rerun the same command later to update to the newest release.`);
}

export function parseArgs(argv) {
  const out = {
    repo: process.env.DISPATCH_INSTALL_REPO || DEFAULT_REPO,
    channel: "stable",
    start: true,
    // A self-update is the one caller that must NOT open a browser: the tab
    // that asked for it is already sitting on the updating screen waiting to
    // reload itself. Honouring an env var as well as the flag is deliberate —
    // `services/update-install.ts` fetches the installer from the TARGET
    // release, so installing an older tag runs an older install.mjs, and an
    // unknown `--no-open` there is a hard `unknown argument` failure where an
    // unknown env var is simply ignored. The server passes the variable; the
    // flag is for people.
    open: process.env.DISPATCH_INSTALL_NO_OPEN !== "1",
    shortcut: true,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--no-start") out.start = false;
    else if (arg === "--no-open") out.open = false;
    else if (arg === "--no-shortcut") out.shortcut = false;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--version") out.version = requiredValue(argv, ++i, arg);
    else if (arg === "--channel") out.channel = requiredValue(argv, ++i, arg);
    else if (arg === "--repo") out.repo = requiredValue(argv, ++i, arg);
    else if (arg === "--target") out.target = requiredValue(argv, ++i, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(out.repo)) {
    throw new Error(`--repo must be an owner/name pair (received ${JSON.stringify(out.repo)})`);
  }
  if (out.channel !== "stable" && out.channel !== "unstable") {
    throw new Error(`--channel must be stable or unstable (received ${JSON.stringify(out.channel)})`);
  }
  return out;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function assertNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    throw new Error(`Node ${MIN_NODE_MAJOR}+ is required; found ${process.version}`);
  }
}

export function desktopRoot(override) {
  if (override) return resolve(process.env.DISPATCH_INSTALL_CWD || process.cwd(), override);
  if (process.env.DISPATCH_HOME) return resolve(process.env.DISPATCH_HOME);
  const base =
    process.env.LOCALAPPDATA ||
    process.env.XDG_DATA_HOME ||
    join(homedir(), platform() === "darwin" ? "Library/Application Support" : ".local/share");
  return join(base, "claude-manager");
}

function assertSafeRoot(root) {
  const parsed = parse(root);
  if (resolve(root) === resolve(parsed.root)) {
    throw new Error(`refusing to use a filesystem root as --target: ${root}`);
  }
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "dispatch-release-installer",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchOk(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...githubHeaders(), ...options.headers } });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`GitHub request failed (${response.status}) for ${url}\n${body}`);
  }
  return response;
}

/** How far back the unstable channel looks; its head is always the newest release. */
const UNSTABLE_PAGE_SIZE = 30;

/**
 * Order two build stamps (`yyyy.mm.dd.sssss`), or `null` when either is not one.
 *
 * A local copy of `packages/shared/src/version.ts` on purpose: this file is
 * downloaded standalone by `install.ps1`/`install.sh` and by the in-app updater,
 * long before any workspace package exists to import from.
 */
export function compareStamps(a, b) {
  const strip = (v) => (v.startsWith("v") ? v.slice(1) : v);
  const stamp = /^\d{4}\.\d{2}\.\d{2}\.\d{5}$/;
  const left = strip(a);
  const right = strip(b);
  if (!stamp.test(left) || !stamp.test(right)) return null;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The newest release on `channel`.
 *
 * Stable is `releases/latest`, which GitHub already filters prereleases and
 * drafts out of server-side. Unstable has to do it here: list a page, drop the
 * drafts (their assets may not exist), and take the highest build stamp — by
 * version, not by the list's own order, and skipping anything unorderable rather
 * than guessing. Promoted builds stay in that list, so promoting a release must
 * never look to an unstable install like the channel went backwards.
 */
async function resolveChannelHead(repo, channel) {
  if (channel !== "unstable") {
    return (await fetchOk(`https://api.github.com/repos/${repo}/releases/latest`)).json();
  }
  const list = await (
    await fetchOk(`https://api.github.com/repos/${repo}/releases?per_page=${UNSTABLE_PAGE_SIZE}`)
  ).json();
  let best = null;
  for (const release of Array.isArray(list) ? list : []) {
    if (release.draft || typeof release.tag_name !== "string") continue;
    // Unorderable (a semver tag) is skipped, not guessed at — same call the
    // server's comparator documents.
    if (compareStamps(release.tag_name, release.tag_name) === null) continue;
    // `-1` means `best` is OLDER than this one, so this one takes over.
    if (!best || compareStamps(best.tag_name, release.tag_name) === -1) best = release;
  }
  if (!best) throw new Error(`no installable release found on the unstable channel of ${repo}`);
  return best;
}

export async function resolveRelease(repo, requestedVersion, channel = "stable") {
  const tag = requestedVersion
    ? requestedVersion.startsWith("v")
      ? requestedVersion
      : `v${requestedVersion}`
    : null;
  const release = tag
    ? await (
        await fetchOk(
          `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
        )
      ).json()
    : await resolveChannelHead(repo, channel);
  // A DRAFT is refused however it was reached: its assets may not be uploaded,
  // so this would fail later and messier. A PRERELEASE is only refused when it
  // arrived by channel resolution — an explicitly named tag is the unstable
  // channel's whole install path, and the in-app updater always names one.
  if (release.draft) throw new Error(`refusing draft ${release.tag_name}`);
  if (release.prerelease && !tag && channel !== "unstable") {
    throw new Error(`refusing prerelease ${release.tag_name} on the stable channel`);
  }
  const archiveName = `dispatch-${release.tag_name}.tar.gz`;
  const archive = release.assets?.find((asset) => asset.name === archiveName);
  const checksums = release.assets?.find((asset) => asset.name === "SHA256SUMS");
  if (!archive || !checksums) {
    throw new Error(
      `release ${release.tag_name} must contain ${archiveName} and SHA256SUMS`,
    );
  }
  return { release, archive, checksums };
}

async function download(url, path) {
  const response = await fetchOk(url, { headers: { Accept: "application/octet-stream" } });
  if (!response.body) throw new Error(`GitHub returned an empty body for ${url}`);
  const hash = createHash("sha256");
  const hashAndPass = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    hashAndPass,
    createWriteStream(path, { flags: "wx" }),
  );
  return hash.digest("hex");
}

function checksumFor(text, filename) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && match[2] === filename) return match[1].toLowerCase();
  }
  throw new Error(`SHA256SUMS has no entry for ${filename}`);
}

export function inspectArchive(path) {
  const listing = run("tar", ["-tzf", path], { quiet: true });
  for (const raw of listing.split(/\r?\n/).filter(Boolean)) {
    const normalized = raw.replace(/\\/g, "/");
    const parts = normalized.split("/").filter((part) => part && part !== ".");
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      parts.includes("..")
    ) {
      throw new Error(`release archive contains an unsafe path: ${raw}`);
    }
  }

  // A lexical path check is not enough: `link -> ../outside` followed by
  // `link/file` can redirect a later extraction outside stage/. Release
  // payloads need only ordinary files and directories, so reject every other
  // tar entry type before extraction (symlink, hardlink, device, FIFO, etc.).
  const verboseListing = run("tar", ["-tvzf", path], { quiet: true });
  for (const line of verboseListing.split(/\r?\n/).filter(Boolean)) {
    const kind = line[0];
    if (kind !== "-" && kind !== "d") {
      throw new Error(`release archive contains an unsupported link/device entry: ${line}`);
    }
  }
}

export function run(command, args, options = {}) {
  if (!options.quiet) console.log(`  $ ${command} ${args.join(" ")}`);
  const useShell = platform() === "win32" && /^(pnpm|npx|corepack)$/.test(command);
  // Node 24+ warns when an argv array is combined with `shell: true` because
  // arbitrary arguments would be concatenated without escaping. Every shell
  // invocation here is an internal, fixed pnpm probe/install command, so pass
  // one command string and no separate argv array. Other commands still bypass
  // the shell entirely.
  const shellTokens = [command, ...args];
  if (useShell && shellTokens.some((token) => !/^[A-Za-z0-9@._=+-]+$/.test(token))) {
    throw new Error(`refusing unsafe package-manager shell argument: ${args.join(" ")}`);
  }
  const executable = useShell ? shellTokens.join(" ") : command;
  const commandArgs = useShell ? [] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd: options.cwd,
    env: process.env,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
    shell: useShell,
    // A self-update runs this installer detached with `windowsHide`, so the
    // process has NO console of its own — and Windows then allocates a brand
    // new console WINDOW for every console-subsystem child it spawns. That is
    // ~20 of them per update (tar twice, the pnpm/corepack/npx probes, two
    // installs, the python probes, launch.py --stop, launch.py --no-window),
    // each flashing up and vanishing on the user's desktop while they watch the
    // progress screen. CREATE_NO_WINDOW gives the child its console without the
    // window; nothing about the captured output changes.
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.quiet ? `\n${result.stderr || result.stdout || ""}` : "";
    throw new Error(`${command} exited ${result.status}${detail}`);
  }
  return String(result.stdout || "").trim();
}

export async function renameWithRetry(
  source,
  destination,
  {
    attempts = platform() === "win32" ? 41 : 1,
    delayMs = 250,
    rename = renameSync,
    wait = delay,
  } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const retryable = ["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"].includes(error?.code);
      if (!retryable || attempt >= attempts) {
        if (retryable) {
          throw new Error(
            `${error.message}\nWindows still has the installed app open. Close terminals whose current directory is inside ${source}, then retry.`,
            { cause: error },
          );
        }
        throw error;
      }
      await wait(delayMs);
    }
  }
}

function commandWorks(command, args = ["--version"]) {
  try {
    run(command, args, { quiet: true });
    return true;
  } catch {
    return false;
  }
}

function pnpmCommand() {
  if (commandWorks("pnpm")) return { command: "pnpm", prefix: [] };
  if (commandWorks("corepack", ["pnpm", "--version"])) return { command: "corepack", prefix: ["pnpm"] };
  if (commandWorks("npx", ["--yes", `pnpm@${PNPM_VERSION}`, "--version"])) {
    return { command: "npx", prefix: ["--yes", `pnpm@${PNPM_VERSION}`] };
  }
  throw new Error(`pnpm is unavailable; install pnpm ${PNPM_VERSION} and retry`);
}

function installDependencies(payload, pnpm) {
  run(
    pnpm.command,
    [
      ...pnpm.prefix,
      "install",
      "--prod",
      "--frozen-lockfile",
      "--config.confirmModulesPurge=false",
    ],
    { cwd: payload },
  );
}

export function verifyPayload(payload, { importRuntime = true } = {}) {
  const missing = REQUIRED_PAYLOAD.filter((path) => !existsSync(join(payload, path)));
  if (missing.length) throw new Error(`release payload is incomplete:\n  ${missing.join("\n  ")}`);
  if (!importRuntime) return;
  run(
    process.execPath,
    ["--input-type=module", "--eval", "await import('./packages/shared/dist/index.js')"],
    { cwd: payload, quiet: true },
  );
}

function findPython() {
  const candidates = platform() === "win32"
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]];
  for (const [command, prefix] of candidates) {
    if (
      commandWorks(command, [
        ...prefix,
        "-c",
        "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)",
      ])
    ) {
      return { command, prefix };
    }
  }
  throw new Error("Python 3.10+ is required by the Dispatch launcher but was not found on PATH");
}

function launch(python, launcher, args = []) {
  run(python.command, [...python.prefix, launcher, ...args], { cwd: dirname(launcher) });
}

function createPosixLauncher(root, python) {
  const bin = join(homedir(), ".local", "bin");
  const target = join(bin, "dispatch");
  const launcher = join(root, "app", "tools", "app", "launch.py");
  mkdirSync(bin, { recursive: true });
  const quoted = launcher.replace(/'/g, `'"'"'`);
  const pythonCommand = [python.command, ...python.prefix]
    .map((part) => `'${String(part).replace(/'/g, `'"'"'`)}'`)
    .join(" ");
  writeFileSync(target, `#!/usr/bin/env sh\nexec ${pythonCommand} '${quoted}' "$@"\n`);
  chmodSync(target, 0o755);
  console.log(`created ${target}`);
  if (!(process.env.PATH || "").split(":").includes(bin)) {
    console.log(`note: add ${bin} to PATH to run \`dispatch\` from any shell.`);
  }
}

function openBrowser(url) {
  const commands =
    platform() === "win32"
      ? [["powershell", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${url}'`]]]
      : platform() === "darwin"
        ? [["open", [url]]]
        : [["xdg-open", [url]]];
  for (const [command, args] of commands) {
    try {
      // `windowsHide` for the same reason as `run()`: this is `powershell` on
      // Windows, and from a console-less installer it would flash its own.
      const result = spawnSync(command, args, { stdio: "ignore", windowsHide: true });
      if (result.status === 0) return;
    } catch {
      // The URL printed below is the dependable fallback on headless machines.
    }
  }
}

/**
 * Delete stale payloads under `backups/`, keeping the newest {@link BACKUP_KEEP}
 * plus anything named in `protect`.
 *
 * ORDERED BY THE TRAILING EPOCH the swap stamps on, not by mtime and not
 * lexically. mtime is wrong because restoring a rollback rewrites it; whole-name
 * lexical order is wrong because the tag sits in the middle and its length
 * varies, which sorts `app-v2026.9.1-…` after `app-v2026.10.1-…`. A directory
 * whose name carries no stamp is not one of ours and is left alone entirely —
 * this deletes hundreds of megabytes at a time and must only ever touch
 * directories it can positively identify.
 *
 * `protect` is how the caller keeps THIS update's rollback target whatever its
 * age, so `current.json`'s `previous` pointer can never dangle. Protected
 * entries count toward `keep` rather than adding to it: the normal call
 * protects the newest entry, and the point is to end up holding one payload.
 *
 * BEST-EFFORT. A payload that will not delete — an antivirus scanner holding a
 * handle, a stale supervisor pinning a file — is a disk-space problem, and
 * failing an update the user just completed successfully over one is the wrong
 * trade. Failures are collected and returned for the caller to mention.
 */
export function pruneBackups(root, { keep = BACKUP_KEEP, protect = [] } = {}) {
  const dir = join(root, "backups");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { removed: [], failed: [] }; // no backups dir yet — a first install
  }
  const found = entries
    .filter((entry) => entry.isDirectory() && BACKUP_NAME.test(entry.name))
    .map((entry) => ({
      path: resolve(dir, entry.name),
      at: Number(BACKUP_NAME.exec(entry.name)[1]),
    }))
    .sort((a, b) => b.at - a.at);

  // Protected entries are seeded FIRST and then the budget is filled from the
  // newest down, so protecting one consumes a slot instead of adding one. The
  // ordinary call protects the newest entry and both rules agree; they diverge
  // only when the rollback target is older than something else on disk, and
  // there "keep the target AND the newest" would hold two payloads forever —
  // which is the hoarding this exists to stop.
  const survivors = new Set(protect.map((path) => resolve(path)));
  for (const candidate of found) {
    if (survivors.size >= Math.max(0, keep)) break;
    survivors.add(candidate.path);
  }

  const removed = [];
  const failed = [];
  for (const candidate of found) {
    if (survivors.has(candidate.path)) continue;
    try {
      // Through `safeRemove`, so a caller that somehow passed a root outside the
      // install tree cannot turn this into a recursive delete of anything else.
      safeRemove(candidate.path, root);
      removed.push(candidate.path);
    } catch (error) {
      failed.push({ path: candidate.path, message: error.message });
    }
  }
  return { removed, failed };
}

function safeRemove(path, root) {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (!resolvedPath.startsWith(`${resolvedRoot}${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`refusing to remove a path outside the install root: ${path}`);
  }
  rmSync(resolvedPath, { recursive: true, force: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  assertNode();

  const root = desktopRoot(args.target);
  assertSafeRoot(root);
  console.log(
    `Resolving ${args.version || `the ${args.channel} channel head`} from ${args.repo}...`,
  );
  const selected = await resolveRelease(args.repo, args.version, args.channel);
  const filename = selected.archive.name;
  console.log(`release: ${selected.release.tag_name}`);
  console.log(`target : ${root}`);

  const scratch = join(tmpdir(), `dispatch-download-${randomUUID()}`);
  mkdirSync(scratch, { recursive: true });
  try {
    const checksumPath = join(scratch, "SHA256SUMS");
    await download(selected.checksums.browser_download_url, checksumPath);
    const checksumText = readFileSync(checksumPath, "utf8");
    const archivePath = join(scratch, filename);
    const actual = await download(selected.archive.browser_download_url, archivePath);
    const expected = checksumFor(checksumText, filename);
    if (actual !== expected) throw new Error(`checksum mismatch for ${filename}`);
    console.log(`verified: sha256 ${actual}`);
    inspectArchive(archivePath);
    if (args.dryRun) {
      console.log("dry run complete; the installed app was not changed.");
      return;
    }

    mkdirSync(root, { recursive: true });
    const stage = join(root, `.install-${process.pid}-${Date.now()}`);
    safeRemove(stage, root);
    mkdirSync(stage, { recursive: true });
    try {
      run("tar", ["-xzf", archivePath, "-C", stage]);
      // The archive deliberately has no node_modules yet. At this point verify
      // structure only; importing shared would turn a valid clean install into
      // a false failure because zod/yaml have not been installed.
      verifyPayload(stage, { importRuntime: false });
      const pnpm = pnpmCommand();
      console.log("installing runtime dependencies...");
      installDependencies(stage, pnpm);
      verifyPayload(stage);

      const python = findPython();
      const app = join(root, "app");
      const currentLauncher = join(app, "tools", "app", "launch.py");
      if (existsSync(currentLauncher)) {
        console.log("stopping the current Dispatch instance, if it is running...");
        launch(python, currentLauncher, ["--stop", "--target", root]);
      }

      const backup = join(root, "backups", `app-${selected.release.tag_name}-${Date.now()}`);
      const stampPath = join(root, "current.json");
      const previousStamp = existsSync(stampPath) ? readFileSync(stampPath) : null;
      let movedOld = false;
      let movedStage = false;
      try {
        if (existsSync(app)) {
          mkdirSync(dirname(backup), { recursive: true });
          // Antivirus and a just-exited supervisor can retain Windows handles
          // briefly after shutdown. Retrying the atomic rename avoids turning
          // that ordinary teardown lag into a failed update.
          await renameWithRetry(app, backup);
          movedOld = true;
        }
        await renameWithRetry(stage, app);
        movedStage = true;

        // pnpm's Windows junctions contain absolute paths. Re-run the cheap,
        // already-warm install after the rename so they point at app/, not stage/.
        installDependencies(app, pnpm);
        verifyPayload(app);

        const manifestPath = join(app, "release-manifest.json");
        const manifest = existsSync(manifestPath)
          ? JSON.parse(readFileSync(manifestPath, "utf8"))
          : { tag: selected.release.tag_name };
        writeFileSync(
          stampPath,
          JSON.stringify({
            version: manifest.version || selected.release.tag_name.replace(/^v/, ""),
            tag: selected.release.tag_name,
            sha: manifest.sha || selected.release.target_commitish,
            installedAt: new Date().toISOString(),
            source: `https://github.com/${args.repo}/releases/tag/${selected.release.tag_name}`,
            previous: movedOld ? backup : null,
          }, null, 2),
        );

        if (args.shortcut) {
          try {
            if (platform() === "win32") {
              run(process.execPath, [join(app, "tools", "app", "create-shortcut.mjs"), "--target", root], { cwd: app });
            } else {
              createPosixLauncher(root, python);
            }
          } catch (shortcutError) {
            console.warn(`warning: the app installed, but its launcher was not created: ${shortcutError.message}`);
          }
        }

        if (args.start) {
          const launcher = join(app, "tools", "app", "launch.py");
          launch(python, launcher, ["--no-window", "--target", root]);
          if (args.open) openBrowser("http://127.0.0.1:4318");
        }

        // The new payload is relinked, verified, stamped and (if asked) up, so
        // `backup` is the rollback target now and everything older is dead
        // weight. Pruning HERE rather than before the start is deliberate: the
        // catch below restores `backup` when the start fails, and that is the
        // one directory this is told to protect.
        const pruned = movedOld
          ? pruneBackups(root, { protect: [backup] })
          : { removed: [], failed: [] };

        console.log(`\nDispatch ${selected.release.tag_name} is installed.`);
        console.log(`  app   : ${app}`);
        console.log(`  data  : ${join(root, "data")}`);
        console.log(`  config: ${join(root, "config")}`);
        if (args.start) console.log("  open  : http://127.0.0.1:4318");
        if (pruned.removed.length) {
          console.log(`  pruned: ${pruned.removed.length} superseded backup payload(s)`);
        }
        for (const failure of pruned.failed) {
          console.warn(
            `warning: could not remove the old backup ${failure.path}: ${failure.message}`,
          );
        }
      } catch (error) {
        // Any failure after the swap (including dependency relinking and the
        // health-gated start) restores the previous directory and version stamp.
        if (movedOld && existsSync(backup)) {
          try {
            if (existsSync(app)) {
              const failedLauncher = join(app, "tools", "app", "launch.py");
              if (existsSync(failedLauncher)) {
                try { launch(python, failedLauncher, ["--stop", "--target", root]); } catch {}
              }
              const failed = join(root, "backups", `failed-${selected.release.tag_name}-${Date.now()}`);
              await renameWithRetry(app, failed);
            }
            await renameWithRetry(backup, app);
            if (previousStamp) writeFileSync(stampPath, previousStamp);
            else rmSync(stampPath, { force: true });
            if (args.start) {
              launch(python, join(app, "tools", "app", "launch.py"), ["--no-window", "--target", root]);
            }
          } catch (rollbackError) {
            throw new Error(`${error.message}\nrollback also failed: ${rollbackError.message}`);
          }
        } else if (!movedOld) {
          if (previousStamp) writeFileSync(stampPath, previousStamp);
          else rmSync(stampPath, { force: true });
          // If moving the existing app failed, it is still the good installed
          // payload. Do not mislabel it as a failed new release or mask the
          // original error with a second rename of the same locked directory.
          if (movedStage && existsSync(app)) {
            mkdirSync(join(root, "backups"), { recursive: true });
            await renameWithRetry(
              app,
              join(root, "backups", `failed-${selected.release.tag_name}-${Date.now()}`),
            );
          }
        }
        throw error;
      }
    } finally {
      if (existsSync(stage)) safeRemove(stage, root);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Is this module the process entry point, rather than an import from the tests?
 *
 * Compared through `realpathSync`, because the two sides are not the same kind
 * of path. `import.meta.url` is the entry point's REAL path — Node resolves the
 * main module's symlinks unless `--preserve-symlinks-main` — while
 * `process.argv[1]` is the path the caller typed. On macOS those differ for
 * every bootstrapped install: `install.sh` stages this file under `$TMPDIR`,
 * which is `/var/folders/…`, and `/var` is a symlink to `/private/var`. The
 * plain string compare that used to be here therefore never matched, `main()`
 * never ran, and `curl … | sh` printed "Downloading the Dispatch release
 * installer..." and exited 0 having installed nothing at all. The server's own
 * self-update stages into `tmpdir()` too, so it failed the same silent way, and
 * Windows has the same shape when TEMP is redirected through a junction. NOT
 * when TEMP is an 8.3 short path: Node expands short names on neither side, so
 * both stay short and the compare already held.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  const entry = resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return entry === self || realpathOrSelf(entry) === realpathOrSelf(self);
}

/** `realpathSync`, falling back to the input for a path that does not exist. */
function realpathOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    console.error(`\nDispatch install failed: ${error.message}`);
    process.exitCode = 1;
  });
}
