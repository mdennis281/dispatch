import { describe, expect, it } from "vitest";
import {
  IssueConfigSchema,
  detectIssueSource,
  issueKey,
  matchIssue,
  parseGitRemote,
  resolveIssuePolicy,
  type Issue,
} from "./issues.js";

const issue = (over: Partial<Issue> = {}): Issue => ({
  number: 7,
  title: "Crash on launch",
  body: "",
  state: "open",
  url: "https://github.com/acme/api/issues/7",
  author: "alice",
  authorTrust: "owner",
  authorIsBot: false,
  labels: [],
  assignees: [],
  commentCount: 0,
  createdAt: "2026-09-13T00:00:00Z",
  updatedAt: "2026-09-13T00:00:00Z",
  ...over,
});

describe("parseGitRemote", () => {
  it("reads https, ssh and scp-style remotes as the same repo", () => {
    for (const url of [
      "https://github.com/acme/api.git",
      "https://github.com/acme/api",
      "ssh://git@github.com/acme/api.git",
      "git@github.com:acme/api.git",
    ]) {
      expect(parseGitRemote(url)).toEqual({ host: "github.com", path: "acme/api" });
    }
  });

  it("drops embedded credentials rather than carrying them into the host", () => {
    expect(parseGitRemote("https://x-access-token:ghp_abc@github.com/acme/api.git")).toEqual({
      host: "github.com",
      path: "acme/api",
    });
  });

  it("refuses a local path", () => {
    expect(parseGitRemote("C:\\repos\\api")).not.toMatchObject({ path: "acme/api" });
    expect(parseGitRemote("")).toBeNull();
  });
});

describe("detectIssueSource", () => {
  it("maps github.com, including the port-443 ssh endpoint, to the public host", () => {
    expect(detectIssueSource("git@github.com:acme/api.git")).toEqual({ provider: "github", repo: "acme/api" });
    expect(detectIssueSource("ssh://git@ssh.github.com:443/acme/api.git")).toEqual({
      provider: "github",
      repo: "acme/api",
    });
  });

  it("guesses an Enterprise host only when it says github", () => {
    expect(detectIssueSource("https://github.corp.example/acme/api")).toEqual({
      provider: "github",
      host: "github.corp.example",
      repo: "acme/api",
    });
    // A self-hosted GitLab must not be pointed at the GitHub API.
    expect(detectIssueSource("git@git.example.com:acme/api.git")).toBeNull();
  });

  it("refuses a nested group path no github repo can have", () => {
    expect(detectIssueSource("https://github.com/acme/group/api")).toBeNull();
  });
});

describe("issueKey", () => {
  it("keeps the host in the key so two trackers' #12 never collide", () => {
    expect(issueKey({ provider: "github", repo: "acme/api" }, 12)).toBe("github:acme/api#12");
    expect(issueKey({ provider: "github", host: "github.corp", repo: "acme/api" }, 12)).toBe(
      "github@github.corp:acme/api#12",
    );
  });
});

describe("IssueConfigSchema", () => {
  it("rejects an invalid title regex at load time", () => {
    expect(IssueConfigSchema.safeParse({ filters: { titlePattern: "(" } }).success).toBe(false);
  });

  it("clamps the poll interval", () => {
    expect(IssueConfigSchema.safeParse({ intervalMinutes: 1 }).success).toBe(false);
    expect(IssueConfigSchema.safeParse({ intervalMinutes: 60 }).success).toBe(true);
  });
});

describe("resolveIssuePolicy", () => {
  it("is off, triage, and trust-gated by default", () => {
    const p = resolveIssuePolicy(undefined);
    expect(p).toMatchObject({ enabled: false, mode: "triage", intervalMinutes: 60, claimLabel: "dispatch:working" });
    expect(p.filters.trust).toEqual(["owner", "member", "collaborator"]);
  });

  it("keeps the trust gate when a filters block names only labels", () => {
    expect(resolveIssuePolicy({ filters: { labels: ["bug"] } }).filters.trust).toEqual([
      "owner",
      "member",
      "collaborator",
    ]);
  });
});

describe("matchIssue", () => {
  const policy = resolveIssuePolicy({ enabled: true });

  it("admits a trusted author's unassigned open issue", () => {
    expect(matchIssue(issue(), policy)).toEqual({ ok: true });
  });

  it("refuses an outsider by default and says why", () => {
    const r = matchIssue(issue({ author: "mallory", authorTrust: "none" }), policy);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("mallory is none") });
  });

  it("lets a named author through the trust gate, and an exclusion beat both", () => {
    const named = resolveIssuePolicy({ filters: { authors: ["Mallory"] } });
    expect(matchIssue(issue({ author: "mallory", authorTrust: "none" }), named).ok).toBe(true);
    const both = resolveIssuePolicy({ filters: { authors: ["mallory"], excludeAuthors: ["MALLORY"] } });
    expect(matchIssue(issue({ author: "mallory", authorTrust: "owner" }), both).ok).toBe(false);
  });

  it("skips an issue that already carries the claim label, case-insensitively", () => {
    expect(matchIssue(issue({ labels: ["Dispatch:Working"] }), policy)).toEqual({
      ok: false,
      reason: "already claimed (dispatch:working)",
    });
  });

  it("skips bots, assigned issues, excluded labels and non-matching titles", () => {
    expect(matchIssue(issue({ authorIsBot: true }), policy).ok).toBe(false);
    expect(matchIssue(issue({ assignees: ["bob"] }), policy).ok).toBe(false);
    const p = resolveIssuePolicy({ filters: { excludeLabels: ["wontfix"], titlePattern: "^crash" } });
    expect(matchIssue(issue({ labels: ["WONTFIX"] }), p).ok).toBe(false);
    expect(matchIssue(issue({ title: "Feature: dark mode" }), p).ok).toBe(false);
    expect(matchIssue(issue(), p).ok).toBe(true);
  });

  it("requires any one of the listed labels", () => {
    const p = resolveIssuePolicy({ filters: { labels: ["bug", "agent"] } });
    expect(matchIssue(issue(), p).ok).toBe(false);
    expect(matchIssue(issue({ labels: ["Agent"] }), p).ok).toBe(true);
  });
});
