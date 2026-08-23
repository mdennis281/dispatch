import { describe, it, expect, beforeEach } from "vitest";
import { execa } from "execa";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../bus.js";
import type { WsServerEvent } from "@dispatch/shared";
import type { Project, Chat } from "@dispatch/shared";
import type { Store } from "../store/index.js";
import { GitHubService, COPILOT_LOGIN, type ExecResult, type ExecaLike } from "./github.js";

/* ---------------------------------------------------------------- test harness */

interface Call {
  file: string;
  args: string[];
  /** `env` included: switching identity is an env change, so it has to be assertable. */
  options?: { cwd?: string; reject?: boolean; env?: NodeJS.ProcessEnv };
}

/** A sequential execa mock: records every call, returns queued results in order. */
function makeExec() {
  const calls: Call[] = [];
  const queue: ExecResult[] = [];
  const exec: ExecaLike = async (file, args = [], options) => {
    calls.push({ file, args: [...args], options: options as Call["options"] });
    return queue.shift() ?? { stdout: "", exitCode: 0 };
  };
  const push = (r: Partial<ExecResult>) => queue.push({ stdout: "", exitCode: 0, ...r });
  const json = (v: unknown) => push({ stdout: JSON.stringify(v), exitCode: 0 });
  return { calls, exec, push, json };
}

const REPO = "octocat/hello";

function rawPr(over: Record<string, unknown> = {}) {
  return {
    number: 42,
    url: "https://github.com/octocat/hello/pull/42",
    title: "feat: thing",
    state: "OPEN",
    headRefName: "feat/thing",
    baseRefName: "main",
    isDraft: false,
    author: { login: "octocat" },
    body: "hi",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    labels: [{ name: "enhancement" }],
    additions: 10,
    deletions: 2,
    updatedAt: "2026-07-02T00:00:00Z",
    createdAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

function collect(bus: EventBus): WsServerEvent[] {
  const events: WsServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return events;
}

let bus: EventBus;
beforeEach(() => {
  bus = new EventBus();
});

/* ------------------------------------------------------------------ repo guard */

describe("owner/repo validation", () => {
  it("rejects malformed repo slugs before any gh call", () => {
    const { exec, calls } = makeExec();
    const gh = new GitHubService({ bus, exec });
    expect(() => gh.assertRepo("not-a-repo")).toThrow(/invalid repo/);
    expect(() => gh.assertRepo("a/b/c")).toThrow(/invalid repo/);
    expect(() => gh.assertRepo("bad owner/repo")).toThrow(/invalid repo/);
    expect(gh.assertRepo("octocat/hello.world-1")).toBe("octocat/hello.world-1");
    expect(calls).toHaveLength(0);
  });

  it("prForBranch throws on a bad repo without calling gh", async () => {
    const { exec, calls } = makeExec();
    const gh = new GitHubService({ bus, exec });
    await expect(gh.prForBranch("bad repo", "feat/x")).rejects.toThrow(/invalid repo/);
    expect(calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------- READ */

describe("prReviewState — the reviewer queue", () => {
  /** The GraphQL queue payload, plus the `gh pr view` reviews payload. */
  const queueJson = (
    nodes: Array<{ __typename: string; login?: string; slug?: string }>,
    extra: {
      author?: string;
      head?: string;
      reviews?: Array<{
        author: string;
        state: string;
        isMinimized?: boolean;
        submittedAt?: string;
        commit?: string;
      }>;
    } = {},
  ) => ({
    data: {
      repository: {
        pullRequest: {
          author: { login: extra.author ?? "author-of-the-pr" },
          headRefOid: extra.head,
          reviews: {
            nodes: (extra.reviews ?? []).map((r) => ({
              author: { login: r.author },
              state: r.state,
              isMinimized: r.isMinimized ?? false,
              submittedAt: r.submittedAt ?? null,
              commit: r.commit ? { oid: r.commit } : null,
            })),
          },
          reviewRequests: { nodes: nodes.map((requestedReviewer) => ({ requestedReviewer })) },
        },
      },
    },
  });

  it("maps requested reviewers and submitted reviews", async () => {
    const { exec, calls, json } = makeExec();
    json(
      queueJson([{ __typename: "User", login: "alice" }, { __typename: "Team", slug: "core" }], {
        reviews: [
          { author: "alice", state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T00:00:00Z" },
        ],
      }),
    );
    json({ latestReviews: [{ author: { login: "alice" }, state: "changes_requested" }] });
    const gh = new GitHubService({ bus, exec });

    const state = await gh.prReviewState(REPO, 42);

    // The queue goes through graphql; the reviews stay on `gh pr view`.
    expect(calls[0]!.args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(calls[1]!.args).toEqual([
      "pr", "view", "42", "--repo", REPO, "--json", "latestReviews",
    ]);
    expect(state).toEqual({
      requested: ["alice", "core"],
      reported: [{ author: "alice", state: "CHANGES_REQUESTED" }],
      everReported: [
        { author: "alice", state: "CHANGES_REQUESTED", submittedAt: "2026-01-01T00:00:00Z" },
      ],
    });
  });

  // The disagreement that made `watch_pr` and `approve_pr` contradict each other
  // on PR #147. GitHub's `latestReviews` applies supersede-on-re-request: put a
  // reviewer back in the queue and the review they already filed drops out of
  // it. Dispatch's loop re-queues on EVERY round, so the live list was empty on
  // exactly the PRs that had been reviewed the most — and `approve_pr` refused
  // them for `no-review` while `watch_pr` called them landable.
  it("still reports a review that latestReviews hides behind a pending re-request", async () => {
    const { exec, json } = makeExec();
    json(
      queueJson([{ __typename: "User", login: "dispatch-review" }], {
        reviews: [
          { author: "dispatch-review", state: "COMMENTED", submittedAt: "2026-01-01T00:00:00Z" },
        ],
      }),
    );
    // Empty, because dispatch-review has just been re-requested.
    json({ latestReviews: [] });

    const state = await new GitHubService({ bus, exec }).prReviewState(REPO, 42);

    expect(state!.reported).toEqual([]);
    expect(state!.everReported).toEqual([
      { author: "dispatch-review", state: "COMMENTED", submittedAt: "2026-01-01T00:00:00Z" },
    ]);
  });

  // `resolve_thread` posts its reply as a `PullRequestReview` BY THE PR'S AUTHOR.
  // `latestReviews` drops those for us; `everReported` has to do it by hand, or a
  // PR clears its own review bar by answering its reviewer.
  // `reviewDecision` is an aggregate GitHub never clears for a reviewer that
  // does not submit APPROVE — which is Dispatch's own reviewer. Whether the
  // verdict is about code that has since been REPLACED is what lets `approve_pr`
  // tell a spent objection from a live one.
  it("marks a review stale against the PR head, and says nothing when it can't compare", async () => {
    const { exec, json } = makeExec();
    json(
      queueJson([], {
        head: "sha-2",
        reviews: [
          { author: "a", state: "CHANGES_REQUESTED", commit: "sha-1" },
          { author: "b", state: "CHANGES_REQUESTED", commit: "sha-2" },
          { author: "c", state: "COMMENTED" },
        ],
      }),
    );
    json({ latestReviews: [] });

    const state = await new GitHubService({ bus, exec }).prReviewState(REPO, 42);

    // Newest first, so the order is the reverse of the query's.
    expect(state!.everReported.map((r) => [r.author, r.stale])).toEqual([
      ["c", undefined],
      ["b", false],
      ["a", true],
    ]);
  });

  it("excludes the PR author's own reviews, and PENDING and minimized ones", async () => {
    const { exec, json } = makeExec();
    json(
      queueJson([], {
        author: "mdennis281",
        reviews: [
          { author: "mdennis281", state: "COMMENTED" },
          { author: "someone", state: "PENDING" },
          { author: "someone", state: "COMMENTED", isMinimized: true },
        ],
      }),
    );
    json({ latestReviews: [] });

    const state = await new GitHubService({ bus, exec }).prReviewState(REPO, 42);

    expect(state!.everReported).toEqual([]);
  });

  // THE bug that stuck every chat: `gh pr view --json reviewRequests` silently
  // omits bot reviewers, so Copilot — the reviewer this workflow runs on — read
  // as "nobody is queued" while it was actively working, ~60s after every
  // create_pr. Only GraphQL with an explicit Bot fragment sees it.
  it("sees a BOT reviewer in the queue", async () => {
    const { exec, calls, json } = makeExec();
    json(queueJson([{ __typename: "Bot", login: "copilot-pull-request-reviewer" }]));
    json({ latestReviews: [] });
    const gh = new GitHubService({ bus, exec });

    const state = await gh.prReviewState(REPO, 42);

    expect(state!.requested).toEqual(["copilot-pull-request-reviewer"]);
    // The query must actually ask for the bot shape, or the node comes back
    // login-less and is filtered away exactly as before.
    const q = calls[0]!.args.join(" ");
    expect(q).toContain("... on Bot{login}");
    expect(q).toContain("... on Mannequin{login}");
  });

  // The distinction the stall signal rests on: a PR with nobody requested still
  // answers with empty nodes. Only a failed read yields nothing at all, and
  // coercing that into "nobody is queued" is a false alarm, not a reading.
  it("returns null when either read FAILS, not an empty queue", async () => {
    const { exec, push, json } = makeExec();
    push({ stdout: "", exitCode: 1, stderr: "gh: could not resolve to a PullRequest" });
    json({ latestReviews: [] });
    expect(await new GitHubService({ bus, exec }).prReviewState(REPO, 42)).toBeNull();

    const second = makeExec();
    second.json(queueJson([]));
    second.push({ stdout: "", exitCode: 1, stderr: "gh: boom" });
    expect(await new GitHubService({ bus, exec: second.exec }).prReviewState(REPO, 42)).toBeNull();
  });

  // `gh api graphql` prints `{"errors":[…]}` on stdout and exits non-zero, so
  // under allowFail the body parses cleanly with NO `data` — and `?? []` would
  // read that as "nobody is queued". Same false stall, different door.
  it("treats a GraphQL errors payload as unreadable, not as an empty queue", async () => {
    const { exec, json } = makeExec();
    json({ errors: [{ message: "Something went wrong while executing your query." }] });
    json({ latestReviews: [] });

    expect(await new GitHubService({ bus, exec }).prReviewState(REPO, 42)).toBeNull();
  });

  it("reports a genuinely empty queue as empty arrays", async () => {
    const { exec, json } = makeExec();
    json(queueJson([]));
    json({ latestReviews: [] });
    const gh = new GitHubService({ bus, exec });

    expect(await gh.prReviewState(REPO, 42)).toEqual({
      requested: [],
      reported: [],
      everReported: [],
    });
  });
});

describe("READ methods — argv + JSON parsing", () => {
  it("prForBranch builds argv and maps PRInfo", async () => {
    const { exec, calls, json } = makeExec();
    json([rawPr()]);
    const gh = new GitHubService({ bus, exec });
    const pr = await gh.prForBranch(REPO, "feat/thing");
    expect(calls[0]).toEqual({
      file: "gh",
      args: [
        "pr", "list", "--repo", REPO, "--head", "feat/thing",
        "--state", "all", "--json",
        "number,url,title,state,headRefName,baseRefName,isDraft,author,body,mergeable,mergeStateStatus,labels,additions,deletions,updatedAt,createdAt",
        "--limit", "1",
      ],
      options: { cwd: undefined, reject: false },
    });
    expect(pr).toMatchObject({
      number: 42,
      state: "open",
      branch: "feat/thing",
      baseBranch: "main",
      author: "octocat",
      mergeable: true,
      labels: ["enhancement"],
      checks: [],
    });
  });

  it("prForBranch returns null when the list is empty", async () => {
    const { exec, json } = makeExec();
    json([]);
    const gh = new GitHubService({ bus, exec });
    expect(await gh.prForBranch(REPO, "nope")).toBeNull();
  });

  it("prList maps CONFLICTING→false and MERGED→merged", async () => {
    const { exec, calls, json } = makeExec();
    json([rawPr({ number: 7, state: "MERGED", mergeable: "CONFLICTING" })]);
    const gh = new GitHubService({ bus, exec });
    const list = await gh.prList(REPO, { state: "all", base: "main", limit: 5 });
    expect(calls[0].args).toEqual([
      "pr", "list", "--repo", REPO, "--state", "all", "--json",
      "number,url,title,state,headRefName,baseRefName,isDraft,author,body,mergeable,mergeStateStatus,labels,additions,deletions,updatedAt,createdAt",
      "--limit", "5", "--base", "main",
    ]);
    expect(list[0]).toMatchObject({ number: 7, state: "merged", mergeable: false });
  });

  it("prChecks uses allowFail (reject:false) and maps bucket→conclusion", async () => {
    const { exec, calls, json } = makeExec();
    json([
      { name: "Build", state: "SUCCESS", bucket: "pass", link: "u1" },
      { name: "Guard", state: "FAILURE", bucket: "fail", link: "u2" },
      { name: "Lint", state: "IN_PROGRESS", bucket: "pending" },
    ]);
    const gh = new GitHubService({ bus, exec });
    const checks = await gh.prChecks(REPO, 42);
    expect(calls[0].args).toEqual([
      "pr", "checks", "42", "--repo", REPO, "--json", "name,state,bucket,link,workflow",
    ]);
    expect(checks).toEqual([
      { name: "Build", status: "completed", conclusion: "success", url: "u1" },
      { name: "Guard", status: "completed", conclusion: "failure", url: "u2" },
      { name: "Lint", status: "in_progress", conclusion: null },
    ]);
  });

  it("reviewThreads builds a graphql query with typed variables", async () => {
    const { exec, calls, json } = makeExec();
    json({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "PRRT_abc=",
                  isResolved: false,
                  isOutdated: true,
                  path: "src/a.ts",
                  line: 12,
                  comments: { nodes: [{ author: { login: "copilot" }, body: "nit" }] },
                },
              ],
            },
          },
        },
      },
    });
    const gh = new GitHubService({ bus, exec });
    const threads = await gh.reviewThreads(REPO, 42);
    const args = calls[0].args;
    expect(args[0]).toBe("api");
    expect(args[1]).toBe("graphql");
    expect(args).toContain("-f");
    expect(args).toContain("owner=octocat");
    expect(args).toContain("repo=hello");
    expect(args).toContain("-F");
    expect(args).toContain("number=42");
    expect(args.some((a) => a.startsWith("query=query("))).toBe(true);
    expect(threads).toEqual([
      {
        id: "PRRT_abc=",
        isResolved: false,
        isOutdated: true,
        path: "src/a.ts",
        line: 12,
        author: "copilot",
        body: "nit",
      },
    ]);
  });

  it("comments parses PR comments", async () => {
    const { exec, calls, json } = makeExec();
    json({ comments: [{ id: 1, author: { login: "octocat" }, body: "yo", url: "cu", createdAt: "t" }] });
    const gh = new GitHubService({ bus, exec });
    const cs = await gh.comments(REPO, 42);
    expect(calls[0].args).toEqual(["pr", "view", "42", "--repo", REPO, "--json", "comments"]);
    expect(cs).toEqual([{ id: "1", author: "octocat", body: "yo", url: "cu", createdAt: "t" }]);
  });
});

/* --------------------------------------------------------------------- ACT */

describe("ACT methods — argv + bus events", () => {
  // `ship` joins worktreeRoot with the branch slug via node:path, so the
  // fixture has to be absolute on the HOST platform: a POSIX `join`/`resolve`
  // treats "C:/repo" as relative and silently prefixes cwd.
  const D = process.platform === "win32" ? "C:" : "";
  const REPO_PATH = `${D}/repo`;
  const WT_ROOT = `${D}/repo-worktrees`;

  function project(over: Partial<Project> = {}): Project {
    return {
      id: "p1",
      name: "Hivebreak",
      repoPath: REPO_PATH,
      worktreeRoot: WT_ROOT,
      subApps: [],
      createdAt: 1,
      ...over,
    };
  }

  it("ship via shipCmd runs the command in the worktree and emits pr-update", async () => {
    const { exec, calls, push, json } = makeExec();
    push({ stdout: REPO });          // resolveRepo: gh repo view
    push({ stdout: "", exitCode: 0 }); // pnpm ship
    json([rawPr()]);                 // prForBranch
    json([]);                        // enrich → prChecks
    json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }); // enrich → reviewThreads
    const events = collect(bus);
    const gh = new GitHubService({ bus, exec });

    const pr = await gh.ship(project({ shipCmd: "pnpm ship" }), "feat/thing", { chatId: "c1" });

    // resolveRepo runs `gh repo view` in the repo checkout (no --repo).
    expect(calls[0]).toEqual({
      file: "gh",
      args: ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      options: { cwd: REPO_PATH, reject: false },
    });
    // ship command is split into argv and run in the branch worktree
    // (slug = branch with "/" flattened to "-", joined via node:path).
    expect(calls[1]).toEqual({
      file: "pnpm",
      args: ["ship"],
      options: { cwd: join(WT_ROOT, "feat-thing"), reject: false },
    });
    // No `gh pr create` on the shipCmd path.
    expect(calls.some((c) => c.file === "gh" && c.args[0] === "pr" && c.args[1] === "create")).toBe(false);
    expect(pr).toMatchObject({ number: 42 });
    const prUpdate = events.find((e) => e.type === "pr-update");
    expect(prUpdate).toMatchObject({ type: "pr-update", chatId: "c1", pr: { number: 42 } });
  });

  it("ship without shipCmd runs gh pr create then requests Copilot review", async () => {
    const { exec, calls, push, json } = makeExec();
    push({ stdout: REPO });   // resolveRepo
    push({ stdout: "", exitCode: 0 }); // gh pr create
    json([rawPr()]);          // prForBranch
    push({ stdout: "", exitCode: 0 }); // requestReview
    json([]);                 // enrich prChecks
    json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }); // enrich threads
    const gh = new GitHubService({ bus, exec });

    await gh.ship(project({ defaultBranch: "main" }), "feat/thing");

    expect(calls[1]).toEqual({
      file: "gh",
      args: ["pr", "create", "--repo", REPO, "--base", "main", "--head", "feat/thing", "--fill"],
      options: { cwd: join(WT_ROOT, "feat-thing"), reject: false },
    });
    const review = calls.find((c) => c.args.some((a) => a.includes("requested_reviewers")));
    expect(review?.args).toEqual([
      "api", "--method", "POST",
      "repos/octocat/hello/pulls/42/requested_reviewers",
      "-f", `reviewers[]=${COPILOT_LOGIN}`,
    ]);
  });

  it("ship attaches the PR onto the chat and emits chat-update (with a Store)", async () => {
    const { exec, push, json } = makeExec();
    push({ stdout: REPO });            // resolveRepo
    push({ stdout: "", exitCode: 0 }); // pnpm ship
    json([rawPr()]);                   // prForBranch
    json([]);                          // enrich → prChecks
    json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }); // enrich → threads

    const chat = { id: "c1", projectId: "p1", prs: [] } as unknown as Chat;
    let savedChat: Chat | undefined;
    const store = {
      getChat: async () => chat,
      saveChat: async (c: Chat) => {
        savedChat = c;
        return c;
      },
    } as unknown as Store;

    const events = collect(bus);
    const gh = new GitHubService({ bus, exec, store });
    await gh.ship(project({ shipCmd: "pnpm ship" }), "feat/thing", { chatId: "c1" });

    expect(savedChat?.prs).toEqual([
      {
        number: 42,
        url: "https://github.com/octocat/hello/pull/42",
        branch: "feat/thing",
        repo: REPO,
        title: "feat: thing",
        state: "open",
      },
    ]);
    const chatUpdate = events.find((e) => e.type === "chat-update");
    expect(chatUpdate).toMatchObject({ type: "chat-update", chat: { id: "c1" } });
  });

  it("requestReview posts the Copilot bot login (allowFail)", async () => {
    const { exec, calls } = makeExec();
    const gh = new GitHubService({ bus, exec });
    await gh.requestReview(REPO, 42);
    expect(calls[0]).toEqual({
      file: "gh",
      args: [
        "api", "--method", "POST",
        "repos/octocat/hello/pulls/42/requested_reviewers",
        "-f", "reviewers[]=copilot-pull-request-reviewer[bot]",
      ],
      options: { cwd: undefined, reject: false },
    });
  });

  it("resolveThread uses a graphql mutation with an id variable", async () => {
    const { exec, calls } = makeExec();
    const gh = new GitHubService({ bus, exec });
    await gh.resolveThread("PRRT_xyz=");
    expect(calls[0].args).toEqual([
      "api", "graphql",
      "-f", "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}",
      "-f", "id=PRRT_xyz=",
    ]);
  });

  it("resolveThread rejects an empty id", async () => {
    const { exec, calls } = makeExec();
    const gh = new GitHubService({ bus, exec });
    await expect(gh.resolveThread("")).rejects.toThrow(/threadId required/);
    expect(calls).toHaveLength(0);
  });

  it("addComment builds argv", async () => {
    const { exec, calls } = makeExec();
    const gh = new GitHubService({ bus, exec });
    await gh.addComment(REPO, 42, "looks good");
    expect(calls[0].args).toEqual(["pr", "comment", "42", "--repo", REPO, "--body", "looks good"]);
  });

  it("approve submits an approving review with the body", async () => {
    const { exec, calls } = makeExec();
    const events = collect(bus);
    const gh = new GitHubService({ bus, exec });

    const res = await gh.approve(REPO, 42, "checks green", { chatId: "c9" });

    expect(res).toEqual({ approved: true });
    expect(calls[0].args).toEqual([
      "pr", "review", "42", "--repo", REPO, "--approve", "--body", "checks green",
    ]);
    expect(events.some((e) => e.type === "notice")).toBe(true);
  });

  it("approve reports a refusal instead of throwing (you can't approve your own PR)", async () => {
    // The usual case here — the PR is ours. It must NOT abort the merge.
    const gh = new GitHubService({
      bus,
      exec: async () => ({
        stdout: "",
        stderr: "GraphQL: Can not approve your own pull request",
        exitCode: 1,
      }),
    });

    const res = await gh.approve(REPO, 42, "body");
    expect(res.approved).toBe(false);
    expect(res.error).toMatch(/approve your own/);
  });

  it("merge defaults to squash + delete-branch and emits the merged PR", async () => {
    const { exec, calls, push, json } = makeExec();
    push({ stdout: "", exitCode: 0 }); // pr merge
    json(rawPr({ state: "MERGED" }));  // refreshPr → getPr
    json([]);                          // enrich prChecks
    json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }); // threads
    const events = collect(bus);
    const gh = new GitHubService({ bus, exec });

    const pr = await gh.merge(REPO, 42, "squash", { chatId: "c9" });
    expect(calls[0].args).toEqual(["pr", "merge", "42", "--repo", REPO, "--squash", "--delete-branch"]);
    expect(pr).toMatchObject({ state: "merged" });
    expect(events.find((e) => e.type === "pr-update")).toMatchObject({ chatId: "c9", pr: { state: "merged" } });
  });

  it("merge honours method + deleteBranch:false", async () => {
    const { exec, calls, push, json } = makeExec();
    push({ stdout: "", exitCode: 0 });
    json(rawPr());
    json([]);
    json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    const gh = new GitHubService({ bus, exec });
    await gh.merge(REPO, 42, "rebase", { deleteBranch: false });
    expect(calls[0].args).toEqual(["pr", "merge", "42", "--repo", REPO, "--rebase"]);
  });

  it("setLabel adds a label and hold() uses the hold label", async () => {
    const { exec, calls, push, json } = makeExec();
    // setLabel edit + refreshPr(view, checks, threads)
    push({ stdout: "", exitCode: 0 });
    json(rawPr());
    json([]);
    json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    const gh = new GitHubService({ bus, exec });
    await gh.setLabel(REPO, 42, "needs-work", true);
    expect(calls[0].args).toEqual(["pr", "edit", "42", "--repo", REPO, "--add-label", "needs-work"]);

    const { exec: exec2, calls: calls2, push: push2, json: json2 } = makeExec();
    push2({ stdout: "", exitCode: 0 });
    json2(rawPr());
    json2([]);
    json2({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    const gh2 = new GitHubService({ bus, exec: exec2 });
    await gh2.hold(REPO, 42, false);
    expect(calls2[0].args).toEqual(["pr", "edit", "42", "--repo", REPO, "--remove-label", "hold"]);
  });

  it("rerunFailedChecks reruns only failed runs on the PR branch", async () => {
    const { exec, calls, json } = makeExec();
    json(rawPr({ headRefName: "feat/thing" })); // getPr
    json([                                       // listRuns
      { databaseId: 100, name: "CI", status: "completed", conclusion: "failure", headBranch: "feat/thing" },
      { databaseId: 101, name: "CI", status: "completed", conclusion: "success", headBranch: "feat/thing" },
      { databaseId: 102, name: "CI", status: "completed", conclusion: "cancelled", headBranch: "feat/thing" },
    ]);
    const gh = new GitHubService({ bus, exec });
    const n = await gh.rerunFailedChecks(REPO, 42);
    expect(n).toBe(2);
    const reruns = calls.filter((c) => c.args[0] === "run" && c.args[1] === "rerun");
    expect(reruns.map((c) => c.args)).toEqual([
      ["run", "rerun", "100", "--repo", REPO, "--failed"],
      ["run", "rerun", "102", "--repo", REPO, "--failed"],
    ]);
  });
});

/* ---------------------------------------------------------------- ACTIONS */

describe("Actions — workflows + runs", () => {
  it("listWorkflows parses WorkflowDef[]", async () => {
    const { exec, calls, json } = makeExec();
    json([{ id: 5, name: "CI", path: ".github/workflows/ci.yml", state: "active" }]);
    const gh = new GitHubService({ bus, exec });
    const wfs = await gh.listWorkflows(REPO);
    expect(calls[0].args).toEqual(["workflow", "list", "--repo", REPO, "--json", "id,name,path,state"]);
    expect(wfs).toEqual([{ id: 5, name: "CI", path: ".github/workflows/ci.yml", state: "active" }]);
  });

  it("dispatch builds `gh workflow run` with -f inputs and emits a notice", async () => {
    const { exec, calls } = makeExec();
    const events = collect(bus);
    const gh = new GitHubService({ bus, exec });
    await gh.dispatch(REPO, "desktop.yml", "main", { platform: "win", version: "2026.07.02" }, { chatId: "c3" });
    expect(calls[0].args).toEqual([
      "workflow", "run", "desktop.yml", "--repo", REPO, "--ref", "main",
      "-f", "platform=win", "-f", "version=2026.07.02",
    ]);
    expect(events.find((e) => e.type === "notice")).toMatchObject({ chatId: "c3", level: "info" });
  });

  it("listRuns maps databaseId→id and normalizes status/conclusion", async () => {
    const { exec, calls, json } = makeExec();
    json([
      { databaseId: 900, name: "CI", workflowName: "CI", status: "in_progress", conclusion: "", event: "push", headBranch: "feat/x", url: "u", createdAt: "a", updatedAt: "b" },
    ]);
    const gh = new GitHubService({ bus, exec });
    const runs = await gh.listRuns(REPO, "ci.yml", { branch: "feat/x", limit: 10 });
    expect(calls[0].args).toEqual([
      "run", "list", "--repo", REPO, "--json", RUN_JSON_FIELDS_EXPECTED,
      "--limit", "10", "--workflow", "ci.yml", "--branch", "feat/x",
    ]);
    expect(runs[0]).toMatchObject({ id: 900, status: "in_progress", conclusion: null, url: "u" });
  });

  it("getRun views one run and emits workflow-update", async () => {
    const { exec, calls, json } = makeExec();
    json({ databaseId: 900, name: "CI", status: "completed", conclusion: "success", url: "u" });
    const events = collect(bus);
    const gh = new GitHubService({ bus, exec });
    const run = await gh.getRun(REPO, 900, { chatId: "c4" });
    expect(calls[0].args).toEqual([
      "run", "view", "900", "--repo", REPO, "--json", RUN_JSON_FIELDS_EXPECTED,
    ]);
    expect(run).toMatchObject({ id: 900, status: "completed", conclusion: "success" });
    expect(events.find((e) => e.type === "workflow-update")).toMatchObject({ chatId: "c4", run: { id: 900 } });
  });
});

/* ------------------------------------------------ Batch 3: new read surface */

describe("projectOpenPrs — global open-PR view", () => {
  it("builds argv with the list field set and maps rollup/reviewDecision/comments", async () => {
    const { exec, calls, json } = makeExec();
    json([
      {
        number: 12,
        title: "feat: global",
        headRefName: "feat/global",
        state: "OPEN",
        isDraft: false,
        url: "https://github.com/octocat/hello/pull/12",
        labels: [{ name: "enhancement" }],
        reviewDecision: "APPROVED",
        comments: [{ id: 1 }, { id: 2 }],
        statusCheckRollup: [
          { __typename: "CheckRun", name: "Build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "u1" },
          { __typename: "CheckRun", name: "Guard", status: "IN_PROGRESS", conclusion: "", detailsUrl: "u2" },
          { __typename: "StatusContext", context: "ci/legacy", state: "FAILURE", targetUrl: "u3" },
        ],
      },
    ]);
    const gh = new GitHubService({ bus, exec });
    const list = await gh.projectOpenPrs(REPO);
    expect(calls[0].args).toEqual([
      "pr", "list", "--repo", REPO, "--state", "open",
      "--json", PR_LIST_JSON_FIELDS_EXPECTED, "--limit", "100",
    ]);
    expect(list[0]).toMatchObject({
      number: 12,
      state: "open",
      branch: "feat/global",
      reviewDecision: "approved",
      commentCount: 2,
      labels: ["enhancement"],
    });
    // statusCheckRollup folds inline into checks (CheckRun + legacy StatusContext).
    expect(list[0].checks).toEqual([
      { name: "Build", status: "completed", conclusion: "success", url: "u1" },
      { name: "Guard", status: "in_progress", conclusion: null, url: "u2" },
      { name: "ci/legacy", status: "completed", conclusion: "failure", url: "u3" },
    ]);
  });

  it("returns [] when the repo has no open PRs", async () => {
    const { exec, json } = makeExec();
    json([]);
    const gh = new GitHubService({ bus, exec });
    expect(await gh.projectOpenPrs(REPO)).toEqual([]);
  });
});

describe("prDetail — rich single-PR status", () => {
  function rawDetail(over: Record<string, unknown> = {}) {
    return {
      ...rawPr(),
      reviewDecision: "CHANGES_REQUESTED",
      comments: [{ id: 1 }],
      statusCheckRollup: [
        { __typename: "CheckRun", name: "Build", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "d1" },
      ],
      ...over,
    };
  }

  it("uses the detail field set, folds rollup→checks, and attaches review threads", async () => {
    const { exec, calls, json } = makeExec();
    json(rawDetail()); // pr view
    json({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { id: "T1", isResolved: false, path: "a.ts", line: 3, comments: { nodes: [{ author: { login: "copilot" }, body: "nit" }] } },
              ],
            },
          },
        },
      },
    });
    const gh = new GitHubService({ bus, exec });
    const pr = await gh.prDetail(REPO, 42);
    expect(calls[0].args).toEqual([
      "pr", "view", "42", "--repo", REPO, "--json", PR_DETAIL_JSON_FIELDS_EXPECTED,
    ]);
    // Rollup non-empty → NO fallback `pr checks` call.
    expect(calls.some((c) => c.args[0] === "pr" && c.args[1] === "checks")).toBe(false);
    expect(pr).toMatchObject({
      number: 42,
      reviewDecision: "changes_requested",
      commentCount: 1,
      mergeable: true,
    });
    expect(pr?.checks).toEqual([{ name: "Build", status: "completed", conclusion: "failure", url: "d1" }]);
    expect(pr?.reviewThreads).toEqual([
      { id: "T1", isResolved: false, path: "a.ts", line: 3, author: "copilot", body: "nit" },
    ]);
  });

  it("falls back to `pr checks` when the rollup is empty", async () => {
    const { exec, calls, json } = makeExec();
    json(rawDetail({ statusCheckRollup: [] })); // pr view (empty rollup)
    json([{ name: "Build", state: "SUCCESS", bucket: "pass", link: "L1" }]); // pr checks
    json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    const gh = new GitHubService({ bus, exec });
    const pr = await gh.prDetail(REPO, 42);
    const checksCall = calls.find((c) => c.args[0] === "pr" && c.args[1] === "checks");
    expect(checksCall?.args).toEqual([
      "pr", "checks", "42", "--repo", REPO, "--json", "name,state,bucket,link,workflow",
    ]);
    expect(pr?.checks).toEqual([{ name: "Build", status: "completed", conclusion: "success", url: "L1" }]);
  });

  it("returns null when the PR is not found", async () => {
    const { exec, push } = makeExec();
    push({ stdout: "", exitCode: 1 }); // pr view (allowFail) → empty
    const gh = new GitHubService({ bus, exec });
    expect(await gh.prDetail(REPO, 999)).toBeNull();
  });
});

describe("workflowsWithLastRun — default Actions view", () => {
  it("pairs each workflow with its latest run (null when never run)", async () => {
    const { exec, calls, json } = makeExec();
    json([
      { id: 5, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
      { id: 6, name: "Desktop", path: ".github/workflows/desktop.yml", state: "active" },
    ]); // listWorkflows
    json([{ databaseId: 900, name: "CI", status: "completed", conclusion: "success", headBranch: "main", url: "u" }]); // ci.yml
    json([]); // desktop.yml — never run
    const gh = new GitHubService({ bus, exec });
    const rows = await gh.workflowsWithLastRun(REPO);

    expect(calls[0].args).toEqual(["workflow", "list", "--repo", REPO, "--json", "id,name,path,state"]);
    const runListCalls = calls.filter((c) => c.args[0] === "run" && c.args[1] === "list");
    expect(runListCalls[0].args).toEqual([
      "run", "list", "--repo", REPO, "--json", RUN_JSON_FIELDS_EXPECTED, "--limit", "1", "--workflow", "ci.yml",
    ]);
    expect(runListCalls[1].args).toContain("desktop.yml");

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ workflow: { id: 5, name: "CI" }, lastRun: { id: 900, conclusion: "success" } });
    expect(rows[1]).toMatchObject({ workflow: { id: 6, name: "Desktop" }, lastRun: null });
  });
});

describe("workflowInputs — workflow_dispatch schema", () => {
  const YAML = [
    "name: Desktop",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      platform:",
    "        description: Target platform",
    "        required: true",
    "        default: win",
    "        type: choice",
    "        options:",
    "          - win",
    "          - mac",
    "          - linux",
    "      version:",
    "        description: Build version",
    "        type: string",
    "      dryRun:",
    "        type: boolean",
    "        default: false",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");

  it("reads the YAML and parses name/type/required/default/options", async () => {
    const { exec, calls, push } = makeExec();
    push({ stdout: YAML, exitCode: 0 });
    const gh = new GitHubService({ bus, exec });
    const inputs = await gh.workflowInputs(REPO, "desktop.yml");
    expect(calls[0].args).toEqual(["workflow", "view", "desktop.yml", "--repo", REPO, "--yaml"]);
    expect(inputs).toEqual([
      {
        name: "platform",
        description: "Target platform",
        required: true,
        default: "win",
        type: "choice",
        options: ["win", "mac", "linux"],
      },
      { name: "version", description: "Build version", type: "string" },
      { name: "dryRun", type: "boolean", default: "false" },
    ]);
  });

  it("returns [] when the workflow declares no dispatch inputs", async () => {
    const { exec, push } = makeExec();
    push({ stdout: "name: CI\non:\n  push:\n    branches: [main]\n", exitCode: 0 });
    const gh = new GitHubService({ bus, exec });
    expect(await gh.workflowInputs(REPO, "ci.yml")).toEqual([]);
  });

  it("returns [] when the view yields no YAML (allowFail)", async () => {
    const { exec, push } = makeExec();
    push({ stdout: "", exitCode: 1 });
    const gh = new GitHubService({ bus, exec });
    expect(await gh.workflowInputs(REPO, "gone.yml")).toEqual([]);
  });

  it("rejects a flag-shaped workflow arg without calling gh", async () => {
    const { exec, calls } = makeExec();
    const gh = new GitHubService({ bus, exec });
    await expect(gh.workflowInputs(REPO, "-R")).rejects.toThrow(/invalid workflow/);
    expect(calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ gh errors */

describe("gh failure handling", () => {
  it("throws on a non-zero exit for a non-allowFail call", async () => {
    const { exec, push } = makeExec();
    push({ stdout: "", stderr: "boom", exitCode: 1 });
    const gh = new GitHubService({ bus, exec });
    await expect(gh.addComment(REPO, 42, "x")).rejects.toThrow(/failed \(exit 1\).*boom/);
  });

  it("prChecks swallows a non-zero exit (allowFail) and still parses stdout", async () => {
    const { exec, push } = makeExec();
    push({ stdout: JSON.stringify([{ name: "Guard", state: "PENDING", bucket: "pending" }]), exitCode: 8 });
    const gh = new GitHubService({ bus, exec });
    const checks = await gh.prChecks(REPO, 42);
    expect(checks).toEqual([{ name: "Guard", status: "in_progress", conclusion: null }]);
  });
});

/* ------------------------------------------------------- sameRepository */

/**
 * This decides whether `create_pr` will honour a caller-supplied directory, so
 * "yes" to the wrong repo means opening a PR against someone else's work. Both
 * halves are tested: the comparison logic on a mock, and — because the whole
 * design rests on one claim about git — the claim itself, against real git.
 */
describe("sameRepository", () => {
  it("compares git common dirs, not paths", async () => {
    const { exec, calls, push } = makeExec();
    push({ stdout: "/repo/.git\n", exitCode: 0 });
    push({ stdout: "/repo/.git\n", exitCode: 0 });
    const gh = new GitHubService({ bus, exec });

    expect(await gh.sameRepository("/repo/.claude/worktrees/x", "/repo")).toBe(true);
    // The flag matters: without --path-format=absolute git may answer a relative
    // path, and two relative answers compare equal across DIFFERENT repos.
    expect(calls[0].args).toEqual([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    expect(calls[0].options?.cwd).toBe("/repo/.claude/worktrees/x");
  });

  it("says no for two different repositories", async () => {
    const { exec, push } = makeExec();
    push({ stdout: "/repo-a/.git\n", exitCode: 0 });
    push({ stdout: "/repo-b/.git\n", exitCode: 0 });
    const gh = new GitHubService({ bus, exec });
    expect(await gh.sameRepository("/repo-a", "/repo-b")).toBe(false);
  });

  it("says no — never throws — when a directory isn't a git repo at all", async () => {
    const { exec, push } = makeExec();
    push({ stdout: "", stderr: "not a git repository", exitCode: 128 });
    push({ stdout: "/repo/.git\n", exitCode: 0 });
    const gh = new GitHubService({ bus, exec });
    expect(await gh.sameRepository("/tmp/nowhere", "/repo")).toBe(false);
  });
});

describe("sameRepository — against real git", () => {
  let root: string;
  let hasGit = true;

  beforeEach(async () => {
    try {
      await execa("git", ["--version"]);
    } catch {
      hasGit = false;
      return;
    }
    root = await mkdtemp(join(tmpdir(), "cm-samerepo-"));
  });

  it("accepts a linked worktree and rejects an unrelated repo nested inside", async () => {
    if (!hasGit) return;
    const main = join(root, "main");
    const run = (args: string[], cwd: string) => execa("git", args, { cwd });
    await execa("git", ["init", "-q", "-b", "main", main]);
    await run(["config", "user.email", "t@example.com"], main);
    await run(["config", "user.name", "T"], main);
    await writeFile(join(main, "f.txt"), "hi\n");
    await run(["add", "-A"], main);
    await run(["commit", "-q", "-m", "initial"], main);

    // A linked worktree, physically OUTSIDE the main checkout — the case a
    // path-prefix test would wrongly reject.
    const wt = join(root, "elsewhere");
    await run(["worktree", "add", "-q", "-b", "task", wt], main);

    // An unrelated repo nested INSIDE it — the case a path-prefix test would
    // wrongly accept.
    const nested = join(main, "vendor", "other");
    await execa("git", ["init", "-q", "-b", "main", nested]);

    const gh = new GitHubService({ bus, exec: execa });
    expect(await gh.sameRepository(wt, main)).toBe(true);
    expect(await gh.sameRepository(nested, main)).toBe(false);
    expect(await gh.sameRepository(main, main)).toBe(true);

    await rm(root, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------- pollPrState (one poll) */

/**
 * A GraphQL poll payload. Everything defaults to "an ordinary open PR" so each
 * test states only the thing it is about.
 */
function pollPayload(over: Record<string, unknown> = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          number: 42,
          title: "feat: thing",
          url: "https://github.com/octocat/hello/pull/42",
          state: "OPEN",
          isDraft: false,
          merged: false,
          headRefOid: "HEAD_SHA",
          headRefName: "feat/thing",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: null,
          author: { login: "octocat" },
          labels: { nodes: [] },
          reviewRequests: { nodes: [] },
          reviews: { nodes: [] },
          latestReviews: { nodes: [] },
          reviewThreads: { nodes: [] },
          comments: { totalCount: 3 },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          name: "build",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                          detailsUrl: "https://ci/build",
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
          ...over,
        },
      },
    },
  };
}

describe("pollPrState — the one poll body", () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus();
  });

  it("reads the whole PR in ONE `gh api graphql`, with typed variables", async () => {
    const { calls, exec, json } = makeExec();
    json(pollPayload());
    const gh = new GitHubService({ bus, exec });

    const snap = await gh.pollPrState(REPO, 42);

    // The point of the exercise: five subprocess spawns per poll became one.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 2)).toEqual(["api", "graphql"]);
    // Owner/repo/number go as VARIABLES, never interpolated into the query.
    expect(calls[0]!.args).toContain("owner=octocat");
    expect(calls[0]!.args).toContain("repo=hello");
    expect(calls[0]!.args).toContain("number=42");
    expect(snap?.number).toBe(42);
    expect(snap?.state).toBe("open");
    expect(snap?.branch).toBe("feat/thing");
    expect(snap?.commentCount).toBe(3);
    expect(snap?.checks).toEqual([
      { name: "build", status: "completed", conclusion: "success", url: "https://ci/build" },
    ]);
  });

  it("reports an UNSUBMITTED review as in_progress — the reviewing spinner", async () => {
    // The state REST cannot see at all, and the reason this poll is GraphQL.
    const { exec, json } = makeExec();
    json(
      pollPayload({
        reviewRequests: {
          nodes: [{ requestedReviewer: { __typename: "Bot", login: "copilot" } }],
        },
        reviews: { nodes: [{ author: { login: "copilot" }, state: "PENDING" }] },
      }),
    );
    const gh = new GitHubService({ bus, exec });

    const snap = await gh.pollPrState(REPO, 42);

    expect(snap?.reviewers).toEqual([
      { login: "copilot", kind: "bot", state: "in_progress", submittedAt: undefined },
    ]);
    // `requested` names who is on the hook but has NOT started; a reviewer who
    // is mid-review is reported as such, not double-counted as merely queued.
    expect(snap?.requested).toEqual([]);
  });

  it("marks a reviewer stale when their verdict is about an older commit", async () => {
    const { exec, json } = makeExec();
    json(
      pollPayload({
        latestReviews: {
          nodes: [
            {
              author: { login: "human" },
              state: "APPROVED",
              submittedAt: "2026-08-01T00:00:00Z",
              commit: { oid: "OLD_SHA" },
            },
          ],
        },
      }),
    );
    const gh = new GitHubService({ bus, exec });

    const snap = await gh.pollPrState(REPO, 42);
    expect(snap?.reviewers[0]).toMatchObject({ state: "approved", stale: true });
  });

  it("leaves staleness UNKNOWN rather than guessing when it can't compare", async () => {
    const { exec, json } = makeExec();
    json(
      pollPayload({
        headRefOid: undefined,
        latestReviews: { nodes: [{ author: { login: "human" }, state: "APPROVED" }] },
      }),
    );
    const gh = new GitHubService({ bus, exec });

    const snap = await gh.pollPrState(REPO, 42);
    expect(snap?.reviewers[0]!.stale).toBeUndefined();
  });

  it("ignores a MINIMIZED review — it isn't the reviewer's live position", async () => {
    const { exec, json } = makeExec();
    json(
      pollPayload({
        latestReviews: {
          nodes: [{ author: { login: "copilot" }, state: "CHANGES_REQUESTED", isMinimized: true }],
        },
      }),
    );
    const gh = new GitHubService({ bus, exec });

    const snap = await gh.pollPrState(REPO, 42);
    expect(snap?.reviewers).toEqual([]);
    expect(snap?.reported).toEqual([]);
  });

  it("reports merge CONFLICTS as false and an uncomputed answer as null", async () => {
    const { exec, json } = makeExec();
    json(pollPayload({ mergeable: "CONFLICTING" }));
    json(pollPayload({ mergeable: "UNKNOWN" }));
    const gh = new GitHubService({ bus, exec });

    expect((await gh.pollPrState(REPO, 42))?.mergeable).toBe(false);
    // UNKNOWN means GitHub hasn't worked it out yet — a PR opened a moment ago
    // reads that way, and calling it conflicted would flag half of them.
    expect((await gh.pollPrState(REPO, 42))?.mergeable).toBeNull();
  });

  it("falls back to `gh pr checks` when the rollup is empty", async () => {
    // Otherwise an empty rollup and "no CI configured" are indistinguishable,
    // and `watch_pr`'s no-checks note would be a guess.
    const { calls, exec, json } = makeExec();
    json(pollPayload({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }));
    json([{ name: "lint", state: "SUCCESS", bucket: "pass", link: "https://ci/lint" }]);
    const gh = new GitHubService({ bus, exec });

    const snap = await gh.pollPrState(REPO, 42);

    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["api", "graphql"],
      ["pr", "checks"],
    ]);
    expect(snap?.checks).toEqual([
      { name: "lint", status: "completed", conclusion: "success", url: "https://ci/lint" },
    ]);
  });

  it("returns null for a GraphQL `errors` payload — a failed read, not an empty one", async () => {
    // GraphQL reports failures IN the body. Reading that as "no reviewers, no
    // threads, no checks" is the false-confidence bug the review-queue code
    // exists to prevent.
    const { exec, json } = makeExec();
    json({ errors: [{ message: "Something went wrong" }] });
    const gh = new GitHubService({ bus, exec });

    expect(await gh.pollPrState(REPO, 42)).toBeNull();
  });

  it("returns null for an unknown PR", async () => {
    const { exec, json } = makeExec();
    json({ data: { repository: { pullRequest: null } } });
    const gh = new GitHubService({ bus, exec });

    expect(await gh.pollPrState(REPO, 999)).toBeNull();
  });

  it("carries threads with their excerpt, link and resolve state", async () => {
    const { exec, json } = makeExec();
    json(
      pollPayload({
        reviewThreads: {
          nodes: [
            {
              id: "PRRT_1",
              isResolved: false,
              isOutdated: false,
              path: "src/app.ts",
              line: 12,
              comments: {
                nodes: [
                  {
                    author: { login: "copilot" },
                    body: "this leaks",
                    url: "https://github.com/octocat/hello/pull/42#discussion_r1",
                    createdAt: "2026-08-02T00:00:00Z",
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const gh = new GitHubService({ bus, exec });

    expect((await gh.pollPrState(REPO, 42))?.threads).toEqual([
      {
        id: "PRRT_1",
        isResolved: false,
        isOutdated: false,
        path: "src/app.ts",
        line: 12,
        author: "copilot",
        body: "this leaks",
        url: "https://github.com/octocat/hello/pull/42#discussion_r1",
        createdAt: "2026-08-02T00:00:00Z",
      },
    ]);
  });

  it("drops the zero-time sentinel GitHub emits for an unmerged PR", async () => {
    const { exec, json } = makeExec();
    json(pollPayload({ mergedAt: "0001-01-01T00:00:00Z", state: "MERGED", merged: true }));
    const gh = new GitHubService({ bus, exec });

    const snap = await gh.pollPrState(REPO, 42);
    expect(snap?.state).toBe("merged");
    expect(snap?.mergedAt).toBeUndefined();
  });
});

const RUN_JSON_FIELDS_EXPECTED =
  "databaseId,name,workflowName,status,conclusion,event,headBranch,url,createdAt,updatedAt";
const PR_LIST_JSON_FIELDS_EXPECTED =
  "number,title,headRefName,state,isDraft,statusCheckRollup,reviewDecision,comments,updatedAt,url,labels";
const PR_DETAIL_JSON_FIELDS_EXPECTED =
  "number,url,title,state,headRefName,baseRefName,isDraft,author,body,mergeable,mergeStateStatus,labels,additions,deletions,updatedAt,createdAt,statusCheckRollup,reviewDecision,comments";

/* ------------------------------------------------------------- submitReview */

describe("submitReview — how Dispatch's reviewer speaks", () => {
  /**
   * The payload goes over a temp FILE (`gh api --input`), because `comments` is
   * an array of objects and `gh`'s `-f` flags cannot express one. So the mock
   * reads it back at call time — the real service deletes the directory the
   * moment the call returns.
   */
  function makeReviewExec() {
    const bodies: unknown[] = [];
    const queue: ExecResult[] = [];
    const calls: Call[] = [];
    const exec: ExecaLike = async (file, args = [], options) => {
      calls.push({ file, args: [...args], options: options as Call["options"] });
      const i = args.indexOf("--input");
      if (i >= 0) bodies.push(JSON.parse(await readFile(args[i + 1] as string, "utf8")));
      return queue.shift() ?? { stdout: "{}", exitCode: 0 };
    };
    const push = (r: Partial<ExecResult>) => queue.push({ stdout: "{}", exitCode: 0, ...r });
    return { exec, calls, bodies, push };
  }

  it("posts as the dedicated account when given its token, and as you without one", async () => {
    // The identity switch is one environment variable. GH_TOKEN outranks both
    // GITHUB_TOKEN and the hosts.yml login, so this is what makes the review
    // carry the bot's name — and its absence is what keeps every OTHER call in
    // this service attributed to the human.
    const withToken = makeReviewExec();
    withToken.push({ stdout: "{}" });
    await new GitHubService({ bus, exec: withToken.exec }).submitReview(
      REPO,
      7,
      { event: "COMMENT", body: "hi" },
      { token: "github_pat_secret" },
    );
    expect(withToken.calls[0].options?.env?.GH_TOKEN).toBe("github_pat_secret");

    const without = makeReviewExec();
    without.push({ stdout: "{}" });
    await new GitHubService({ bus, exec: without.exec }).submitReview(REPO, 7, {
      event: "COMMENT",
      body: "hi",
    });
    // Not an empty env — undefined, so the child simply inherits rather than
    // being handed a scrubbed environment with no PATH.
    expect(without.calls[0].options?.env).toBeUndefined();
  });

  it("posts the verdict, the summary and one inline comment per finding", async () => {
    const { exec, calls, bodies, push } = makeReviewExec();
    push({ stdout: JSON.stringify({ html_url: "https://github.com/o/r/pull/7#r1" }) });
    const gh = new GitHubService({ bus, exec });

    const res = await gh.submitReview(REPO, 7, {
      event: "REQUEST_CHANGES",
      body: "One real problem.",
      commitId: "deadbeef",
      comments: [
        { path: "src/a.ts", line: 12, body: "null on the empty case" },
        { path: "src/b.ts", line: 40, startLine: 38, side: "RIGHT", body: "unawaited promise" },
      ],
    });

    expect(res).toMatchObject({ posted: true, event: "REQUEST_CHANGES" });
    expect(res.url).toContain("#r1");
    expect(calls[0].args.slice(0, 4)).toEqual([
      "api",
      "--method",
      "POST",
      `repos/${REPO}/pulls/7/reviews`,
    ]);
    expect(bodies[0]).toEqual({
      event: "REQUEST_CHANGES",
      body: "One real problem.",
      commit_id: "deadbeef",
      comments: [
        { path: "src/a.ts", line: 12, side: "RIGHT", body: "null on the empty case" },
        {
          path: "src/b.ts",
          line: 40,
          start_line: 38,
          side: "RIGHT",
          body: "unawaited promise",
        },
      ],
    });
  });

  it("downgrades to COMMENT on your own PR, and says that it did", async () => {
    // The ordinary case while Dispatch posts under the human's own token —
    // GitHub refuses APPROVE/REQUEST_CHANGES on a PR you authored. The comments
    // still land, and the open threads still block the merge.
    const { exec, bodies, push } = makeReviewExec();
    push({
      exitCode: 1,
      stderr: "HTTP 422: Can not request changes on your own pull request",
    });
    push({ stdout: JSON.stringify({ html_url: "u" }) });
    const gh = new GitHubService({ bus, exec });

    const res = await gh.submitReview(REPO, 7, {
      event: "REQUEST_CHANGES",
      body: "problem",
      comments: [{ path: "a.ts", line: 1, body: "here" }],
    });

    expect(res).toMatchObject({ posted: true, event: "COMMENT" });
    expect((bodies[1] as { event: string }).event).toBe("COMMENT");
    // The findings survive the downgrade — that is the point of retrying.
    expect((bodies[1] as { comments: unknown[] }).comments).toHaveLength(1);
  });

  it("folds the findings into the summary when GitHub rejects their lines", async () => {
    // GitHub rejects the WHOLE review over one bad line number. Losing a good
    // review to a misremembered offset is the failure worth degrading for.
    const { exec, bodies, push } = makeReviewExec();
    push({
      exitCode: 1,
      stderr: "HTTP 422: line must be part of the diff",
    });
    push({ stdout: JSON.stringify({ html_url: "u" }) });
    const gh = new GitHubService({ bus, exec });

    const res = await gh.submitReview(REPO, 7, {
      event: "COMMENT",
      body: "Summary.",
      comments: [{ path: "src/a.ts", line: 999, body: "null on the empty case" }],
    });

    expect(res).toMatchObject({ posted: true, droppedComments: 1 });
    const folded = bodies[1] as { body: string; comments?: unknown };
    expect(folded.comments).toBeUndefined();
    expect(folded.body).toContain("Summary.");
    expect(folded.body).toContain("src/a.ts:999");
    expect(folded.body).toContain("null on the empty case");
  });

  it("reports a refusal rather than throwing", async () => {
    const { exec, push } = makeReviewExec();
    push({ exitCode: 1, stderr: "HTTP 403: Resource not accessible by integration" });
    const gh = new GitHubService({ bus, exec });

    const res = await gh.submitReview(REPO, 7, { event: "COMMENT", body: "hi" });
    expect(res.posted).toBe(false);
    expect(res.error).toContain("403");
  });
});
