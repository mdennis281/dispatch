import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { HOUSE_RULES_MAX_CHARS } from "@dispatch/shared";
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
    await expect(service.write("global", "x".repeat(HOUSE_RULES_MAX_CHARS + 1))).rejects.toThrow(
      HouseRulesError,
    );
    expect(existsSync(await service.path("global"))).toBe(false);
    await service.write("global", "x".repeat(HOUSE_RULES_MAX_CHARS));
    expect((await readFile(await service.path("global"), "utf8")).trim()).toHaveLength(HOUSE_RULES_MAX_CHARS);
  });

  it("clamps a hand-edited file past the cap at injection", async () => {
    const path = await service.path("project", "p1");
    await mkdir(join(dir, "projects", "p1"), { recursive: true });
    await writeFile(path, "y".repeat(HOUSE_RULES_MAX_CHARS * 3));
    const inj = (await service.buildInjection("p1"))!;
    expect(inj.length).toBeLessThan(HOUSE_RULES_MAX_CHARS + 200);
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
