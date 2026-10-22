/**
 * Plugin URL → "which repository, which ref, which directory".
 *
 * Two steps, split so the first is pure and testable without a network:
 *
 *   `parsePluginUrl`  reads the pasted string. It cannot yet tell where a
 *                     GitHub `/tree/<ref>/<subdir>` ref ENDS, because a branch
 *                     may contain slashes (`feat/x`) — `/tree/feat/x/plugins/a`
 *                     is ambiguous until the remote's ref list is known.
 *   `resolvePluginRef` takes the remote's refs (`git ls-remote --symref`) and
 *                     picks the LONGEST branch or tag that is a prefix of those
 *                     segments, which is what GitHub's own router does.
 *
 * Only `https` is accepted. `ssh` needs the owner's keys and an agent the
 * server process may not have; `http`, `file://`, `ext::` and the rest are
 * either cleartext or ways to make `git` run something. A `git@github.com:o/r`
 * shorthand is rewritten to its https clone URL rather than refused, because
 * that is what people copy from the green button.
 */

export class PluginInspectError extends Error {
  constructor(
    message: string,
    /** HTTP status the route answers with: 400 bad input, 404 not found, 413 too big, 502 upstream, 504 timeout. */
    readonly status = 400,
  ) {
    super(message);
    this.name = "PluginInspectError";
  }
}

export interface ParsedPluginUrl {
  host: "github" | "git";
  /** `owner/repo` on GitHub; `host/path` elsewhere. */
  repo: string;
  owner?: string;
  name?: string;
  /** What `git ls-remote` / `git fetch` are pointed at. */
  cloneUrl: string;
  /**
   * Path segments after `/tree/` or `/blob/` (GitHub), still holding the ref
   * AND the subdir run together; or `[ref]` from a `#ref` fragment elsewhere.
   * Empty: the default branch, at the root.
   */
  refPath: string[];
  /** The URL named a FILE (`/blob/…`), so the subdir is its parent directory. */
  blob: boolean;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;

function bad(message: string): never {
  throw new PluginInspectError(message, 400);
}

/** Decode one path segment and refuse anything that could walk out of the repository. */
function segment(raw: string): string {
  let s: string;
  try {
    s = decodeURIComponent(raw);
  } catch {
    bad(`malformed URL segment: ${raw}`);
  }
  if (!s || s === "." || s === ".." || /[\\\0]/.test(s)) bad(`unsafe path segment in URL: ${JSON.stringify(s)}`);
  return s;
}

export function parsePluginUrl(input: string): ParsedPluginUrl {
  let raw = input.trim();
  // Same refusal `dispatch plugin add` makes, for the same reason: a "URL" starting
  // with `-` handed to git is an option, not a remote.
  if (!raw || raw.startsWith("-")) bad("paste a GitHub or https git URL");
  const scp = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(raw);
  if (scp) raw = `https://github.com/${scp[1]}/${scp[2]}`;
  if (/^github\.com\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    bad(`not a URL: ${input}`);
  }
  if (url.protocol !== "https:") bad(`only https URLs are accepted (got ${url.protocol.replace(/:$/, "")})`);
  // A token in the URL would ride into the report and the git process list.
  // A private repo is out of scope; say so plainly.
  if (url.username || url.password) bad("remove the credentials from the URL — only public repositories can be inspected");

  const hostname = url.hostname.toLowerCase();
  if (hostname === "github.com" || hostname === "www.github.com") {
    const parts = url.pathname.split("/").filter(Boolean).map(segment);
    if (parts.length < 2) bad("a GitHub URL needs an owner and a repository: github.com/<owner>/<repo>");
    const owner = parts[0]!;
    const name = parts[1]!.replace(/\.git$/i, "");
    if (!SEGMENT.test(owner) || !SEGMENT.test(name)) bad(`not a GitHub repository: ${owner}/${name}`);
    const rest = parts.slice(2);
    let refPath: string[] = [];
    let blob = false;
    if (rest.length) {
      const kind = rest[0];
      if (kind !== "tree" && kind !== "blob") {
        bad(`unsupported GitHub URL: use the repository, a /tree/<ref>/<dir> or a /blob/<ref>/…/plugin.yaml link`);
      }
      blob = kind === "blob";
      refPath = rest.slice(1);
      if (!refPath.length) bad(`the URL ends at /${kind}/ without a ref`);
      if (blob && refPath.length < 2) bad("a /blob/ URL must name a file");
    }
    return {
      host: "github",
      repo: `${owner}/${name}`,
      owner,
      name,
      cloneUrl: `https://github.com/${owner}/${name}.git`,
      refPath,
      blob,
    };
  }

  // Any other https git host: the URL is the clone URL, a `#ref` fragment
  // optionally names the branch/tag/sha. Host-specific browse URLs
  // (GitLab's `/-/tree/…`) are not decoded — paste the clone URL.
  const fragment = url.hash.replace(/^#/, "");
  url.hash = "";
  url.search = "";
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") bad("the URL names a host but no repository");
  if (path.includes("/-/") || /\/(tree|blob)\//.test(path)) {
    bad("that looks like a web page URL — paste the repository's https clone URL (ending .git), optionally with #<ref>");
  }
  return {
    host: "git",
    repo: `${hostname}${path.replace(/\.git$/i, "")}`,
    cloneUrl: `${url.origin}${path}`,
    refPath: fragment ? [segment(fragment)] : [],
    blob: false,
  };
}

/** One line of `git ls-remote --symref` output, parsed. */
export interface RemoteRefs {
  /** `refs/heads/main` → sha, `refs/tags/v1` → sha (peeled `^{}` wins for annotated tags). */
  refs: Map<string, string>;
  /** What `HEAD` points at, when the remote said (`--symref`). */
  headRef?: string;
  headSha?: string;
}

export function parseLsRemote(out: string): RemoteRefs {
  const refs = new Map<string, string>();
  let headRef: string | undefined;
  let headSha: string | undefined;
  for (const line of out.split(/\r?\n/)) {
    const sym = /^ref:\s+(\S+)\s+HEAD$/.exec(line);
    if (sym) {
      headRef = sym[1];
      continue;
    }
    const m = /^([0-9a-f]{40})\s+(\S+)$/.exec(line);
    if (!m) continue;
    const [, sha, name] = m as unknown as [string, string, string];
    if (name === "HEAD") {
      headSha = sha;
    } else if (name.endsWith("^{}")) {
      // An annotated tag's peeled commit. The tag OBJECT's sha would not name
      // a tree a tarball can be cut from, so the commit replaces it.
      refs.set(name.slice(0, -3), sha);
    } else if (!refs.has(name)) {
      refs.set(name, sha);
    }
  }
  return { refs, headRef, headSha };
}

export interface ResolvedRef {
  /** Display name of the ref (`main`, `v1.0.0`, or the sha itself). */
  ref: string;
  sha: string;
  /** Directory inside the repository, `""` for the root. */
  subdir: string;
}

/**
 * Split `refPath` into ref + subdir against the remote's refs and pick the
 * commit. A full sha as the first segment is taken as-is (it may be any
 * commit, not only a ref tip); an abbreviated sha cannot be resolved without
 * the host's API, so it is refused with the fix.
 */
export function resolvePluginRef(parsed: ParsedPluginUrl, remote: RemoteRefs): ResolvedRef {
  const segs = parsed.refPath;
  // A /blob/ URL names a file; its directory is where plugin.yaml should be.
  const dirOf = (rest: string[]) => (parsed.blob ? rest.slice(0, -1) : rest).join("/");
  if (!segs.length) {
    const sha = remote.headSha;
    if (!sha) throw new PluginInspectError("the remote did not report a default branch (HEAD)", 502);
    return { ref: remote.headRef?.replace(/^refs\/heads\//, "") ?? "HEAD", sha, subdir: "" };
  }
  if (SHA.test(segs[0]!)) return { ref: segs[0]!, sha: segs[0]!, subdir: dirOf(segs.slice(1)) };
  for (let n = segs.length; n >= 1; n--) {
    const name = segs.slice(0, n).join("/");
    // Branch before tag when both exist — GitHub's router makes the same call.
    const sha = remote.refs.get(`refs/heads/${name}`) ?? remote.refs.get(`refs/tags/${name}`);
    if (sha) return { ref: name, sha, subdir: dirOf(segs.slice(n)) };
  }
  if (/^[0-9a-f]{7,39}$/.test(segs[0]!)) {
    throw new PluginInspectError(`"${segs[0]}" looks like an abbreviated commit — use the full 40-character sha`, 400);
  }
  throw new PluginInspectError(`no branch or tag named "${segs[0]}" in ${parsed.repo}`, 404);
}

/** A link to `subdir` at `sha` the card can offer, when the host has a known web UI. */
export function browseUrl(parsed: ParsedPluginUrl, sha: string, subdir: string): string | undefined {
  if (parsed.host !== "github") return undefined;
  return `https://github.com/${parsed.repo}/tree/${sha}${subdir ? `/${subdir.split("/").map(encodeURIComponent).join("/")}` : ""}`;
}
