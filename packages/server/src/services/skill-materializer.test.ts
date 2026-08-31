import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillConfig } from "@dispatch/shared";
import {
  materializeSkills,
  cleanupMaterializedSkills,
  skillsTargetDir,
  reclaimOrphans,
  MATERIALIZED_MARKER,
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

  it("hides what it creates from git, so a project without a `.claude` ignore is quiet", async () => {
    await mkdir(join(cwd, ".git"), { recursive: true });
    await writeDirSkill("sprite", "SKILL body");
    await materializeSkills(cwd, [dirSkill("sprite")]);

    // Polled, not awaited: the exclude write is fire-and-forget on purpose so it
    // never adds latency to the launch path (see `materializeSkills`).
    const exclude = join(cwd, ".git", "info", "exclude");
    for (let i = 0; i < 100 && !existsSync(exclude); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await readFile(exclude, "utf8")).toContain("/.claude/skills/sprite/");
  });

  it("empty skill list → no work, no dirs created", async () => {
    const created = await materializeSkills(cwd, []);
    expect(created).toEqual([]);
    expect(existsSync(skillsTargetDir(cwd))).toBe(false);
  });
});

/* ------------------------------------------------- orphans from a dead run */

/** Fake a dir left by a PREVIOUS server run: our marker, a different run id. */
async function writeOrphan(name: string, body: string) {
  const dir = join(skillsTargetDir(cwd), name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body, "utf8");
  await writeFile(join(dir, MATERIALIZED_MARKER), "1234-a-previous-run", "utf8");
  return dir;
}

describe("orphan reclamation", () => {
  it("stamps every dir it creates, so a later run can recognize its own", async () => {
    await writeDirSkill("sprite", "SKILL body");
    await materializeSkills(cwd, [dirSkill("sprite")]);

    const marker = join(skillsTargetDir(cwd), "sprite", MATERIALIZED_MARKER);
    expect(existsSync(marker)).toBe(true);
    expect(await readFile(marker, "utf8")).not.toBe("");
  });

  it("reclaims a dead run's leftover AND replaces its stale content", async () => {
    // A hard kill (which Windows can't make graceful) skips teardown entirely,
    // so the dir survives — and because materialization skips a target that
    // exists, the stale copy also PINNED the skill at its old text.
    await writeOrphan("sprite", "STALE from a killed run");
    await writeDirSkill("sprite", "CURRENT body");

    const created = await materializeSkills(cwd, [dirSkill("sprite")]);

    const target = join(skillsTargetDir(cwd), "sprite");
    expect(created).toEqual([target]);
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("CURRENT body");
  });

  it("never reclaims an UNMARKED dir — that's the repo's own skill", async () => {
    const own = join(skillsTargetDir(cwd), "sprite");
    await mkdir(own, { recursive: true });
    await writeFile(join(own, "SKILL.md"), "REPO OWNED", "utf8");
    await writeDirSkill("sprite", "CONFIG version");

    const created = await materializeSkills(cwd, [dirSkill("sprite")]);

    expect(created).toEqual([]);
    expect(await readFile(join(own, "SKILL.md"), "utf8")).toBe("REPO OWNED");
  });

  it("never reclaims THIS run's dirs — a sibling session may be using them", async () => {
    // Two chats can share one project dir. Sweeping on a timestamp would let the
    // second one delete the first's skills mid-turn; keying on the run id can't.
    await writeDirSkill("sprite", "SKILL body");
    await materializeSkills(cwd, [dirSkill("sprite")]);

    const second = await materializeSkills(cwd, [dirSkill("sprite")]);

    expect(second).toEqual([]);
    const target = join(skillsTargetDir(cwd), "sprite");
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("SKILL body");
  });

  it("reclaimOrphans on a cwd with no skills dir is a no-op", async () => {
    await expect(reclaimOrphans(skillsTargetDir(cwd))).resolves.toEqual([]);
  });

  it("reclaimOrphans reports exactly what it removed", async () => {
    const orphan = await writeOrphan("gone", "stale");
    const own = join(skillsTargetDir(cwd), "kept");
    await mkdir(own, { recursive: true });
    await writeFile(join(own, "SKILL.md"), "REPO OWNED", "utf8");

    expect(await reclaimOrphans(skillsTargetDir(cwd))).toEqual([orphan]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(own)).toBe(true);
  });
});
