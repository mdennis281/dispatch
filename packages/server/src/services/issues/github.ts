/**
 * GitHub issues through `gh api` (REST).
 *
 * REST rather than `gh issue list --json`, for one field: `author_association`.
 * The CLI's JSON view has no equivalent, and the trust filter — the thing that
 * stops a stranger's issue text from becoming an agent's instructions — is built
 * on it. REST also takes `--hostname`, which is how an Enterprise source is
 * reached without touching the human's default `gh` host.
 *
 * The REST issues endpoints return pull requests too (every PR is an issue on
 * GitHub); those carry a `pull_request` key and are dropped here, so nothing
 * above the provider ever mistakes a PR for an issue to handle.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ISSUE_REPO_RE,
  type Issue,
  type IssueAuthorTrust,
  type IssueComment,
  type IssuePatch,
  type IssueSource,
} from "@dispatch/shared";
import type { ExecaLike } from "../github.js";
import type { IssueListQuery, IssueProvider } from "./provider.js";

interface RawUser {
  login?: string;
  type?: string;
}

interface RawIssue {
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  html_url?: string;
  user?: RawUser | null;
  author_association?: string;
  labels?: Array<{ name?: string } | string>;
  assignees?: RawUser[] | null;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  pull_request?: unknown;
}

interface RawComment {
  id: number | string;
  body?: string | null;
  user?: RawUser | null;
  author_association?: string;
  created_at?: string;
  html_url?: string;
}

function trustOf(association: string | undefined): IssueAuthorTrust {
  switch (association) {
    case "OWNER":
      return "owner";
    case "MEMBER":
      return "member";
    case "COLLABORATOR":
      return "collaborator";
    case "CONTRIBUTOR":
    case "FIRST_TIME_CONTRIBUTOR":
    case "FIRST_TIMER":
      return "contributor";
    default:
      return "none";
  }
}

const isBot = (user: RawUser | null | undefined): boolean =>
  user?.type === "Bot" || /\[bot\]$/i.test(user?.login ?? "");

function toIssue(raw: RawIssue): Issue {
  return {
    number: raw.number,
    title: raw.title ?? "",
    body: raw.body ?? "",
    state: raw.state === "closed" ? "closed" : "open",
    url: raw.html_url ?? "",
    author: raw.user?.login ?? "ghost",
    authorTrust: trustOf(raw.author_association),
    authorIsBot: isBot(raw.user),
    labels: (raw.labels ?? [])
      .map((l) => (typeof l === "string" ? l : l.name ?? ""))
      .filter(Boolean),
    assignees: (raw.assignees ?? []).map((a) => a.login ?? "").filter(Boolean),
    commentCount: raw.comments ?? 0,
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
  };
}

export class GitHubIssueProvider implements IssueProvider {
  readonly id = "github" as const;

  constructor(private readonly exec: ExecaLike) {}

  async list(source: IssueSource, query: IssueListQuery = {}): Promise<Issue[]> {
    const limit = Math.min(Math.max(query.limit ?? 30, 1), 100);
    const out: Issue[] = [];
    // Page until `limit` REAL issues: `/issues` interleaves PRs, so one page of
    // `limit` items can be all PRs — on this repo the newest 30 of `state=all`
    // are — and a single fetch would report "(none)" with confidence. Full pages
    // of 100 minimise calls; the page cap bounds a repo that is nearly all PRs,
    // where the search API (lagging index, 30 req/min) would be the worse trade.
    for (let page = 1; page <= GitHubIssueProvider.MAX_LIST_PAGES && out.length < limit; page++) {
      const args = [
        "-X", "GET", this.path(source, "issues"),
        "-f", `state=${query.state ?? "open"}`,
        "-f", "sort=created",
        "-f", "direction=desc",
        "-f", "per_page=100",
        "-f", `page=${page}`,
      ];
      if (query.labels?.length) args.push("-f", `labels=${query.labels.join(",")}`);
      const raw = (await this.json<RawIssue[]>(source, args)) ?? [];
      out.push(...raw.filter((r) => !r.pull_request).map(toIssue));
      if (raw.length < 100) break;
    }
    return out.slice(0, limit);
  }

  /** Pages `list` will read looking for issues among PRs — 500 items. */
  static readonly MAX_LIST_PAGES = 5;

  async get(source: IssueSource, number: number): Promise<Issue | null> {
    const raw = await this.json<RawIssue>(source, [this.path(source, `issues/${this.num(number)}`)], {
      notFound: true,
    });
    return raw && !raw.pull_request ? toIssue(raw) : null;
  }

  async comments(source: IssueSource, number: number, limit = 20, total?: number): Promise<IssueComment[]> {
    // The endpoint is oldest-first, so "the latest N" lives on the LAST page.
    // With the total known that is one call (two when N straddles a page
    // boundary); the tail of page 1 would show comments 91–100 of 150 as if they
    // were the newest, and hide the owner's closing word from the agent.
    const want = Math.min(Math.max(1, limit), 100);
    const perPage = 100;
    const fetchPage = async (page: number) =>
      (await this.json<RawComment[]>(source, [
        "-X", "GET", this.path(source, `issues/${this.num(number)}/comments`),
        "-f", `per_page=${perPage}`,
        "-f", `page=${page}`,
      ])) ?? [];
    const last = Math.max(1, Math.ceil((total ?? 0) / perPage));
    let raw = await fetchPage(last);
    if (raw.length < want && last > 1) raw = [...(await fetchPage(last - 1)), ...raw];
    return raw.slice(-want).map((c) => ({
      id: String(c.id),
      author: c.user?.login ?? "ghost",
      authorTrust: trustOf(c.author_association),
      body: c.body ?? "",
      createdAt: c.created_at ?? "",
      url: c.html_url,
    }));
  }

  async comment(source: IssueSource, number: number, body: string): Promise<{ id: string; url?: string }> {
    // The body goes through a file, never argv: Windows caps a whole command line
    // at 32,767 chars, so a long comment would die as `spawn ENAMETOOLONG`
    // before reaching GitHub. `--input` is read as JSON, so a body starting with
    // `@` is still text rather than a path to read.
    const dir = await mkdtemp(join(tmpdir(), "dispatch-issue-"));
    try {
      const file = join(dir, "comment.json");
      await writeFile(file, JSON.stringify({ body }), "utf8");
      const raw = await this.json<RawComment>(source, [
        "--method", "POST", this.path(source, `issues/${this.num(number)}/comments`),
        "--input", file,
      ]);
      return { id: String(raw?.id ?? ""), url: raw?.html_url };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async update(source: IssueSource, number: number, patch: IssuePatch): Promise<Issue> {
    const base = `issues/${this.num(number)}`;
    if (patch.state) {
      const args = ["-X", "PATCH", this.path(source, base), "-f", `state=${patch.state}`];
      if (patch.state === "closed" && patch.stateReason) args.push("-f", `state_reason=${patch.stateReason}`);
      await this.json(source, args);
    }
    if (patch.addLabels?.length) {
      // POST creates a label the repo doesn't have yet, which is what lets the
      // claim label work on a repo nobody set up for Dispatch.
      await this.json(source, [
        "-X", "POST", this.path(source, `${base}/labels`),
        ...patch.addLabels.flatMap((l) => ["-f", `labels[]=${l}`]),
      ]);
    }
    for (const label of patch.removeLabels ?? []) {
      // 404 = it wasn't on the issue, which is the state asked for.
      await this.json(source, ["-X", "DELETE", this.path(source, `${base}/labels/${encodeURIComponent(label)}`)], {
        notFound: true,
      });
    }
    if (patch.addAssignees?.length) {
      await this.json(source, [
        "-X", "POST", this.path(source, `${base}/assignees`),
        ...patch.addAssignees.flatMap((a) => ["-f", `assignees[]=${a}`]),
      ]);
    }
    if (patch.removeAssignees?.length) {
      await this.json(source, [
        "-X", "DELETE", this.path(source, `${base}/assignees`),
        ...patch.removeAssignees.flatMap((a) => ["-f", `assignees[]=${a}`]),
      ]);
    }
    const now = await this.get(source, number);
    if (!now) throw new Error(`Issue #${number} not found in ${source.repo}`);
    return now;
  }

  /* ------------------------------------------------------------ internals */

  private path(source: IssueSource, rest: string): string {
    // Re-validated here, not trusted from the caller: `repo` becomes part of a
    // URL path, and an authored source is only as clean as the YAML it came from.
    if (!ISSUE_REPO_RE.test(source.repo)) throw new Error(`invalid repo "${source.repo}"`);
    return `repos/${source.repo}/${rest}`;
  }

  private num(n: number): number {
    if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid issue number ${n}`);
    return n;
  }

  private async json<T>(
    source: IssueSource,
    args: string[],
    opts: { notFound?: boolean } = {},
  ): Promise<T | null> {
    const host = source.host ? ["--hostname", source.host] : [];
    const res = await this.exec("gh", ["api", ...host, ...args], { reject: false });
    if (res.exitCode !== 0) {
      const detail = (res.stderr || res.stdout || "gh api failed").trim();
      if (opts.notFound && /\b404\b|Not Found/i.test(detail)) return null;
      throw new Error(detail.slice(0, 500));
    }
    const out = res.stdout.trim();
    return out ? (JSON.parse(out) as T) : null;
  }
}
