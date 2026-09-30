import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DEFAULT_HOUSE_RULES_LIMIT, resolveAgentContext } from "@dispatch/shared";
import type { Project } from "@dispatch/shared";
import { HouseRulesService, HouseRulesError, houseRulesDirFor } from "./house-rules.js";

let dir: string;
let service: HouseRulesService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cm-house-rules-"));
  service = new HouseRulesService({
    globalRoot: join(dir, "global"),
    projectDir: (id) => join(dir, "projects", id),
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("HouseRulesService", () => {
  it("injects nothing until a file has text", async () => {
    expect(await service.buildInjection("p1")).toBeNull();
    const read = await service.read("p1");
    expect(read.global.text).toBe("");
    expect(read.project?.text).toBe("");
  });

  it("injects global before project, each under its own heading", async () => {
    await service.write("global", "Be terse.");
    await service.write("project", "Never push to main.", "p1");
    const inj = (await service.buildInjection("p1"))!;
    expect(inj).toContain("## House rules");
    expect(inj.indexOf("Be terse.")).toBeLessThan(inj.indexOf("Never push to main."));
    expect(await service.listInjected("p1")).toEqual(["house-rules:global", "house-rules:project"]);
    // Another project gets only the global file.
    expect(await service.buildInjection("p2")).not.toContain("Never push to main.");
  });

  it("refuses a write over the cap instead of truncating it", async () => {
    await expect(service.write("global", "x".repeat(DEFAULT_HOUSE_RULES_LIMIT + 1))).rejects.toThrow(
      HouseRulesError,
    );
    expect(existsSync(await service.path("global"))).toBe(false);
    await service.write("global", "x".repeat(DEFAULT_HOUSE_RULES_LIMIT));
    expect((await readFile(await service.path("global"), "utf8")).trim()).toHaveLength(DEFAULT_HOUSE_RULES_LIMIT);
  });

  it("clamps a hand-edited file past the cap at injection", async () => {
    const path = await service.path("project", "p1");
    await mkdir(join(dir, "projects", "p1"), { recursive: true });
    await writeFile(path, "y".repeat(DEFAULT_HOUSE_RULES_LIMIT * 3));
    const inj = (await service.buildInjection("p1"))!;
    expect(inj.length).toBeLessThan(DEFAULT_HOUSE_RULES_LIMIT + 200);
  });

  it("enforces the RESOLVED cap, so raising it in settings unblocks a longer file", async () => {
    const raised = new HouseRulesService({
      globalRoot: join(dir, "global"),
      projectDir: (id) => join(dir, "projects", id),
      agentContext: () => resolveAgentContext({ houseRulesLimit: 4000 }, null),
    });
    const text = "x".repeat(DEFAULT_HOUSE_RULES_LIMIT + 1);
    // Refused at the default…
    await expect(service.write("global", text)).rejects.toThrow(HouseRulesError);
    // …accepted once the setting says so, and reported at the new cap.
    const file = await raised.write("global", text);
    expect(file.limit).toBe(4000);
    expect((await raised.read()).global.text).toHaveLength(text.length);
  });

  it("does not let a project's raised cap widen a GLOBAL write", async () => {
    // The global file is read by every other project, which would clamp it — so
    // the project's own cap must not be the one that authorises writing it.
    const svc = new HouseRulesService({
      globalRoot: join(dir, "global"),
      projectDir: (id) => join(dir, "projects", id),
      agentContext: (projectId) =>
        resolveAgentContext(undefined, projectId ? { houseRulesLimit: 5000 } : null),
    });
    const text = "x".repeat(DEFAULT_HOUSE_RULES_LIMIT + 1);
    await expect(svc.write("global", text, "p1")).rejects.toThrow(HouseRulesError);
    // The project's own file is what the raised cap is for.
    await expect(svc.write("project", text, "p1")).resolves.toBeTruthy();
  });

  it("replace mode drops the global file rather than stacking both", async () => {
    const svc = new HouseRulesService({
      globalRoot: join(dir, "global"),
      projectDir: (id) => join(dir, "projects", id),
      agentContext: (projectId) =>
        resolveAgentContext(undefined, projectId ? { houseRulesMode: "replace" } : null),
    });
    await svc.write("global", "Be terse.");
    await svc.write("project", "Never push to main.", "p1");

    const inj = (await svc.buildInjection("p1"))!;
    expect(inj).not.toContain("Be terse.");
    expect(inj).toContain("Never push to main.");
    // The ledger has to agree, or a suppressed file looks used on every turn.
    expect(await svc.listInjected("p1")).toEqual(["house-rules:project"]);
    expect((await svc.describeInjection("p1"))?.label).toBe(
      "House rules — project, global replaced",
    );
  });

  it("replace mode with no project file still sends the global one", async () => {
    // "Replace" is about a conflict between two sets of rules. With nothing to
    // replace it with, suppressing the global file would just mean no rules.
    const svc = new HouseRulesService({
      globalRoot: join(dir, "global"),
      projectDir: (id) => join(dir, "projects", id),
      agentContext: (projectId) =>
        resolveAgentContext(undefined, projectId ? { houseRulesMode: "replace" } : null),
    });
    await svc.write("global", "Be terse.");
    expect(await svc.buildInjection("p1")).toContain("Be terse.");
    expect(await svc.listInjected("p1")).toEqual(["house-rules:global"]);
  });

  it("describes what is in the injection, for the transcript disclosure", async () => {
    expect(await service.describeInjection("p1")).toBeNull();
    await service.write("global", "Be terse.");
    await service.write("project", "Never push to main.", "p1");
    const described = (await service.describeInjection("p1"))!;
    expect(described.label).toBe("House rules — global + project");
    expect(described.block).toBe(await service.buildInjection("p1"));
  });

  it("deletes the file when saved empty", async () => {
    await service.write("project", "rule", "p1");
    await service.write("project", "   ", "p1");
    expect(existsSync(await service.path("project", "p1"))).toBe(false);
  });

  it("keeps a repo's .dispatch/ as the project dir even when project.yaml is broken", async () => {
    // A typo in the manifest nulls the parsed config; the house rules must not
    // move to the fallback dir because of it.
    const repo = join(dir, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, ".dispatch"), { recursive: true });
    await writeFile(join(repo, ".dispatch", "project.yaml"), "name: [unclosed\n");
    const external = join(dir, "external");
    const project = { id: "p1", name: "p", repoPath: repo, worktreeRoot: repo } as Project;

    expect(houseRulesDirFor(project, external)).toBe(join(repo, ".dispatch"));
    // No project → the external dir.
    expect(houseRulesDirFor(null, external)).toBe(external);
  });
});
