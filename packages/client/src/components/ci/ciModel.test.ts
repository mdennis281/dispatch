import { describe, it, expect } from "vitest";
import type { CiRun } from "@dispatch/shared";
import {
  appendRuns,
  ciElapsed,
  ciVisual,
  firstLineAt,
  flattenLog,
  mergeRuns,
  parseLog,
  runElapsed,
  statusParam,
} from "./ciModel.js";
import { collectInputValues, missingInputs, seedInputValues } from "./DispatchInputs.js";
import { runnableWorkflows } from "./CiDispatchModal.js";
import { sortWorkflows } from "./CiWorkflowRail.js";

function run(id: number, createdAt: string, over: Partial<CiRun> = {}): CiRun {
  return {
    id,
    number: id,
    attempt: 1,
    workflowId: 1,
    workflowName: "CI",
    title: `run ${id}`,
    status: "completed",
    conclusion: "success",
    event: "push",
    branch: "main",
    sha: "abc",
    actor: null,
    prNumbers: [],
    url: "",
    createdAt,
    startedAt: createdAt,
    updatedAt: createdAt,
    ...over,
  };
}

describe("ciVisual", () => {
  it("spins only while in progress, and reads a waiting run as needing a human", () => {
    expect(ciVisual({ status: "in_progress", conclusion: null })).toMatchObject({ spin: true, tone: "accent" });
    expect(ciVisual({ status: "queued", conclusion: null })).toMatchObject({ spin: false, label: "Queued" });
    expect(ciVisual({ status: "waiting", conclusion: null }).tone).toBe("warn");
  });

  it("maps every conclusion to a tone", () => {
    const tone = (c: CiRun["conclusion"]) => ciVisual({ status: "completed", conclusion: c }).tone;
    expect(tone("success")).toBe("success");
    expect(tone("failure")).toBe("danger");
    expect(tone("timed_out")).toBe("danger");
    expect(tone("action_required")).toBe("warn");
    expect(tone("cancelled")).toBe("muted");
    expect(tone("skipped")).toBe("muted");
    expect(tone(null)).toBe("muted");
  });
});

describe("durations", () => {
  it("counts up to now while active, and refuses to invent an end otherwise", () => {
    const start = "2026-10-01T00:00:00Z";
    const now = Date.parse(start) + 90_000;
    expect(ciElapsed(start, null, true, now)).toBe(90_000);
    expect(ciElapsed(start, null, false, now)).toBeUndefined();
    expect(ciElapsed(null, null, true, now)).toBeUndefined();
    // Clock skew: an end before the start is not a negative duration.
    expect(ciElapsed(start, "2026-09-30T23:59:00Z", false, now)).toBeUndefined();
  });

  it("times a finished run from its start to its last update", () => {
    const r = run(1, "2026-10-01T00:00:00Z", {
      startedAt: "2026-10-01T00:01:00Z",
      updatedAt: "2026-10-01T00:04:30Z",
    });
    expect(runElapsed(r)).toBe(210_000);
  });
});

describe("statusParam", () => {
  it("passes conclusions through and leaves 'all' unfiltered", () => {
    expect(statusParam("all")).toBeUndefined();
    expect(statusParam("active")).toBe("in_progress");
    expect(statusParam("failure")).toBe("failure");
  });
});

describe("run list merging", () => {
  it("lets a refreshed first page win by id without dropping loaded-more rows", () => {
    const loaded = [run(3, "2026-10-03T00:00:00Z"), run(2, "2026-10-02T00:00:00Z"), run(1, "2026-10-01T00:00:00Z")];
    const fresh = [
      run(4, "2026-10-04T00:00:00Z"),
      run(3, "2026-10-03T00:00:00Z", { status: "in_progress", conclusion: null }),
    ];
    const merged = mergeRuns(loaded, fresh);
    expect(merged.map((r) => r.id)).toEqual([4, 3, 2, 1]);
    expect(merged[1]!.status).toBe("in_progress");
  });

  it("drops rows a later page repeats (runs shift down as new ones arrive)", () => {
    const a = [run(5, "2026-10-05T00:00:00Z"), run(4, "2026-10-04T00:00:00Z")];
    const b = [run(4, "2026-10-04T00:00:00Z"), run(3, "2026-10-03T00:00:00Z")];
    expect(appendRuns(a, b).map((r) => r.id)).toEqual([5, 4, 3]);
  });
});

describe("parseLog", () => {
  const LOG = [
    "\u001b[0m2026-10-01T00:00:00.1000000Z Current runner version: '2.337.0'",
    "2026-10-01T00:00:00.2000000Z ##[group]Operating System",
    "2026-10-01T00:00:00.3000000Z Ubuntu",
    "2026-10-01T00:00:00.4000000Z ##[endgroup]",
    "2026-10-01T00:00:05.5000000Z ##[group]Run pnpm test",
    "2026-10-01T00:00:05.6000000Z \u001b[36;1mpnpm test\u001b[0m",
    "2026-10-01T00:00:05.7000000Z ##[endgroup]",
    "2026-10-01T00:00:09.0000000Z \u001b[31mFAIL\u001b[39m src/a.test.ts",
    "2026-10-01T00:00:09.1000000Z ##[error]Process completed with exit code 1.",
    "",
  ].join("\r\n");

  it("strips timestamps and ANSI, keeps line numbers, and folds groups", () => {
    const blocks = parseLog(LOG);
    expect(blocks.map((b) => (b.type === "line" ? b.line.text : `[${b.title.text}]`))).toEqual([
      "Current runner version: '2.337.0'",
      "[Operating System]",
      "[Run pnpm test]",
      "FAIL src/a.test.ts",
      "Process completed with exit code 1.",
    ]);
    const group = blocks[2]!;
    expect(group.type === "group" && group.lines.map((l) => l.text)).toEqual(["pnpm test"]);
    const last = blocks[4]!;
    expect(last.type === "line" && last.line).toMatchObject({ n: 9, kind: "error" });
  });

  it("recognises the runner's bare [command] echo as a command line", () => {
    const [b] = parseLog("2026-10-01T00:00:00.0000000Z [command]/usr/bin/git version");
    expect(b?.type === "line" && b.line).toMatchObject({ text: "/usr/bin/git version", kind: "command" });
  });

  it("closes an unterminated group at the end, and an open one when another starts", () => {
    const blocks = parseLog("##[group]A\na1\n##[group]B\nb1");
    expect(blocks.map((b) => b.type === "group" && [b.title.text, b.lines.map((l) => l.text)])).toEqual([
      ["A", ["a1"]],
      ["B", ["b1"]],
    ]);
  });

  it("finds a step's first line even when the step starts mid-second", () => {
    const lines = flattenLog(parseLog(LOG));
    // The API reports whole seconds; the group title at :05.5 belongs to a step
    // that "started" at :05.
    expect(firstLineAt(lines, "2026-10-01T00:00:05Z")).toBe(5);
    expect(firstLineAt(lines, "2026-10-01T00:00:09Z")).toBe(8);
    expect(firstLineAt(lines, null)).toBeNull();
  });

  it("skips the previous step's tail when the next step's header shares its second", () => {
    const lines = flattenLog(
      parseLog(
        [
          "2026-10-01T00:00:07.1000000Z server test tail",
          "2026-10-01T00:00:07.2000000Z  Tests  312 passed",
          "2026-10-01T00:00:07.6000000Z ##[group]Run pnpm --filter client test",
          "2026-10-01T00:00:07.7000000Z ##[endgroup]",
          "2026-10-01T00:00:08.0000000Z FAIL",
        ].join("\n"),
      ),
    );
    expect(firstLineAt(lines, "2026-10-01T00:00:07Z")).toBe(3);
    expect(firstLineAt(lines, "2026-10-02T00:00:00Z")).toBeNull();
  });
});

describe("dispatch form", () => {
  const inputs = [
    { name: "tag", required: true, type: "string" as const },
    { name: "dry", type: "boolean" as const, default: "true" },
    { name: "env", type: "choice" as const, options: ["staging", "prod"] },
    { name: "note" },
  ];

  it("seeds from defaults, the first choice, and false for an undefaulted boolean", () => {
    expect(seedInputValues(inputs)).toEqual({ tag: "", dry: "true", env: "staging", note: "" });
    expect(seedInputValues([{ name: "b", type: "boolean" }])).toEqual({ b: "false" });
  });

  it("gates on required text inputs but never on a boolean", () => {
    const values = seedInputValues(inputs);
    expect(missingInputs(inputs, values).map((i) => i.name)).toEqual(["tag"]);
    expect(missingInputs(inputs, { ...values, tag: "  " }).map((i) => i.name)).toEqual(["tag"]);
    expect(missingInputs(inputs, { ...values, tag: "v1" })).toEqual([]);
  });

  it("omits empty text so the workflow's own default applies, but always sends booleans", () => {
    expect(collectInputValues(inputs, { tag: "v1", dry: "nope", env: "prod", note: "" })).toEqual({
      tag: "v1",
      dry: "false",
      env: "prod",
    });
  });
});

describe("workflow lists", () => {
  const wf = (id: number, name: string, over: Record<string, unknown> = {}) => ({
    id,
    name,
    path: `.github/workflows/${name}.yml`,
    state: "active",
    managed: false,
    url: null,
    ...over,
  });

  it("offers only file-backed, enabled workflows to run", () => {
    const list = [wf(1, "ci"), wf(2, "old", { state: "disabled_manually" }), wf(3, "Copilot", { managed: true })];
    expect(runnableWorkflows(list).map((w) => w.id)).toEqual([1]);
  });

  it("sorts own workflows by name and keeps managed ones apart", () => {
    const { own, managed } = sortWorkflows([wf(1, "release"), wf(2, "Copilot", { managed: true }), wf(3, "ci")]);
    expect(own.map((w) => w.name)).toEqual(["ci", "release"]);
    expect(managed.map((w) => w.name)).toEqual(["Copilot"]);
  });
});
