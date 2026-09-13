import { describe, expect, it } from "vitest";
import type { Project } from "@dispatch/shared";
import type { ExecaLike, ExecResult } from "../github.js";
import { GitHubIssueProvider } from "./github.js";
import { IssueService, redactRemote } from "./service.js";

type Call = { file: string; args: readonly string[]; cwd?: string };

function fakeExec(respond: (c: Call) => Partial<ExecResult>): { exec: ExecaLike; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecaLike = async (file, args = [], opts) => {
    const call = { file, args, cwd: opts?.cwd };
    calls.push(call);
    return { stdout: "", stderr: "", exitCode: 0, ...respond(call) };
  };
  return { exec, calls };
}

const rawIssue = (over: Record<string, unknown> = {}) => ({
  number: 3,
  title: "Broken",
  body: null,
  state: "open",
  html_url: "https://github.com/acme/api/issues/3",
  user: { login: "alice", type: "User" },
  author_association: "COLLABORATOR",
  labels: [{ name: "bug" }],
  assignees: [],
  comments: 2,
  created_at: "2026-09-13T00:00:00Z",
  updated_at: "2026-09-13T00:00:00Z",
  ...over,
});

const src = { provider: "github" as const, repo: "acme/api" };

describe("GitHubIssueProvider", () => {
  it("lists newest-first through REST and drops pull requests", async () => {
    const { exec, calls } = fakeExec(() => ({
      stdout: JSON.stringify([rawIssue(), rawIssue({ number: 4, pull_request: {} })]),
    }));
    const issues = await new GitHubIssueProvider(exec).list(src, { limit: 500 });
    expect(issues.map((i) => i.number)).toEqual([3]);
    expect(issues[0]).toMatchObject({ authorTrust: "collaborator", labels: ["bug"], body: "", authorIsBot: false });
    expect(calls[0].args).toEqual([
      "api", "-X", "GET", "repos/acme/api/issues",
      "-f", "state=open", "-f", "sort=created", "-f", "direction=desc", "-f", "per_page=100",
    ]);
  });

  it("reaches an Enterprise source with --hostname", async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: "[]" }));
    await new GitHubIssueProvider(exec).list({ ...src, host: "github.corp" });
    expect(calls[0].args.slice(0, 3)).toEqual(["api", "--hostname", "github.corp"]);
  });

  it("maps bots and outsiders onto the neutral trust scale", async () => {
    const { exec } = fakeExec(() => ({
      stdout: JSON.stringify([
        rawIssue({ user: { login: "renovate[bot]", type: "Bot" }, author_association: "NONE" }),
        rawIssue({ author_association: "FIRST_TIME_CONTRIBUTOR" }),
      ]),
    }));
    const [bot, first] = await new GitHubIssueProvider(exec).list(src);
    expect(bot).toMatchObject({ authorIsBot: true, authorTrust: "none" });
    expect(first.authorTrust).toBe("contributor");
  });

  it("answers null for a missing issue and for a PR number", async () => {
    const missing = fakeExec(() => ({ exitCode: 1, stderr: "gh: Not Found (HTTP 404)" }));
    expect(await new GitHubIssueProvider(missing.exec).get(src, 9)).toBeNull();
    const pr = fakeExec(() => ({ stdout: JSON.stringify(rawIssue({ pull_request: {} })) }));
    expect(await new GitHubIssueProvider(pr.exec).get(src, 3)).toBeNull();
  });

  it("surfaces any other gh failure instead of reading it as not-found", async () => {
    const { exec } = fakeExec(() => ({ exitCode: 1, stderr: "HTTP 401: Bad credentials" }));
    await expect(new GitHubIssueProvider(exec).get(src, 9)).rejects.toThrow("Bad credentials");
  });

  it("passes a comment body as a raw field, so a leading @ is never read as a file", async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: JSON.stringify({ id: 11, html_url: "u" }) }));
    expect(await new GitHubIssueProvider(exec).comment(src, 3, "@/etc/passwd")).toEqual({ id: "11", url: "u" });
    expect(calls[0].args).toEqual(["api", "-X", "POST", "repos/acme/api/issues/3/comments", "-f", "body=@/etc/passwd"]);
  });

  it("applies a patch as separate calls and tolerates removing an absent label", async () => {
    const { exec, calls } = fakeExec((c) => {
      if (c.args.includes("DELETE")) return { exitCode: 1, stderr: "Label does not exist (HTTP 404)" };
      return { stdout: JSON.stringify(rawIssue({ state: "closed" })) };
    });
    const out = await new GitHubIssueProvider(exec).update(src, 3, {
      state: "closed",
      stateReason: "not_planned",
      addLabels: ["dispatch:working"],
      removeLabels: ["needs triage"],
    });
    expect(out.state).toBe("closed");
    expect(calls.map((c) => c.args.slice(1, 4).join(" "))).toEqual([
      "-X PATCH repos/acme/api/issues/3",
      "-X POST repos/acme/api/issues/3/labels",
      "-X DELETE repos/acme/api/issues/3/labels/needs%20triage",
      "repos/acme/api/issues/3",
    ]);
    expect(calls[0].args).toContain("state_reason=not_planned");
    expect(calls[1].args).toContain("labels[]=dispatch:working");
  });

  it("refuses a malformed repo before building a URL from it", async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: "[]" }));
    await expect(new GitHubIssueProvider(exec).list({ provider: "github", repo: "../../user" })).rejects.toThrow(
      "invalid repo",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("IssueService", () => {
  const project = { id: "p1", repoPath: "/repo" } as Project;

  it("prefers an authored source over origin, without asking git", async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: "git@github.com:acme/api.git" }));
    const svc = new IssueService({
      exec,
      getProject: async () => project,
      getConfig: () => ({ source: { provider: "github", repo: "upstream/api" } }),
    });
    expect(await svc.sourceFor("p1")).toEqual({ source: { provider: "github", repo: "upstream/api" }, from: "config" });
    expect(calls).toHaveLength(0);
  });

  it("falls back to origin, read in the project's checkout", async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: "https://github.com/acme/api.git\n" }));
    const svc = new IssueService({ exec, getProject: async () => project, getConfig: () => null });
    expect(await svc.sourceFor("p1")).toEqual({ source: { provider: "github", repo: "acme/api" }, from: "origin" });
    expect(calls[0]).toMatchObject({ file: "git", args: ["remote", "get-url", "origin"], cwd: "/repo" });
  });

  it("is null for a project with no remote a provider claims", async () => {
    const none = fakeExec(() => ({ exitCode: 2, stderr: "error: No such remote 'origin'" }));
    const svc = new IssueService({ exec: none.exec, getProject: async () => project, getConfig: () => null });
    expect(await svc.sourceFor("p1")).toBeNull();
    expect(await svc.forProject("p1")).toBeNull();
  });

  it("never hands a credential in origin back to the caller", async () => {
    const { exec } = fakeExec(() => ({ stdout: "https://x-access-token:ghp_secret@github.com/acme/api.git" }));
    const svc = new IssueService({ exec, getProject: async () => project, getConfig: () => null });
    const detected = await svc.detect("/repo");
    expect(detected.remote).toBe("https://github.com/acme/api.git");
    expect(JSON.stringify(detected)).not.toContain("ghp_secret");
  });

  it("redacts user-info only from URL-style remotes", () => {
    expect(redactRemote("git@github.com:acme/api.git")).toBe("git@github.com:acme/api.git");
    expect(redactRemote("ssh://git@github.com/acme/api.git")).toBe("ssh://github.com/acme/api.git");
  });
});
