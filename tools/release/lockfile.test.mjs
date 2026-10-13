import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { pruneLockfileImporters } from "./lockfile.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtime = ["packages/server", "packages/shared", "packages/cli"];

const lockfile = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      typescript:
        specifier: ^5.7.2
        version: 5.9.3

  packages/cli:
    dependencies:
      '@dispatch/shared':
        specifier: workspace:*
        version: link:../shared

  packages/client:
    dependencies:
      react:
        specifier: ^19.0.0
        version: 19.0.0

  'packages/server':
    dependencies: {}

  packages/shared: {}

packages:

  react@19.0.0:
    resolution: {integrity: sha512-x}
`;

function importerKeys(text) {
  const section = text.split(/^importers:\s*$/m)[1].split(/^\S/m)[0];
  return [...section.matchAll(/^ {2}['"]?([^'"\s:][^'":]*)['"]?:/gm)].map((m) => m[1]);
}

test("drops importers the release workspace does not ship", () => {
  const pruned = pruneLockfileImporters(lockfile, runtime);
  assert.deepEqual(importerKeys(pruned), [".", "packages/cli", "packages/server", "packages/shared"]);
  assert.doesNotMatch(pruned, /packages\/client/);
  // Everything outside importers is untouched.
  assert.ok(pruned.endsWith(lockfile.slice(lockfile.indexOf("\npackages:\n"))));
});

test("handles CRLF lockfiles from a Windows checkout", () => {
  const pruned = pruneLockfileImporters(lockfile.replace(/\n/g, "\r\n"), runtime);
  assert.equal(pruned, pruneLockfileImporters(lockfile, runtime).replace(/\n/g, "\r\n"));
});

test("refuses a lockfile missing a shipped workspace", () => {
  assert.throws(
    () => pruneLockfileImporters(lockfile, [...runtime, "packages/extra"]),
    /no importer for packages\/extra/,
  );
  assert.throws(() => pruneLockfileImporters("lockfileVersion: '9.0'\n", runtime), /no importers/);
});

test("the real lockfile prunes to exactly the release workspaces", () => {
  const source = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
  assert.ok(importerKeys(source).includes("packages/client"));
  assert.deepEqual(importerKeys(pruneLockfileImporters(source, runtime)).sort(), [".", ...runtime].sort());
});
