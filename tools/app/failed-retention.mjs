/**
 * Retention for `<root>/failed/` — the payloads upgrade.mjs moves aside when a
 * new build fails its health check.
 *
 * Keeping the one that broke is right: it is the only copy of the thing that
 * failed, and "why did the upgrade roll back" is unanswerable without it. But
 * nothing ever deleted one, and each is a full payload with node_modules —
 * 1.2 GB had piled up from two bad days in August before anyone looked.
 *
 * So: the NEWEST failed payload is kept, because it is the one anybody is still
 * diagnosing; every older one goes; and the newest goes too once it is
 * {@link FAILED_PAYLOAD_MAX_AGE_MS} old, because by then nobody is.
 *
 * `staging/` and `backups/` are not touched — each holds exactly one generation
 * by design, and both are load-bearing for the next upgrade or a recovery.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const FAILED_PAYLOAD_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

/**
 * When a payload was moved into `failed/`, from the ISO stamp upgrade.mjs puts
 * at the end of its name (`app-<sha>-2026-08-09T14-03-11-220Z`). Null when the
 * name carries none.
 */
export function failedAtFromName(name) {
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name);
  if (!m) return null;
  const at = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(at) ? at : null;
}

/**
 * Delete stale failed payloads under `failedDir`. Returns the paths removed.
 *
 * Age comes from the name's stamp — the moment of the failure. The directory's
 * mtime is only the fallback for a payload someone moved there by hand: a
 * rename does not update it, so it dates the build's staging, not its failure.
 *
 * Never throws: pruning is housekeeping, and an upgrade must not fail because a
 * locked file kept an old payload alive. What would not delete is reported
 * through `log` and simply retried by the next upgrade.
 */
export function pruneFailedPayloads(failedDir, { now = Date.now(), log = () => {} } = {}) {
  let entries;
  try {
    entries = readdirSync(failedDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const payloads = entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const path = join(failedDir, e.name);
      const stamped = failedAtFromName(e.name);
      if (stamped !== null) return { path, at: stamped };
      try {
        return { path, at: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);

  const removed = [];
  payloads.forEach((p, i) => {
    const newest = i === 0;
    if (newest && now - p.at < FAILED_PAYLOAD_MAX_AGE_MS) return;
    try {
      // Safe across pnpm's node_modules junctions: Node's recursive rm unlinks a
      // Windows junction rather than descending through it (see upgrade.mjs).
      rmSync(p.path, { recursive: true, force: true, maxRetries: 3 });
      removed.push(p.path);
      log(`removed failed payload ${p.path}\n`);
    } catch (err) {
      log(`could not remove failed payload ${p.path}: ${err?.message ?? err}\n`);
    }
  });
  return removed;
}
