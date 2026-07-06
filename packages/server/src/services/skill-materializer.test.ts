import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillConfig } from "@cm/shared";
import {
  materializeSkills,
  cleanupMaterializedSkills,
  skillsTargetDir,
} from "./skill-materializer.js";

let srcDir: string;
let cwd: string;

beforeEach(async () => {
  srcDir = await mkdtemp(join(tmpdir(), "cm-skill-src-"));
  cwd = await mkdtemp(join(tmpdir(), "cm-skill-cwd-"));
});
afterEach(async () => {
  await rm(srcDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Author a `<name>/SKILL.md` (+ optional extra file) under the source dir. */
async function writeDirSkill(name: string, body: string, extra?: { file: string; content: string }) {
  await mkdir(join(srcDir, name), { recursive: true });
  await writeFile(join(srcDir, name, "SKILL.md"), body, "utf8");
  if (extra) await writeFile(join(srcDir, name, extra.file), extra.content, "utf8");
}

function dirSkill(name: string): SkillConfig {
  return { id: name, name, dir: name, path: join(srcDir, name, "SKILL.md"), layout: "dir" };
}

describe("skill-materializer", () => {
  it("materializes a dir skill (with supporting files) into <cwd>/.claude/skills/", async () => {
    await writeDirSkill("sprite", "SKILL body", { file: "gen.py", content: "print(1)\n" });
    const created = await materializeSkills(cwd, [dirSkill("sprite")]);

    const target = join(skillsTargetDir(cwd), "sprite");
    expect(created).toEqual([target]);
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("SKILL body");
    // Supporting files are copied too (relative references keep resolving).
    expect(await readFile(join(target, "gen.py"), "utf8")).toBe("print(1)\n");
  });

  it("materializes a flat skill into <dir>/SKILL.md", async () => {
    const path = join(srcDir, "add-npc.md");
    await writeFile(path, "FLAT body", "utf8");
    const created = await materializeSkills(cwd, [
      { id: "add-npc", name: "add-npc", dir: "add-npc", path, layout: "flat" },
    ]);
    const target = join(skillsTargetDir(cwd), "add-npc");
    expect(created).toEqual([target]);
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("FLAT body");
  });

  it("MERGES — never clobbers an existing `.claude/skills/<name>` the repo ships", async () => {
    // The repo already ships its OWN `sprite` skill in the cwd.
    const existing = join(skillsTargetDir(cwd), "sprite");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "SKILL.md"), "REPO OWNED — do not touch", "utf8");

    // A config skill wants the same dir name + a brand-new one.
    await writeDirSkill("sprite", "CONFIG version");
    await writeDirSkill("add-npc", "CONFIG new skill");
    const created = await materializeSkills(cwd, [dirSkill("sprite"), dirSkill("add-npc")]);

    // Only the new one is created; the repo-owned skill is left exactly as-is.
    expect(created).toEqual([join(skillsTargetDir(cwd), "add-npc")]);
    expect(await readFile(join(existing, "SKILL.md"), "utf8")).toBe("REPO OWNED — do not touch");
    expect(existsSync(join(skillsTargetDir(cwd), "add-npc", "SKILL.md"))).toBe(true);
  });

  it("cleanup removes ONLY the dirs we created (repo-owned skill survives)", async () => {
    const existing = join(skillsTargetDir(cwd), "sprite");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "SKILL.md"), "REPO OWNED", "utf8");
    await writeDirSkill("sprite", "CONFIG version");
    await writeDirSkill("add-npc", "CONFIG new skill");

    const created = await materializeSkills(cwd, [dirSkill("sprite"), dirSkill("add-npc")]);
    await cleanupMaterializedSkills(created);

    // The dir we created is gone…
    expect(existsSync(join(skillsTargetDir(cwd), "add-npc"))).toBe(false);
    // …and the repo-owned skill is untouched.
    expect(await readFile(join(existing, "SKILL.md"), "utf8")).toBe("REPO OWNED");
  });

  it("empty skill list → no work, no dirs created", async () => {
    const created = await materializeSkills(cwd, []);
    expect(created).toEqual([]);
    expect(existsSync(skillsTargetDir(cwd))).toBe(false);
  });
});
