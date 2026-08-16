/**
 * Reading how far a running install has got.
 *
 * There is no progress API to call. `tools/install.mjs` writes exactly one
 * structured file (`current.json`) and it writes it at the very END, after the
 * swap has already succeeded; the `phase` field in `update.json` is a constant
 * `"launched"` stamped by `update-install.ts` before the spawn and never touched
 * again. The installer's only running commentary is prose on stdout, which
 * `launchUpdate` redirects into `<root>/update.log`.
 *
 * So this module tails that log and matches it against the installer's own
 * wording. That is a coupling worth being honest about: if `install.mjs` changes
 * a message, a phase here stops being recognised. It degrades safely — the
 * reported phase simply stops advancing, which reads as "still working" — and it
 * can never invent a `done` that did not happen, because `done` has its own
 * marker. The alternative (teaching the installer to emit structured progress)
 * cannot work for the case that matters most: `stageInstaller` downloads the
 * RELEASE's installer, so an in-app update usually runs a script older than this
 * code and newer than nothing we control.
 *
 * Everything is read from disk on every call, never cached. The process that
 * answers this is usually not the process that started the install — that one is
 * killed by the installer partway through — so in-memory state would be wiped at
 * exactly the moment the answer gets interesting.
 */
import { readFile, stat } from "node:fs/promises";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { UpdatePhase, UpdateProgress } from "@dispatch/shared";

/**
 * How much of the tail to read. The dependency install is thousands of lines of
 * pnpm output and the interesting part is always the end, so this is a window on
 * the end of the file rather than a whole-file read that grows without bound.
 */
const TAIL_BYTES = 96 * 1024;

/** Lines handed to the client. Enough to see what failed, not a log viewer. */
const TAIL_LINES = 300;

/**
 * Ordered markers, matched against each line of the installer's output.
 *
 * Order is significant twice over: the phase list is a ratchet (a later phase is
 * never walked back by an earlier marker appearing again), and `relinking` is
 * distinguished from `dependencies` ONLY by position — they are literally the
 * same `pnpm install` command echo, run once against the staged payload and
 * again against the swapped one. See the table in `install.mjs`: the second echo
 * is the only evidence in the whole log that the rename succeeded.
 */
const MARKERS: ReadonlyArray<{
  phase: UpdatePhase;
  match: (line: string) => boolean;
  /** This phase is only reachable once `after` has already been reached. */
  after?: UpdatePhase;
}> = [
  { phase: "resolving", match: (l) => l.startsWith("Resolving ") },
  // The download between here and `verified:` prints nothing at all — it is the
  // longest silent stretch of the install, and the reason this phase exists as
  // its own step rather than being folded into "resolving".
  { phase: "downloading", match: (l) => l.startsWith("release:") },
  { phase: "verifying", match: (l) => l.startsWith("verified: sha256 ") },
  { phase: "extracting", match: (l) => l.includes("$ tar -xzf") },
  { phase: "dependencies", match: (l) => l.startsWith("installing runtime dependencies") },
  { phase: "stopping", match: (l) => l.startsWith("stopping the current Dispatch instance") },
  // Guarded, and this guard is the whole reason `after` exists: the pre-swap and
  // post-swap dependency installs are the SAME command echo, so an unguarded
  // match jumps to `relinking` on the first one — skipping `stopping` and
  // claiming the swap has happened while the tarball is still being unpacked.
  { phase: "relinking", after: "stopping", match: (l) => /\$ .*pnpm(@[\w.]+)? install/.test(l) },
  { phase: "starting", match: (l) => l.startsWith("starting Dispatch on") || l.includes("launch.py --no-window") },
  { phase: "done", match: (l) => /^Dispatch .* is installed\.$/.test(l) },
];

/** Terminal phases: the installer has exited and nothing more will be written. */
const TERMINAL: ReadonlySet<UpdatePhase> = new Set<UpdatePhase>(["done", "failed"]);

/** The installer's single failure line (`install.mjs`, on stderr). */
const FAILURE_PREFIX = "Dispatch install failed:";

interface UpdateStamp {
  tag?: unknown;
  startedAt?: unknown;
  /** Byte length of `update.log` when this install was launched. */
  logOffset?: unknown;
}

/**
 * `update.log` is opened in APPEND mode and never rotated, so it holds every
 * install this machine has ever run. Reading it whole would report a previous
 * update's `failed` — or worse, its `done` — as this one's outcome. `logOffset`
 * is where this install's output starts; a stamp without one predates the field,
 * and reading from 0 is the old (wrong, but no worse than before) behaviour.
 */
async function readSince(path: string, offset: number): Promise<string> {
  const size = (await stat(path)).size;
  // A file SHORTER than the offset means it was rotated or replaced out from
  // under us; the offset is meaningless, so fall back to a plain tail.
  const start = size < offset ? Math.max(0, size - TAIL_BYTES) : Math.max(offset, size - TAIL_BYTES);
  const length = size - start;
  if (length <= 0) return "";

  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    // Sliced to what was ACTUALLY read. `length` came from a `stat` taken a
    // moment ago on a file an installer is actively writing; if it is truncated
    // or replaced in between, the tail of the buffer is still zero-fill, and
    // those NULs survive into the string as their own "lines" — junk in the log
    // the user is shown, and noise the phase matcher has to walk past.
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Walk the log once, ratcheting forward through `MARKERS`. */
function derivePhase(lines: readonly string[]): { phase: UpdatePhase; failure: string | null } {
  let index = -1;
  let failure: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(FAILURE_PREFIX)) {
      failure = line.slice(FAILURE_PREFIX.length).trim() || "the installer did not say why";
      continue;
    }
    // Backwards, so the FURTHEST legal phase this line proves wins: the
    // installer prints plenty of lines that are evidence of more than one step.
    for (let i = MARKERS.length - 1; i > index; i--) {
      const marker = MARKERS[i]!;
      if (marker.after !== undefined && index < MARKERS.findIndex((m) => m.phase === marker.after)) {
        continue;
      }
      if (marker.match(line)) {
        index = i;
        break;
      }
    }
  }

  // Failure outranks everything: the installer prints its error last, and a
  // rollback that got as far as `starting` is still a failed update.
  if (failure !== null) return { phase: "failed", failure };
  return { phase: index < 0 ? "launching" : MARKERS[index]!.phase, failure: null };
}

export interface ReadProgressOptions {
  /** Install root (`<root>`), the directory holding `app/`, `update.json`, `update.log`. */
  root: string;
  /** Include the log tail. False for an unauthenticated caller — it carries paths. */
  includeLog: boolean;
}

/**
 * The current install's progress, or an `idle` reading when no install has ever
 * been launched from this root.
 *
 * Never throws: this is polled by a screen whose entire job is to stay up while
 * the machine underneath it is being replaced, and an exception here would be
 * indistinguishable to that screen from the server being gone.
 */
export async function readUpdateProgress(opts: ReadProgressOptions): Promise<UpdateProgress> {
  const idle: UpdateProgress = {
    inFlight: false,
    phase: "idle",
    tag: null,
    startedAt: null,
    failure: null,
  };

  let stamp: UpdateStamp;
  try {
    stamp = JSON.parse(await readFile(join(opts.root, "update.json"), "utf8")) as UpdateStamp;
  } catch {
    return idle; // no install has ever run here, or the stamp is unreadable
  }

  const tag = typeof stamp.tag === "string" ? stamp.tag : null;
  const startedAt = typeof stamp.startedAt === "string" ? stamp.startedAt : null;
  const offset = typeof stamp.logOffset === "number" && stamp.logOffset >= 0 ? stamp.logOffset : 0;

  let text = "";
  try {
    text = await readSince(join(opts.root, "update.log"), offset);
  } catch {
    // Stamp but no log: the installer was spawned and has not written yet, which
    // is a real (brief) state, not an error.
  }

  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const { phase, failure } = derivePhase(lines);

  return {
    inFlight: !TERMINAL.has(phase),
    phase,
    tag,
    startedAt,
    failure,
    ...(opts.includeLog ? { log: lines.slice(-TAIL_LINES) } : {}),
  };
}
