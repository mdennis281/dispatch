/**
 * Trim `importers:` in a pnpm-lock.yaml down to the workspaces a release ships.
 *
 * The release payload drops `packages/client` from pnpm-workspace.yaml (its
 * prebuilt bundle is static data), but used to ship the source lockfile as-is.
 * pnpm ≤12.6 tolerated the stale importer; 12.9+ fails a --frozen-lockfile
 * install with ERR_PNPM_OUTDATED_LOCKFILE ("the lockfile records
 * importers["packages/client"], but that project's directory has no
 * package.json"), which broke every install that resolved pnpm through
 * corepack (#333).
 *
 * Only importers are removed. Entries under `packages:`/`snapshots:` that only
 * the client used are left behind: re-resolving them would need network and
 * could move versions, and a frozen install ignores unreferenced entries.
 */
export function pruneLockfileImporters(lockfile, keep) {
  const kept = new Set([".", ...keep]);
  const lines = lockfile.split(/(?<=\n)/);
  const start = lines.findIndex((line) => /^importers:\s*$/.test(line));
  if (start === -1) throw new Error("pnpm-lock.yaml has no importers section");

  const out = lines.slice(0, start + 1);
  const seen = new Set();
  let dropping = false;
  let index = start + 1;
  for (; index < lines.length; index++) {
    const line = lines[index];
    // The next top-level key ends the importers section.
    if (/^\S/.test(line)) break;
    // An importer with no dependencies is written inline: `  packages/x: {}`.
    const key = /^ {2}(['"]?)([^'"\s][^'":]*)\1:(?:\s|$)/.exec(line);
    if (key) {
      dropping = !kept.has(key[2]);
      if (!dropping) seen.add(key[2]);
    }
    if (!dropping) out.push(line);
  }

  const missing = [...kept].filter((importer) => !seen.has(importer));
  if (missing.length > 0) {
    throw new Error(`pnpm-lock.yaml has no importer for ${missing.join(", ")}`);
  }
  return out.concat(lines.slice(index)).join("");
}
