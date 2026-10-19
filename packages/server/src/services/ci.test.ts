import { describe, it, expect } from "vitest";
import type { Project } from "@dispatch/shared";
import { CiService, CiNotFoundError, CiUnavailableError, LOG_CAP_BYTES } from "./ci.js";
import type { ExecResult, ExecaLike } from "./github.js";

/* ---------------------------------------------------------------- harness */

/**
 * An exec fake that answers by matching the gh argv, not by queue order — the
 * service fires reads concurrently, so the order they reach exec isn't a
 * contract worth pinning.
 */
function makeExec(routes: Array<[RegExp, Partial<ExecResult> | (() => Partial<ExecResult>)]>) {
  const calls: string[][] = [];
  const exec: ExecaLike = async (_file, args = []) => {
    calls.push([...args]);
    const line = args.join(" ");
    for (const [re, res] of routes) {
      if (re.test(line)) return { stdout: "", exitCode: 0, ...(typeof res === "function" ? res() : res) };
    }
    return { stdout: "", exitCode: 1, stderr: `unrouted: ${line}` };
  };
  return { exec, calls };
}

const json = (v: unknown): Partial<ExecResult> => ({ stdout: JSON.stringify(v), exitCode: 0 });
const notFound: Partial<ExecResult> = {
  stdout: '{"message":"Not Found"}',
  stderr: "gh: Not Found (HTTP 404)",
  exitCode: 1,
};

const REPO = "octocat/hello";
const project = { id: "p1", repoPath: "/repo" } as Project;

function service(exec: ExecaLike, resolveRepo = async () => REPO, now = () => 0) {
  return new CiService({ exec, resolveRepo, now });
}

function rawRun(over: Record<string, unknown> = {}) {
  return {
    id: 100,
    run_number: 7,
    run_attempt: 2,
    workflow_id: 1,
    name: "CI",
    display_title: "feat: thing",
    status: "completed",
    conclusion: "failure",
    event: "pull_request",
    head_branch: "feat/thing",
    head_sha: "abc123",
    actor: { login: "author" },
    triggering_actor: { login: "rerunner" },
    pull_requests: [{ number: 42 }],
    html_url: "https://github.com/octocat/hello/actions/runs/100",
    created_at: "2026-10-01T00:00:00Z",
    run_started_at: "2026-10-01T00:05:00Z",
    updated_at: "2026-10-01T00:10:00Z",
    ...over,
  };
}

/* ------------------------------------------------------------------ tests */

describe("CiService repo resolution", () => {
  it("caches owner/name per project, and re-resolves after the TTL", async () => {
    let resolves = 0;
    let t = 0;
    const { exec } = makeExec([[/actions\/runs\/100$/, json(rawRun())]]);
    const ci = service(
      exec,
      async () => {
        resolves++;
        return REPO;
      },
      () => t,
    );
    await ci.run(project, 100);
    await ci.run(project, 100);
    expect(resolves).toBe(1);
    t = 6 * 60_000;
    await ci.run(project, 100);
    expect(resolves).toBe(2);
  });

  it("reports a project with no GitHub remote as unavailable, and doesn't cache the failure", async () => {
    let fail = true;
    const { exec } = makeExec([[/actions\/runs\/100$/, json(rawRun())]]);
    const ci = service(exec, async () => {
      if (fail) throw new Error("no git remotes found");
      return REPO;
    });
    await expect(ci.summary(project)).rejects.toBeInstanceOf(CiUnavailableError);
    fail = false;
    expect(await ci.summary(project)).toEqual({
      provider: "github-actions",
      repo: REPO,
      url: `https://github.com/${REPO}/actions`,
    });
  });
});

describe("CiService reads", () => {
  it("maps a run, preferring the actor who triggered THIS attempt", async () => {
    const { exec } = makeExec([[/actions\/runs\/100$/, json(rawRun())]]);
    const run = await service(exec).run(project, 100);
    expect(run).toMatchObject({
      id: 100,
      number: 7,
      attempt: 2,
      title: "feat: thing",
      workflowName: "CI",
      conclusion: "failure",
      branch: "feat/thing",
      sha: "abc123",
      actor: "rerunner",
      prNumbers: [42],
    });
  });

  it("passes filters and pagination through, scoping to a workflow when asked", async () => {
    const { exec, calls } = makeExec([
      [/actions\/workflows\/5\/runs/, json({ total_count: 61, workflow_runs: [rawRun()] })],
    ]);
    const page = await service(exec).runs(project, {
      workflowId: 5,
      branch: "main",
      status: "failure",
      page: 3,
      perPage: 20,
    });
    expect(page).toMatchObject({ totalCount: 61, page: 3, perPage: 20 });
    expect(page.runs).toHaveLength(1);
    const path = calls[0][1];
    expect(path.startsWith(`repos/${REPO}/actions/workflows/5/runs?`)).toBe(true);
    const q = new URLSearchParams(path.split("?")[1]);
    expect(Object.fromEntries(q)).toEqual({
      per_page: "20",
      page: "3",
      branch: "main",
      status: "failure",
    });
  });

  it("clamps perPage to the API's ceiling", async () => {
    const { exec, calls } = makeExec([[/actions\/runs\?/, json({ total_count: 0, workflow_runs: [] })]]);
    await service(exec).runs(project, { perPage: 500 });
    expect(calls[0][1]).toContain("per_page=100");
  });

  it("refuses a non-integer id rather than interpolating it into the path", async () => {
    const { exec, calls } = makeExec([]);
    await expect(service(exec).run(project, Number("1/../../x"))).rejects.toThrow(/invalid run id/);
    expect(calls).toHaveLength(0);
  });

  it("attaches each workflow's latest run, and marks provider-managed ones", async () => {
    const { exec } = makeExec([
      [
        /actions\/workflows\?/,
        json({
          workflows: [
            { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active", html_url: "u1" },
            { id: 2, name: "Release", path: ".github/workflows/release.yml", state: "active" },
            { id: 3, name: "Copilot", path: "dynamic/copilot", state: "active", html_url: "u3" },
          ],
        }),
      ],
      [
        /actions\/runs\?/,
        json({
          workflow_runs: [
            rawRun({ id: 300, workflow_id: 1, conclusion: "success" }),
            rawRun({ id: 200, workflow_id: 1, conclusion: "failure" }),
          ],
        }),
      ],
    ]);
    const wfs = await service(exec).workflows(project);
    expect(wfs.map((w) => [w.name, w.managed, w.lastRun?.id ?? w.lastRun])).toEqual([
      ["CI", false, 300],
      ["Release", false, null],
      ["Copilot", true, null],
    ]);
    // A managed workflow has no file page to link to.
    expect(wfs[2].url).toBeNull();
  });

  it("still returns workflows when the recent-runs read fails — lastRun absent, not null", async () => {
    const { exec } = makeExec([
      [/actions\/workflows\?/, json({ workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml" }] })],
      [/actions\/runs\?/, { exitCode: 1, stderr: "gh: Server Error (HTTP 502)" }],
    ]);
    const [wf] = await service(exec).workflows(project);
    expect(wf.name).toBe("CI");
    expect("lastRun" in wf).toBe(false);
  });

  it("asks for the latest attempt's jobs and maps their steps", async () => {
    const { exec, calls } = makeExec([
      [
        /runs\/100\/jobs/,
        json({
          jobs: [
            {
              id: 9,
              name: "build",
              status: "completed",
              conclusion: "success",
              labels: ["self-hosted"],
              steps: [{ number: 1, name: "Set up job", status: "completed", conclusion: "success" }],
            },
          ],
        }),
      ],
    ]);
    const [job] = await service(exec).jobs(project, 100);
    expect(calls[0][1]).toContain("filter=latest");
    expect(job).toMatchObject({ id: 9, labels: ["self-hosted"], runnerName: null });
    expect(job.steps[0]).toMatchObject({ number: 1, name: "Set up job", startedAt: null });
  });
});

describe("CiService job logs", () => {
  it("strips the BOM", async () => {
    const { exec } = makeExec([[/jobs\/9\/logs/, { stdout: "﻿2026-10-01T00:00:00Z hello" }]]);
    expect(await service(exec).jobLog(project, 9)).toEqual({
      available: true,
      text: "2026-10-01T00:00:00Z hello",
      truncated: false,
    });
  });

  it("reports a running job's missing log as unavailable, not as an error", async () => {
    const { exec } = makeExec([[/jobs\/9\/logs/, notFound]]);
    expect(await service(exec).jobLog(project, 9)).toEqual({
      available: false,
      text: "",
      truncated: false,
    });
  });

  it("keeps the tail of an oversized log, starting on a whole line", async () => {
    const line = "2026-10-01T00:00:00.0000000Z " + "x".repeat(70) + "\n";
    const big = line.repeat(Math.ceil((LOG_CAP_BYTES * 1.5) / line.length)) + "THE END";
    const { exec } = makeExec([[/jobs\/9\/logs/, { stdout: big }]]);
    const log = await service(exec).jobLog(project, 9);
    expect(log.truncated).toBe(true);
    expect(log.text.length).toBeLessThanOrEqual(LOG_CAP_BYTES);
    expect(log.text.startsWith("2026-10-01T")).toBe(true);
    expect(log.text.endsWith("THE END")).toBe(true);
  });
});

describe("CiService dispatch", () => {
  const wf = { id: 4, name: "Promote", path: ".github/workflows/promote.yml" };

  it("reads the workflow file to learn whether it can be run by hand", async () => {
    const { exec, calls } = makeExec([
      [/actions\/workflows\/4$/, json(wf)],
      [
        /contents\/\.github\/workflows\/promote\.yml/,
        {
          stdout: [
            "on:",
            "  workflow_dispatch:",
            "    inputs:",
            "      tag:",
            "        required: true",
            "        type: string",
          ].join("\n"),
        },
      ],
    ]);
    const info = await service(exec).dispatchInfo(project, 4);
    expect(info.dispatchable).toBe(true);
    expect(info.inputs).toMatchObject([{ name: "tag", required: true, type: "string" }]);
    expect(calls[1]).toContain("Accept: application/vnd.github.raw");
  });

  it("says a push-only workflow is not dispatchable", async () => {
    const { exec } = makeExec([
      [/actions\/workflows\/4$/, json(wf)],
      [/contents\//, { stdout: "on:\n  push:\n    branches: [main]\n" }],
    ]);
    expect(await service(exec).dispatchInfo(project, 4)).toEqual({ dispatchable: false, inputs: [] });
  });

  it("accepts every spelling of the trigger", async () => {
    for (const on of ["on: workflow_dispatch", "on: [push, workflow_dispatch]", "on:\n  workflow_dispatch:\n"]) {
      const { exec } = makeExec([
        [/actions\/workflows\/4$/, json(wf)],
        [/contents\//, { stdout: on }],
      ]);
      expect((await service(exec).dispatchInfo(project, 4)).dispatchable, on).toBe(true);
    }
  });

  it("never tries to read a file for a provider-managed workflow", async () => {
    const { exec, calls } = makeExec([
      [/actions\/workflows\/4$/, json({ id: 4, name: "Copilot", path: "dynamic/copilot" })],
    ]);
    expect(await service(exec).dispatchInfo(project, 4)).toEqual({ dispatchable: false, inputs: [] });
    expect(calls).toHaveLength(1);
  });

  it("posts the ref and inputs as raw strings", async () => {
    const { exec, calls } = makeExec([[/dispatches /, {}]]);
    await service(exec).dispatch(project, 4, " main ", { tag: "v1", dry: "true" });
    expect(calls[0]).toEqual([
      "api",
      "-X",
      "POST",
      `repos/${REPO}/actions/workflows/4/dispatches`,
      "-f",
      "ref=main",
      "-f",
      "inputs[tag]=v1",
      "-f",
      "inputs[dry]=true",
    ]);
  });

  it("rejects an input name that could break out of the inputs[] key", async () => {
    const { exec, calls } = makeExec([]);
    await expect(service(exec).dispatch(project, 4, "main", { "a]=x&b[": "1" })).rejects.toThrow(
      /invalid input name/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("CiService acts", () => {
  it("re-runs everything, or only the failed jobs", async () => {
    const { exec, calls } = makeExec([[/./, {}]]);
    const ci = service(exec);
    await ci.rerun(project, 100);
    await ci.rerun(project, 100, { failedOnly: true });
    await ci.rerunJob(project, 9);
    await ci.cancel(project, 100);
    expect(calls.map((c) => c[3])).toEqual([
      `repos/${REPO}/actions/runs/100/rerun`,
      `repos/${REPO}/actions/runs/100/rerun-failed-jobs`,
      `repos/${REPO}/actions/jobs/9/rerun`,
      `repos/${REPO}/actions/runs/100/cancel`,
    ]);
  });

  it("surfaces the API's own message, and 404s as not-found", async () => {
    const { exec } = makeExec([
      [
        /cancel$/,
        {
          exitCode: 1,
          stdout: '{"message":"Cannot cancel a workflow run that is completed."}',
          stderr: "gh: Cannot cancel a workflow run that is completed. (HTTP 409)",
        },
      ],
      [/rerun$/, notFound],
    ]);
    const ci = service(exec);
    await expect(ci.cancel(project, 100)).rejects.toThrow(
      "Cannot cancel a workflow run that is completed. (HTTP 409)",
    );
    await expect(ci.rerun(project, 100)).rejects.toBeInstanceOf(CiNotFoundError);
  });
});
