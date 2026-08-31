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
  markerOwnerAlive,
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
    // never adds latency to the launch path (see `materializeSkills`). Poll the
    // CONTENT, not the path — `writeFile` creates the file before it fills it,
    // so waiting on existence can read back an empty string and fail as though
    // the pattern were wrong.
    const exclude = join(cwd, ".git", "info", "exclude");
    const read = () => readFile(exclude, "utf8").catch(() => "");
    let text = await read();
    for (let i = 0; i < 100 && !text.includes("/.claude/skills/sprite/"); i++) {
      await new Promise((r) => setTimeout(r, 10));
      text = await read();
    }
    expect(text).toContain("/.claude/skills/sprite/");
  });

  it("takes the exclude pattern back out at teardown", async () => {
    // The wiring, not the helper: leaving the pattern behind is what would make
    // a user's later override of a bundled skill invisible to git.
    await mkdir(join(cwd, ".git"), { recursive: true });
    await writeDirSkill("sprite", "SKILL body");
    const created = await materializeSkills(cwd, [dirSkill("sprite")]);

    const exclude = join(cwd, ".git", "info", "exclude");
    const read = () => readFile(exclude, "utf8").catch(() => "");
    let text = await read();
    for (let i = 0; i < 100 && !text.includes("/.claude/skills/sprite/"); i++) {
      await new Promise((r) => setTimeout(r, 10));
      text = await read();
    }
    expect(text).toContain("/.claude/skills/sprite/");

    await cleanupMaterializedSkills(created);
    expect(await read()).not.toContain("/.claude/skills/sprite/");
  });

  it("empty skill list → no work, no dirs created", async () => {
    const created = await materializeSkills(cwd, []);
    expect(created).toEqual([]);
    expect(existsSync(skillsTargetDir(cwd))).toBe(false);
  });
});

/* ------------------------------------------------- orphans from a dead run */

/**
 * A pid that is definitely not running. Searched rather than hardcoded: a
 * literal like 1234 is very likely a LIVE process on a busy CI box, which would
 * make every reclamation test below silently assert the opposite of its name.
 */
function deadPid(): number {
  for (let pid = 0x7ffffffe; pid > 0x7ffffff0; pid--) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") return pid;
    }
  }
  throw new Error("no dead pid found");
}

/** Fake a dir left by a server that has since died: our marker, a dead owner. */
async function writeOrphan(name: string, body: string) {
  const dir = join(skillsTargetDir(cwd), name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body, "utf8");
  await writeFile(join(dir, MATERIALIZED_MARKER), `${deadPid()}-a-previous-run`, "utf8");
  return dir;
}

describe("markerOwnerAlive", () => {
  it("a dead owner is reclaimable", () => {
    expect(markerOwnerAlive(`${deadPid()}-whatever`)).toBe(false);
  });

  it("keys on the PID, so ANOTHER live process's dirs are safe", () => {
    // Stable (4318) and dev (4319) share `config/`, so they share the projects
    // roster and can hold one repo as cwd at the same time. A different run id
    // is NOT permission to delete — only a dead owner is. `ppid` stands in for
    // the other instance: a real pid, alive, and not ours.
    expect(markerOwnerAlive(`${process.ppid}-the-other-instance`)).toBe(true);
  });

  it("treats OUR pid with a foreign run id as provably stale, not as ours", () => {
    // No other LIVE process can hold our pid, so only a dead run wrote this —
    // which is what a hard kill plus a restart inheriting the pid produces.
    // Reading it as alive would pin the skill at its stale body forever.
    expect(markerOwnerAlive(`${process.pid}-a-run-that-is-not-this-one`)).toBe(false);
  });

  it("errs toward alive on a marker it cannot parse", () => {
    // Not tidying up is untidy; deleting a running session's skills is not.
    for (const junk of ["", "   ", "not-a-pid", "-1-x", "0-x"]) {
      expect(markerOwnerAlive(junk)).toBe(true);
    }
  });
});

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

  it("never reclaims a LIVE owner's dirs — a sibling session may be using them", async () => {
    // Two chats can share one project dir, and so can the two instances. Sweeping
    // on "the id isn't mine" would let one delete the other's skills mid-turn.
    await writeDirSkill("sprite", "SKILL body");
    await materializeSkills(cwd, [dirSkill("sprite")]);

    const second = await materializeSkills(cwd, [dirSkill("sprite")]);

    expect(second).toEqual([]);
    const target = join(skillsTargetDir(cwd), "sprite");
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("SKILL body");
  });

  it("leaves a dir stamped by the OTHER live instance completely alone", async () => {
    // The exact cross-instance case: a different run id, but the owner is up.
    const other = join(skillsTargetDir(cwd), "stable-only");
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "SKILL.md"), "STABLE'S COPY", "utf8");
    await writeFile(join(other, MATERIALIZED_MARKER), `${process.ppid}-other-instance`, "utf8");
    await writeDirSkill("sprite", "SKILL body");

    await materializeSkills(cwd, [dirSkill("sprite")]);

    // Not deleted — and this run never puts it back, since it isn't in our set.
    expect(await readFile(join(other, "SKILL.md"), "utf8")).toBe("STABLE'S COPY");
  });

  it("reclaimOrphans on a cwd with no skills dir is a no-op", async () => {
    await expect(reclaimOrphans(skillsTargetDir(cwd))).resolves.toEqual({
      removed: [],
      stuck: [],
    });
  });

  it("reclaimOrphans reports exactly what it removed", async () => {
    const orphan = await writeOrphan("gone", "stale");
    const own = join(skillsTargetDir(cwd), "kept");
    await mkdir(own, { recursive: true });
    await writeFile(join(own, "SKILL.md"), "REPO OWNED", "utf8");

    expect(await reclaimOrphans(skillsTargetDir(cwd))).toEqual({
      removed: [orphan],
      stuck: [],
    });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(own)).toBe(true);
  });
});
