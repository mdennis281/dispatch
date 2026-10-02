import { describe, expect, it } from "vitest";
import type { CheckRun } from "@dispatch/shared";
import { checkIsFailing, checksVerdict, summarizeChecks } from "./checks.js";

const run = (over: Partial<CheckRun>): CheckRun =>
  ({ name: "job", status: "completed", conclusion: "success", ...over }) as CheckRun;

describe("checkIsFailing", () => {
  it("counts the four conclusions that block a merge", () => {
    for (const conclusion of ["failure", "timed_out", "cancelled", "action_required"] as const) {
      expect(checkIsFailing(run({ conclusion }))).toBe(true);
    }
  });

  it("does not count a check that declined to have an opinion", () => {
    expect(checkIsFailing(run({ conclusion: "skipped" }))).toBe(false);
    expect(checkIsFailing(run({ conclusion: "neutral" }))).toBe(false);
  });

  it("does not count a job that has not finished, whatever its conclusion field says", () => {
    expect(checkIsFailing(run({ status: "queued", conclusion: null }))).toBe(false);
    expect(checkIsFailing(run({ status: "in_progress", conclusion: "failure" }))).toBe(false);
  });
});

describe("checksVerdict", () => {
  it("reads no runs as 'no checks', NOT as green", () => {
    expect(checksVerdict(summarizeChecks([]))).toEqual({ tone: "muted", label: "no checks" });
  });

  it("lets a failure win over a job still running", () => {
    const v = checksVerdict(
      summarizeChecks([run({ conclusion: "failure" }), run({ status: "in_progress" })]),
    );
    expect(v).toEqual({ tone: "danger", label: "failing" });
  });

  it("reports running while anything is pending", () => {
    const v = checksVerdict(summarizeChecks([run({}), run({ status: "queued" })]));
    expect(v).toEqual({ tone: "warn", label: "running" });
  });

  it("passes only when every run finished without blocking", () => {
    const v = checksVerdict(summarizeChecks([run({}), run({ conclusion: "skipped" })]));
    expect(v).toEqual({ tone: "success", label: "passing" });
  });
});
