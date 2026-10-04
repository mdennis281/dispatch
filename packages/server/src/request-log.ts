/**
 * A record of the API requests that FAILED or crawled, written somewhere a
 * human can read it afterwards.
 *
 * WHY. The server runs Fastify with `logger: false`, and nothing else records a
 * route's outcome. So a handler that throws returns a 500 to the browser and
 * leaves no trace anywhere: `crash.log` only sees process-level faults (the
 * request never reaches it — Fastify catches the rejection and replies), and
 * `perf.log` only sees loop stalls, which say the box was busy without ever
 * naming what broke because of it.
 *
 * That blind spot is how the empty-transcript bug stayed unexplained. Opening a
 * chat on a loaded machine rendered "No messages yet" because the one
 * `GET /api/chats/:id/messages` behind it failed — a transient Windows lock on
 * `messages.jsonl` throwing out of a read that only expected ENOENT. From the
 * outside it was indistinguishable from a chat that genuinely had no messages,
 * and there was no log to say otherwise. The read now retries (see
 * `store/fsq.ts`), but the general lesson is the one worth keeping: a failure
 * nothing writes down is a failure nobody can fix.
 *
 * Output: `<dataDir>/requests.log`, one line per 5xx and per request slower
 * than {@link SLOW_REQUEST_MS}. Rotated past {@link REQUEST_LOG_MAX_BYTES}.
 * A healthy server writes nothing at all, so an idle instance never grows the
 * file — the same bargain `perf.log` makes, and for the same reason: a
 * diagnostic that costs disk when there is nothing wrong gets turned off.
 */
import { appendFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * A request slower than this is logged even when it succeeded.
 *
 * Set against the stalls actually observed on a busy box — `perf.log` on the
 * author's machine records single loop stalls of 3.7–5.1 s — so this catches
 * the requests that sat behind one while staying clear of the merely
 * unremarkable. A slow 200 matters here: the symptoms this file exists for
 * (a transcript that never arrives, a chat that goes quiet) look identical
 * whether the request failed or simply never came back in time.
 */
export const SLOW_REQUEST_MS = 2_000;
/** Rotate past this, keeping one generation as `requests.log.1`. */
export const REQUEST_LOG_MAX_BYTES = 1024 * 1024;
export const REQUEST_LOG_NAME = "requests.log";

/**
 * Routes that are SUPPOSED to take a long time, exempt from the slow-request
 * rule (never from the 5xx rule).
 *
 * `/api/metrics/growth` streams NDJSON frames for the seconds-to-minutes a long
 * history takes to walk — that is the feature, not a fault. Without this every
 * growth walk would file itself as a problem and train the reader to skim.
 */
const SLOW_EXEMPT = ["/api/metrics/growth"];

/** What {@link registerRequestLog} installs: a writer bound to one app. */
interface RequestLog {
  write(line: string): void;
  /** Resolves once every append issued so far has landed. */
  flush(): Promise<void>;
}

async function rotateIfLarge(file: string): Promise<void> {
  try {
    const { size } = await stat(file);
    if (size > REQUEST_LOG_MAX_BYTES) await rename(file, `${file}.1`);
  } catch {
    /* absent, or a rotation race — either way the append below still works */
  }
}

/**
 * A writer for one app instance.
 *
 * Per-app rather than module-global (which is how `perf.ts` does it, for the
 * good reason that there must only ever be ONE event-loop histogram per
 * process). A log destination has the opposite requirement: the tests build
 * dozens of apps on dozens of temp data dirs in a single process, and a global
 * would point every one of them at whichever dir was configured last.
 *
 * The flush seam matters more than it looks. These appends are deliberately
 * fire-and-forget, so without it a write can land AFTER the app it describes is
 * gone — which in the tests meant a `requests.log` materialising inside a temp
 * store that had just been deleted, failing the teardown with ENOTEMPTY. The
 * `onClose` hook below waits for them.
 */
function createRequestLog(dataDir: string | undefined): RequestLog {
  const file = dataDir ? join(dataDir, REQUEST_LOG_NAME) : null;
  /** Serialises appends so a rotation never interleaves with a write. */
  let writing: Promise<void> = Promise.resolve();
  return {
    write(line) {
      if (!file) return;
      // Best-effort in the strongest sense: a full disk, a locked file or a
      // vanished data dir must never turn the server's own diagnostics into an
      // outage. The same bargain `perf.log` makes.
      writing = writing
        .then(() => rotateIfLarge(file))
        .then(() => appendFile(file, line + "\n", "utf8"))
        .catch(() => undefined);
    },
    flush: () => writing,
  };
}

/**
 * The query string, with values redacted.
 *
 * Keys are the diagnostic value — knowing a transcript read carried `beforeId`
 * says which paging call failed — while the values are chat ids, search terms
 * and file paths, which is user content this file has no business keeping.
 */
function redactedQuery(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return "";
  const keys = [...new URLSearchParams(url.slice(q + 1)).keys()];
  return keys.length ? `?${keys.join("&")}` : "";
}

/** `GET /api/chats/:id/messages` — the ROUTE, never the interpolated id. */
function routeOf(method: string, routeUrl: string | undefined, url: string): string {
  // `routerPath` is the registered pattern (ids still as `:id`), which is what
  // makes these lines groupable. It is absent for a 404, where the raw path is
  // all there is — and is exactly what you want to see.
  return `${method} ${routeUrl ?? url.split("?")[0]}${redactedQuery(url)}`;
}

function stamp(): string {
  return `[${new Date().toISOString()}]`;
}

/**
 * `EPERM: operation not permitted, open '…'` — the errno once, not twice.
 *
 * Node's errno messages already BEGIN with the code, so prefixing unconditionally
 * produced `EPERM: EPERM: operation not permitted`. Still prefix the ones that
 * don't (a plain `Error`, where the name is the only classification there is).
 */
function describe(err: Error): string {
  const code = (err as NodeJS.ErrnoException).code ?? err.name;
  return err.message.startsWith(code) ? err.message : `${code}: ${err.message}`;
}

/**
 * Record this app's failed and slow requests to `<dataDir>/requests.log`.
 *
 * Omit `dataDir` (the tests) to install the hooks without writing anything.
 * Returns the writer so a test can await its {@link RequestLog.flush}.
 */
export function registerRequestLog(
  app: FastifyInstance,
  opts: { dataDir?: string } = {},
): RequestLog {
  const log = createRequestLog(opts.dataDir);

  // Appends are fire-and-forget, so shutdown has to wait for the ones still in
  // flight — otherwise a line lands in a data dir that is already being deleted.
  // Harmless in production, fatal in the tests, where teardown `rm`s the temp
  // store and got ENOTEMPTY for its trouble.
  app.addHook("onClose", async () => {
    await log.flush();
  });

  // The error as THROWN, with its stack. `onResponse` sees only the status
  // code, and "500" without the stack is barely more useful than silence — it
  // is the difference between knowing a transcript read failed and knowing it
  // failed on EBUSY opening `messages.jsonl`.
  app.addHook("onError", async (req, _reply, err) => {
    // ASCII only, including the separator. This file is read with whatever the
    // operator's console defaults to — `Get-Content` on Windows PowerShell is
    // not UTF-8 — and an em-dash came back as mojibake in the middle of the one
    // line you are squinting at.
    log.write(
      `${stamp()} error ${routeOf(req.method, req.routeOptions?.url, req.url)} - ` +
        `${describe(err)}\n` +
        `    ${(err.stack ?? "").split("\n").slice(1).join("\n    ").trimEnd()}`,
    );
  });

  // Outcomes. A 5xx that was REPLIED rather than thrown (`reply.code(500).send`)
  // never reaches `onError`, so this is not redundant with the hook above — and
  // a slow success reaches neither any other way.
  app.addHook("onResponse", async (req, reply) => {
    const ms = Math.round(reply.elapsedTime);
    const slow = ms >= SLOW_REQUEST_MS && !SLOW_EXEMPT.some((p) => req.url.startsWith(p));
    if (reply.statusCode < 500 && !slow) return;
    const what = reply.statusCode >= 500 ? "failed" : "slow";
    log.write(
      `${stamp()} ${what} ${reply.statusCode} ${ms}ms ` +
        routeOf(req.method, req.routeOptions?.url, req.url),
    );
  });

  return log;
}
