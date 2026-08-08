/**
 * `GET /api/health` — the readiness probe an automated upgrade bets on.
 *
 * This used to answer a flat `{ ok: true }`, which is a LIVENESS probe: it
 * proves a process is listening and nothing more. That is not enough for
 * `tools/app/upgrade.mjs`, which swaps the payload under a live deployment and
 * has to decide — unattended, with the old build already moved aside — whether
 * to keep the new one or roll back. Three ways a swapped-in payload answers on
 * the port while being broken, all of which a liveness probe calls green:
 *
 *   - the SPA never got built, so the API answers and every browser tab 404s
 *     (exactly the failure `publish.mjs`'s `verifyPayload` exists to catch),
 *   - the state/config root is unreadable or holds data this build's schemas
 *     reject, so the app boots and then throws on first use, or
 *   - the swap half-applied and the port is being answered by the OLD server
 *     that never actually died.
 *
 * So the report carries what's needed to tell those apart: `ok` folds in a real
 * store read and the SPA's presence, and `sha` + `pid` + `startedAt` let the
 * caller prove it is talking to the process it just started rather than a
 * survivor of the one it tried to stop.
 *
 * Kept cheap enough to poll every 500ms: a couple of stats and one small JSON
 * read. Nothing here walks a directory or touches a transcript.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Store } from "./store/index.js";

/** Millisecond epoch this process finished loading — the process's identity in time. */
const STARTED_AT = Date.now();

const here = dirname(fileURLToPath(import.meta.url));

export interface HealthReport {
  /** Overall verdict: liveness AND readiness. False means "do not keep this build". */
  ok: boolean;
  /** `ok` when everything passed, else `degraded` with `problems` populated. */
  status: "ok" | "degraded";
  /** Commit the running payload was built from, when it can be determined. */
  sha?: string;
  /** OS pid — proves which process answered. */
  pid: number;
  /** When this process came up (ms epoch) — distinguishes a restart from a survivor. */
  startedAt: number;
  /** Milliseconds this process has been up. */
  uptimeMs: number;
  /** State root in use (chats, checkpoints, runners). */
  dataDir: string;
  /** Config root in use — equals `dataDir` in the single-root layout. */
  configDir: string;
  /** Whether the built SPA shell is on disk and servable. Always true in dev. */
  spa: boolean;
  /** Whether both roots are readable AND a real read against the store succeeded. */
  store: boolean;
  /** Human-readable reasons `ok` is false. Empty when healthy. */
  problems: string[];
}

/**
 * The payload's commit, resolved once and cached.
 *
 * The installed payload is a real git clone (see `tools/app/publish.mjs`), so
 * `git rev-parse HEAD` is the honest answer to "which code is this". Best
 * effort throughout: a payload without git, or a `git` missing from PATH,
 * degrades to `undefined` rather than failing the probe — a build with no
 * resolvable sha is unusual, not unhealthy.
 */
let cachedSha: string | null | undefined;
function payloadSha(): string | undefined {
  // Three states, not two: `undefined` is "not looked up yet", `null` is
  // "looked up, and there is no answer". Collapsing them would fork a `git`
  // process on every poll of a payload that has no sha to give — and the
  // upgrade gate polls this endpoint every 750ms for up to two minutes.
  if (cachedSha === undefined) {
    try {
      const out = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: here,
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      // An empty stdout is an exit-0 non-answer; it must cache as "no answer"
      // rather than as the string "", which is neither a sha nor a sentinel.
      cachedSha = out === "" ? null : out;
    } catch {
      cachedSha = null;
    }
  }
  return cachedSha ?? undefined;
}

/**
 * Is `dir` there and readable by this process? One syscall, no directory walk.
 *
 * `existsSync` would answer the first half only; `accessSync` also catches the
 * root that exists but this process cannot open (a permission change, a
 * dismounted network path that left its mountpoint behind).
 */
function readable(dir: string): boolean {
  try {
    accessSync(dir, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export interface HealthDeps {
  store: Store;
  dataDir: string;
  configDir?: string;
  /** Dev mode serves the SPA from Vite middleware, so there is no dist to check. */
  dev?: boolean;
  /** Where the built SPA lives; defaults to the same path `buildApp` serves. */
  clientDist?: string;
}

/** Build the health report. Never throws — a probe that 500s tells you nothing. */
export async function healthReport(deps: HealthDeps): Promise<HealthReport> {
  const problems: string[] = [];
  const configDir = deps.configDir ?? deps.dataDir;

  // The roots themselves, checked BEFORE anything reads through them. The store
  // read below cannot stand in for this on either count:
  //
  //   - `readJson` returns undefined for a missing FILE and for a missing
  //     DIRECTORY alike, so `getSettings()` hands back defaults — and reports
  //     healthy — for a payload aimed at a data root that never got mounted.
  //   - in the split-root layout `getSettings()` only ever touches `configDir`.
  //     `dataDir`, which holds every chat, checkpoint and runner, is not on its
  //     path at all, and that layout is exactly the one the desktop install and
  //     `upgrade.mjs` run.
  //
  // Deduped when the two roots are one, so the single-root layout reports a
  // single problem rather than the same directory twice.
  const roots: ReadonlyArray<readonly [string, string]> =
    configDir === deps.dataDir
      ? [["data dir", deps.dataDir]]
      : [
          ["data dir", deps.dataDir],
          ["config dir", configDir],
        ];
  const missingRoots = roots.filter(([, dir]) => !readable(dir));
  for (const [label, dir] of missingRoots) problems.push(`${label} unreadable: ${dir}`);

  // A real read, not a stat: this proves the config root's CONTENTS still
  // satisfy this build's schemas. A payload whose schemas reject the data it
  // was pointed at is precisely the upgrade we want rolled back, and it is
  // invisible to any check that only stats the directory. Skipped when a root
  // is already gone — that read would only restate a problem already reported.
  let store = false;
  if (missingRoots.length === 0) {
    try {
      await deps.store.getSettings();
      store = true;
    } catch (err) {
      problems.push(`store unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // In dev the SPA comes from Vite in-process, so there is nothing on disk to
  // find and its absence means nothing.
  const clientDist = deps.clientDist ?? resolve(here, "../../client/dist");
  const spa = deps.dev === true || existsSync(join(clientDist, "index.html"));
  if (!spa) problems.push(`SPA shell missing: ${join(clientDist, "index.html")}`);

  // Every I/O touch above is individually guarded, so assembling the report is
  // pure field access and this function has no throwing path left — which is
  // the contract `upgrade.mjs` needs: a probe that 500s reads as "degraded, no
  // reason given" and burns the whole health timeout before rolling back.
  const sha = payloadSha();
  return {
    ok: problems.length === 0,
    status: problems.length === 0 ? "ok" : "degraded",
    ...(sha ? { sha } : {}),
    pid: process.pid,
    startedAt: STARTED_AT,
    uptimeMs: Date.now() - STARTED_AT,
    dataDir: deps.dataDir,
    configDir,
    spa,
    store,
    problems,
  };
}
