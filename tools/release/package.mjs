#!/usr/bin/env node
/** Assemble the minimal, platform-neutral payload published in a GitHub Release. */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") out.out = argv[++i];
    else if (arg === "--tag") out.tag = argv[++i];
    else if (arg === "--sha") out.sha = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.out || !out.tag || !out.sha) {
    throw new Error("usage: package.mjs --out <dir> --tag <vX.Y.Z> --sha <commit>");
  }
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(out.tag)) {
    throw new Error(`release tag must be semver-shaped (received ${out.tag})`);
  }
  if (!/^[a-f0-9]{40}$/i.test(out.sha)) throw new Error(`invalid commit sha: ${out.sha}`);
  return out;
}

const args = parseArgs(process.argv.slice(2));
const output = resolve(args.out);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const files = [
  "package.json",
  "pnpm-lock.yaml",
  "install.ps1",
  "install.sh",
  "packages/server/package.json",
  "packages/server/dist",
  "packages/server/skills",
  "packages/client/dist",
  "packages/shared/package.json",
  "packages/shared/dist",
  "packages/cli/package.json",
  "packages/cli/dist",
  "tools/app/create-shortcut.mjs",
  "tools/app/launch.py",
  "tools/app/paths.mjs",
  "tools/install.mjs",
];

for (const relative of files) {
  const source = join(repoRoot, relative);
  if (!existsSync(source)) throw new Error(`build output is missing: ${relative}`);
  const target = join(output, relative);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

// The release needs only the runtime workspaces. The prebuilt client is static
// data; excluding its package avoids installing React/Monaco on the end user's
// machine when the browser bundle already contains them.
writeFileSync(
  join(output, "pnpm-workspace.yaml"),
  `packages:\n  - 'packages/server'\n  - 'packages/shared'\n  - 'packages/cli'\nallowBuilds:\n  esbuild: true\n`,
);

const packageJsonPath = join(output, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
packageJson.version = args.tag.slice(1).split("+")[0];
packageJson.scripts = {
  start: "pnpm --filter @dispatch/server start",
  dispatch: "node packages/cli/dist/index.js",
  cm: "node packages/cli/dist/index.js",
  app: "python tools/app/launch.py",
  "app:stop": "python tools/app/launch.py --stop",
  "app:status": "python tools/app/launch.py --status",
  "app:shortcut": "node tools/app/create-shortcut.mjs",
};
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

writeFileSync(
  join(output, "release-manifest.json"),
  `${JSON.stringify({
    version: packageJson.version,
    tag: args.tag,
    sha: args.sha,
    builtAt: new Date().toISOString(),
  }, null, 2)}\n`,
);

console.log(`release payload: ${output}`);
