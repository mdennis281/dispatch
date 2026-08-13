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
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_REPO = "mdennis281/dispatch";
const PNPM_VERSION = "11.5.0";
const MIN_NODE_MAJOR = 20;
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

  --version <tag>     install a release tag instead of the latest release
  --repo <owner/name> release repository (default: ${DEFAULT_REPO})
  --target <path>     installation root (default: the platform user-data dir)
  --no-start          install without starting Dispatch
  --no-shortcut       do not create a Start-menu/PATH launcher
  --dry-run           resolve and verify the release without changing the install
  --help              show this help

Set GITHUB_TOKEN for private repositories or to avoid anonymous API limits.
Rerun the same command later to update to the newest release.`);
}

function parseArgs(argv) {
  const out = {
    repo: process.env.DISPATCH_INSTALL_REPO || DEFAULT_REPO,
    start: true,
    shortcut: true,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--no-start") out.start = false;
    else if (arg === "--no-shortcut") out.shortcut = false;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--version") out.version = requiredValue(argv, ++i, arg);
    else if (arg === "--repo") out.repo = requiredValue(argv, ++i, arg);
    else if (arg === "--target") out.target = requiredValue(argv, ++i, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(out.repo)) {
    throw new Error(`--repo must be an owner/name pair (received ${JSON.stringify(out.repo)})`);
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

function desktopRoot(override) {
  if (override) return resolve(override);
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

async function resolveRelease(repo, requestedVersion) {
  const tag = requestedVersion
    ? requestedVersion.startsWith("v")
      ? requestedVersion
      : `v${requestedVersion}`
    : null;
  const endpoint = tag
    ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  const release = await (await fetchOk(endpoint)).json();
  if (release.draft || release.prerelease) {
    throw new Error(`refusing draft/prerelease ${release.tag_name}`);
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

function inspectArchive(path) {
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
}

function run(command, args, options = {}) {
  if (!options.quiet) console.log(`  $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: process.env,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
    shell: platform() === "win32" && /^(pnpm|npx|corepack)$/.test(command),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.quiet ? `\n${result.stderr || result.stdout || ""}` : "";
    throw new Error(`${command} exited ${result.status}${detail}`);
  }
  return String(result.stdout || "").trim();
}

function commandWorks(command, prefix = []) {
  try {
    run(command, [...prefix, "--version"], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

function pnpmCommand() {
  if (commandWorks("pnpm")) return { command: "pnpm", prefix: [] };
  if (commandWorks("corepack", ["pnpm"])) return { command: "corepack", prefix: ["pnpm"] };
  if (commandWorks("npx", ["--yes", `pnpm@${PNPM_VERSION}`])) {
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

function verifyPayload(payload) {
  const missing = REQUIRED_PAYLOAD.filter((path) => !existsSync(join(payload, path)));
  if (missing.length) throw new Error(`release payload is incomplete:\n  ${missing.join("\n  ")}`);
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
    if (commandWorks(command, [...prefix, "-c", "import sys; print(sys.version_info[:2])"])) {
      return { command, prefix };
    }
  }
  throw new Error("Python 3 is required by the Dispatch launcher but was not found on PATH");
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
      const result = spawnSync(command, args, { stdio: "ignore" });
      if (result.status === 0) return;
    } catch {
      // The URL printed below is the dependable fallback on headless machines.
    }
  }
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
  console.log(`Resolving ${args.version || "the latest release"} from ${args.repo}...`);
  const selected = await resolveRelease(args.repo, args.version);
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
      verifyPayload(stage);
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
      try {
        if (existsSync(app)) {
          mkdirSync(dirname(backup), { recursive: true });
          renameSync(app, backup);
          movedOld = true;
        }
        renameSync(stage, app);

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
          openBrowser("http://127.0.0.1:4318");
        }

        console.log(`\nDispatch ${selected.release.tag_name} is installed.`);
        console.log(`  app   : ${app}`);
        console.log(`  data  : ${join(root, "data")}`);
        console.log(`  config: ${join(root, "config")}`);
        if (args.start) console.log("  open  : http://127.0.0.1:4318");
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
              renameSync(app, failed);
            }
            renameSync(backup, app);
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
          if (existsSync(app)) {
            mkdirSync(join(root, "backups"), { recursive: true });
            renameSync(
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

main().catch((error) => {
  console.error(`\nDispatch install failed: ${error.message}`);
  process.exitCode = 1;
});
