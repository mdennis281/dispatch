/**
 * IssueService — which tracker a project's issues live in, and a handle on it.
 *
 * The source is resolved at USE time, every time: an authored `issues.source`
 * wins, otherwise `origin` is read and parsed. Resolving once and caching would
 * mean a project that re-pointed its remote kept filing comments on the old repo
 * until a restart, with nothing in the UI to say so.
 */
import {
  detectIssueSource,
  type Issue,
  type IssueComment,
  type IssueConfig,
  type IssuePatch,
  type IssueProviderId,
  type IssueSource,
  type Project,
} from "@dispatch/shared";
import { execa } from "execa";
import type { ExecaLike } from "../github.js";
import { GitHubIssueProvider } from "./github.js";
import type { IssueListQuery, IssueProvider } from "./provider.js";

export type IssueSourceOrigin = "config" | "origin";

export interface ResolvedIssueSource {
  source: IssueSource;
  from: IssueSourceOrigin;
}

/** A tracker bound to one source — what an MCP session or the watcher holds. */
export interface BoundIssueTracker {
  source: IssueSource;
  from: IssueSourceOrigin;
  list(query?: IssueListQuery): Promise<Issue[]>;
  get(number: number): Promise<Issue | null>;
  comments(number: number, limit?: number): Promise<IssueComment[]>;
  comment(number: number, body: string): Promise<{ id: string; url?: string }>;
  update(number: number, patch: IssuePatch): Promise<Issue>;
}

export interface IssueServiceDeps {
  getProject: (projectId: string) => Promise<Project | null>;
  /** The project's authored `issues:` block (null → none). */
  getConfig: (projectId: string) => IssueConfig | null;
  /** Injectable for tests; defaults to execa (argv arrays, no shell). */
  exec?: ExecaLike;
  /** Override or extend the provider set (tests, future trackers). */
  providers?: Partial<Record<IssueProviderId, IssueProvider>>;
}

const defaultExec: ExecaLike = (file, args = [], options) =>
  execa(file, args as string[], {
    cwd: options?.cwd,
    reject: options?.reject,
    env: options?.env,
  }) as unknown as ReturnType<ExecaLike>;

export class IssueService {
  private readonly providers: Partial<Record<IssueProviderId, IssueProvider>>;
  private readonly exec: ExecaLike;

  constructor(private readonly deps: IssueServiceDeps) {
    this.exec = deps.exec ?? defaultExec;
    this.providers = { github: new GitHubIssueProvider(this.exec), ...deps.providers };
  }

  /**
   * What `origin` says, for autofilling the config pane. Returns the raw remote
   * too so the pane can show what it read when no provider claims it — "we
   * couldn't detect one" is unhelpful next to a URL the human can see is GitLab.
   */
  async detect(repoPath: string): Promise<{ remote: string | null; source: IssueSource | null }> {
    const res = await this
      .exec("git", ["remote", "get-url", "origin"], { cwd: repoPath, reject: false })
      .catch(() => null);
    const remote = res && res.exitCode === 0 ? res.stdout.trim() || null : null;
    return { remote: remote ? redactRemote(remote) : null, source: remote ? detectIssueSource(remote) : null };
  }

  async sourceFor(projectId: string): Promise<ResolvedIssueSource | null> {
    const authored = this.deps.getConfig(projectId)?.source;
    if (authored) return { source: authored, from: "config" };
    const project = await this.deps.getProject(projectId).catch(() => null);
    if (!project) return null;
    const { source } = await this.detect(project.repoPath);
    return source ? { source, from: "origin" } : null;
  }

  provider(id: IssueProviderId): IssueProvider {
    const p = this.providers[id];
    if (!p) throw new Error(`No issue provider for "${id}"`);
    return p;
  }

  /** A tracker bound to this project's source, or null when it has none. */
  async forProject(projectId: string): Promise<BoundIssueTracker | null> {
    const resolved = await this.sourceFor(projectId);
    return resolved ? this.bind(resolved) : null;
  }

  bind({ source, from }: ResolvedIssueSource): BoundIssueTracker {
    const p = this.provider(source.provider);
    return {
      source,
      from,
      list: (q) => p.list(source, q),
      get: (n) => p.get(source, n),
      comments: (n, limit) => p.comments(source, n, limit),
      comment: (n, body) => p.comment(source, n, body),
      update: (n, patch) => p.update(source, n, patch),
    };
  }
}

/**
 * Strip credentials from a remote URL before it leaves the server. A token
 * embedded in `origin` (`https://x-access-token:ghp_…@github.com/…`, which CI
 * checkouts and some credential helpers write) would otherwise be served to every
 * browser tab that opens the config pane.
 */
export function redactRemote(remote: string): string {
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, "$1");
}
