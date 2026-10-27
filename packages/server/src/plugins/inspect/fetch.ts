/**
 * Fetch a plugin's files at ONE commit into a scratch directory, bounded.
 *
 * Ref → sha is `git ls-remote --symref`: one round trip, any https git host,
 * no API rate limit (the GitHub REST API allows 60 unauthenticated calls an
 * hour per IP, which a few inspects of a slashed branch name would spend),
 * and it returns every ref at once, which is what splitting
 * `/tree/feat/x/plugins/a` into ref + subdir needs.
 *
 * The files themselves:
 *
 *   GitHub  — `codeload.github.com/<o>/<r>/tar.gz/<sha>`, streamed through a
 *             byte counter, gunzip and the confined tar reader in `tar.ts`.
 *             Chosen over the shallow clone `dispatch plugin add` does because the
 *             caps hold WHILE bytes arrive (a clone can only be measured after
 *             it has landed), because it addresses an exact sha (a
 *             `--depth 1` clone takes a branch tip, which may have moved since
 *             the owner read the report), and because nothing of git's — config,
 *             filters, hooks, LFS — touches the content.
 *   other   — `git fetch --depth 1 <url> <sha>` into a bare scratch repo, then
 *             `git archive <sha>` piped into the same tar reader. The fetch
 *             itself is bounded by the timeout only; the caps apply to what is
 *             extracted.
 *
 * Every git call runs with prompts and credential helpers OFF: a private or
 * mistyped repository must fail fast with an error, not park the server
 * behind a credential-manager window on the host's desktop.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { normaliseCollectionPath } from "@dispatch/shared";
import { extractTar, unsafeEntryName, type TarCaps, type TarExtractResult } from "./tar.js";
import {
  PluginInspectError,
  browseUrl,
  parseLsRemote,
  parsePluginUrl,
  resolvePluginRef,
  type ParsedPluginUrl,
  type RemoteRefs,
  type ResolvedRef,
} from "./url.js";

export interface FetchLimits extends TarCaps {
  /** Compressed bytes accepted from the network (GitHub tarball). */
  maxDownloadBytes: number;
  /** Decompressed tar bytes read — a gzip bomb stops here. */
  maxArchiveBytes: number;
  /** Whole fetch, ref resolution included. */
  timeoutMs: number;
}

/**
 * Sized for a plugin, not a project: the four examples are a few dozen KB
 * each. The archive limits are larger because a plugin in a SUBDIRECTORY of a
 * monorepo arrives inside the whole repository's tarball — Dispatch's own
 * examples are such a case — and only the subdirectory is kept.
 */
export const DEFAULT_FETCH_LIMITS: FetchLimits = {
  maxFiles: 2000,
  maxBytes: 25 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxDownloadBytes: 100 * 1024 * 1024,
  maxArchiveBytes: 400 * 1024 * 1024,
  timeoutMs: 60_000,
};

/** Seams the tests replace so CI never touches the network. */
export interface FetchDeps {
  /** `git ls-remote --symref <url>` stdout. */
  lsRemote: (cloneUrl: string, signal: AbortSignal) => Promise<string>;
  /** A gzip'd tarball of the commit, for GitHub. */
  githubTarball: (owner: string, repo: string, sha: string, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;
  /** An uncompressed tar of the commit, for any other host (`git fetch` + `git archive`). */
  gitArchive: (cloneUrl: string, sha: string, scratch: string, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;
}

export interface FetchedPlugin {
  parsed: ParsedPluginUrl;
  ref: string;
  refKind: ResolvedRef["refKind"];
  sha: string;
  subdir: string;
  browseUrl?: string;
  /** Scratch root — the caller removes it. */
  scratch: string;
  /** Where the plugin's files are (`<scratch>/plugin`). */
  dir: string;
  extract: TarExtractResult;
}

/* -------------------------------------------------------------- git seam */

/** Env for every git child: no prompts, no GUI credential manager. */
function quietGitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "" };
}
/** `-c` flags that switch credential helpers off for one invocation. */
const QUIET_GIT = ["-c", "credential.helper=", "-c", "core.askPass="];

function gitOutput(args: string[], signal: AbortSignal, maxBytes = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [...QUIET_GIT, ...args], { env: quietGitEnv(), stdio: ["ignore", "pipe", "pipe"], signal });
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) {
        child.kill();
        reject(new PluginInspectError("the remote returned too many refs", 413));
        return;
      }
      out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) =>
      reject(signal.aborted ? new PluginInspectError("timed out talking to the git remote", 504) : new PluginInspectError(`could not run git: ${e.message}`, 502)),
    );
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(out).toString("utf8"));
      else reject(new PluginInspectError(gitFailure(err), 502));
    });
  });
}

/** The one line of git's stderr worth showing, with the not-found case named. */
function gitFailure(stderr: string): string {
  const text = stderr.trim();
  if (/could not read Username|Authentication failed|terminal prompts disabled|not found|does not exist/i.test(text)) {
    return "repository not found, or it is private — only public repositories can be inspected";
  }
  return `git failed: ${text.split(/\r?\n/).filter(Boolean).pop() ?? "unknown error"}`;
}

export const realFetchDeps: FetchDeps = {
  lsRemote: (cloneUrl, signal) => gitOutput(["ls-remote", "--symref", "--", cloneUrl], signal),

  async githubTarball(owner, repo, sha, signal) {
    let res: Response;
    try {
      res = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`, { signal, redirect: "follow" });
    } catch (err) {
      if (signal.aborted) throw new PluginInspectError("timed out downloading from GitHub", 504);
      throw new PluginInspectError(`could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`, 502);
    }
    if (res.status === 404) throw new PluginInspectError(`commit ${sha.slice(0, 7)} was not found in ${owner}/${repo}`, 404);
    if (!res.ok || !res.body) throw new PluginInspectError(`GitHub answered ${res.status} for the tarball`, 502);
    return Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  },

  async gitArchive(cloneUrl, sha, scratch, signal) {
    const repo = join(scratch, "repo.git");
    await gitOutput(["init", "--bare", "--quiet", repo], signal);
    // A sha in the want-list needs `uploadpack.allowReachableSHA1InWant`
    // server-side; GitHub, GitLab and Gitea all enable it.
    await gitOutput(["-C", repo, "fetch", "--depth", "1", "--no-tags", "--quiet", "--", cloneUrl, sha], signal);
    const child = spawn("git", [...QUIET_GIT, "-C", repo, "archive", "--format=tar", sha], {
      env: quietGitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      signal,
    });
    child.on("error", () => {});
    return child.stdout;
  },
};

/* ------------------------------------------------------------- the fetch */

/** `git ls-remote --symref` of the URL's repository, parsed; failures mapped to a status. */
export async function listRefs(parsed: ParsedPluginUrl, deps: FetchDeps, signal: AbortSignal): Promise<RemoteRefs> {
  try {
    return parseLsRemote(await deps.lsRemote(parsed.cloneUrl, signal));
  } catch (err) {
    if (err instanceof PluginInspectError) throw err;
    throw new PluginInspectError(`could not list refs of ${parsed.repo}: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
}

/** Count bytes through an async iterable and stop at `max`. */
async function* bounded(src: AsyncIterable<Uint8Array>, max: number, what: string): AsyncIterable<Buffer> {
  let n = 0;
  for await (const chunk of src) {
    n += chunk.length;
    if (n > max) throw new PluginInspectError(`${what} exceeded ${max} bytes`, 413);
    yield Buffer.from(chunk);
  }
}

/**
 * Pull `subdir` of the repository at `sha` into `dest`, through the confined
 * tar reader. Every pass (plugin, collection, collection refetch) on either
 * host comes through here, so none of them can skip the sha check below.
 */
async function extractCommit(
  parsed: ParsedPluginUrl,
  sha: string,
  scratch: string,
  dest: string,
  pick: { subdir: string; include?: string[]; soft?: boolean },
  limits: FetchLimits,
  deps: FetchDeps,
  signal: AbortSignal,
): Promise<TarExtractResult> {
  let tar: AsyncIterable<Buffer>;
  let strip: number;
  if (parsed.host === "github") {
    const gz = await deps.githubTarball(parsed.owner!, parsed.name!, sha, signal);
    const gunzip = createGunzip();
    // `pipeline`, not `pipe`: a download error (the byte cap included) must
    // reach the reader through `gunzip`, and a cap tripping downstream must
    // tear the download down rather than leave it paused on backpressure
    // until the timeout fires. The rejection itself is observed by the
    // reader; this promise only must not be left unhandled.
    pipeline(Readable.from(bounded(gz, limits.maxDownloadBytes, "the download")), gunzip).catch(() => {});
    tar = bounded(gunzip, limits.maxArchiveBytes, "the unpacked archive");
    // `<owner>-<repo>-<short sha>/` wraps every entry.
    strip = 1;
  } else {
    tar = bounded(await deps.gitArchive(parsed.cloneUrl, sha, scratch, signal), limits.maxArchiveBytes, "the archive");
    strip = 0;
  }
  let extract: TarExtractResult;
  try {
    extract = await extractTar(tar, { dest, strip, ...pick, caps: limits });
  } catch (err) {
    if (signal.aborted) throw new PluginInspectError(`gave up after ${limits.timeoutMs / 1000}s fetching ${parsed.repo}`, 504);
    if (err instanceof PluginInspectError) throw err;
    throw new PluginInspectError(`could not read the archive: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
  // GitHub stamps the commit into the pax global header. When it disagrees
  // with the sha asked for, something between here and GitHub is lying —
  // refuse rather than report on, or install, the wrong bytes.
  if (parsed.host === "github" && extract.globalComment && extract.globalComment !== sha) {
    throw new PluginInspectError(`GitHub served commit ${extract.globalComment.slice(0, 7)} for ${sha.slice(0, 7)}`, 502);
  }
  return extract;
}

/**
 * A collection member's repository-relative directory, checked: it must sit
 * at or under `root` (the directory the URL names). The install route takes
 * it from the request body, so without this a client could install any
 * directory of the repository while the owner was shown another.
 */
export function memberSubdir(root: string, member: string): string {
  const n = normaliseCollectionPath(member);
  if ("error" in n) throw new PluginInspectError(`subdir ${n.error}`, 400);
  if (n.path.split("/").some((seg) => seg && unsafeEntryName(seg))) throw new PluginInspectError(`unsafe subdir: ${member}`, 400);
  if (root && n.path !== root && !n.path.startsWith(`${root}/`)) {
    throw new PluginInspectError(`${n.path || "(root)"} is not inside ${root}/, the directory the URL names`, 400);
  }
  return n.path;
}

/**
 * Resolve `url` and pull the plugin's directory at the resolved (or pinned)
 * commit into a fresh scratch dir. On ANY failure the scratch dir is removed
 * before the error propagates; on success the caller owns it.
 *
 * `soft` is collection discovery: caps stop the writing instead of the fetch
 * (`extract.overflow` says so), and a missing `plugin.yaml` at the URL's
 * directory is not an error — the caller decides whether what IS there makes
 * a collection.
 */
export async function fetchPlugin(
  url: string,
  opts: {
    pinSha?: string;
    /**
     * Already resolved — an update, whose ref and subdir come from the
     * recorded source rather than the URL (a newer TAG is not the one the URL
     * names, and the old one may since have been deleted). Skips `ls-remote`.
     */
    target?: ResolvedRef;
    /** A collection member's repository-relative directory, inside the URL's (see {@link memberSubdir}). */
    member?: string;
    soft?: boolean;
    limits?: FetchLimits;
    deps?: FetchDeps;
  } = {},
): Promise<FetchedPlugin> {
  const limits = opts.limits ?? DEFAULT_FETCH_LIMITS;
  const deps = opts.deps ?? realFetchDeps;
  const parsed = parsePluginUrl(url);
  const signal = AbortSignal.timeout(limits.timeoutMs);

  const resolved = opts.target ?? resolvePluginRef(parsed, await listRefs(parsed, deps, signal));
  // Install pins to the sha the owner was shown. The URL is still resolved —
  // it is what says where the ref ends and the subdir begins — but its tip is
  // ignored: a push between Inspect and Install must not change what lands.
  const sha = opts.pinSha ?? resolved.sha;
  const subdir = opts.member !== undefined ? memberSubdir(resolved.subdir, opts.member) : resolved.subdir;

  const scratch = await mkdtemp(join(tmpdir(), "dispatch-inspect-"));
  try {
    const dir = join(scratch, "plugin");
    const extract = await extractCommit(parsed, sha, scratch, dir, { subdir, soft: opts.soft }, limits, deps, signal);
    if (!opts.soft && !extract.manifestDirs.includes(subdir)) {
      const where = subdir ? `in ${subdir}/` : "at the repository root";
      const others = extract.manifestDirs.filter((d) => d !== subdir).slice(0, 8);
      throw new PluginInspectError(
        `no plugin.yaml ${where} of ${parsed.repo}@${sha.slice(0, 7)}` +
          (others.length ? ` — found one in: ${others.map((d) => d || "(root)").join(", ")}` : ""),
        404,
      );
    }
    return {
      parsed,
      ref: resolved.ref,
      // A URL that named a branch but was installed at a pinned sha still
      // follows the branch: Install pins what lands, not what is followed.
      refKind: resolved.refKind,
      sha,
      subdir,
      browseUrl: browseUrl(parsed, sha, subdir),
      scratch,
      dir,
      extract,
    };
  } catch (err) {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * The second pass of a collection whose first, soft pass overflowed: the same
 * commit again, keeping ONLY the members' directories (relative to
 * `f.subdir`), with strict caps sized for that many plugins — each member is
 * still one plugin, so the per-file cap does not scale. Lands in
 * `<f.scratch>/members`, which the caller's cleanup of `f.scratch` removes.
 */
let refetches = 0;

export async function refetchMembers(
  f: FetchedPlugin,
  members: string[],
  opts: { limits?: FetchLimits; deps?: FetchDeps } = {},
): Promise<{ dir: string; extract: TarExtractResult }> {
  const base = opts.limits ?? DEFAULT_FETCH_LIMITS;
  const n = Math.max(1, Math.min(members.length, 10));
  const limits: FetchLimits = { ...base, maxFiles: base.maxFiles * n, maxBytes: base.maxBytes * n };
  const dir = join(f.scratch, `members-${refetches++}`);
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const extract = await extractCommit(
    f.parsed,
    f.sha,
    f.scratch,
    dir,
    { subdir: f.subdir, include: members },
    limits,
    opts.deps ?? realFetchDeps,
    signal,
  );
  return { dir, extract };
}
