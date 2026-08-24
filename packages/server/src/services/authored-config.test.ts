/**
 * The app-level (shipped + user-global) half of authored guidance.
 *
 * The assertions that matter here are about ORDER and about what is REFUSED —
 * those are the two things that decide whether the three scopes compose or
 * silently fight each other.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthoredConfigService,
  readInstructionsDir,
  readSkillsDir,
  renderSkill,
  assertName,
} from "./authored-config.js";

let root: string;
let service: AuthoredConfigService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cm-authored-"));
  service = new AuthoredConfigService({ globalRoot: root });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeFileIn(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text, "utf8");
}

describe("readSkillsDir", () => {
  it("reads both layouts and takes name/description from frontmatter", async () => {
    await writeFileIn(
      join(root, "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: ship it\n---\n\nsteps",
    );
    await writeFileIn(join(root, "skills", "flat.md"), "---\ndescription: a flat one\n---\nbody");

    const skills = readSkillsDir(join(root, "skills"));
    expect(skills.map((s) => s.dir).sort()).toEqual(["deploy", "flat"]);
    expect(skills.find((s) => s.dir === "deploy")!.layout).toBe("dir");
    expect(skills.find((s) => s.dir === "deploy")!.description).toBe("ship it");
    // A flat skill with no `name:` falls back to its filename, not to empty.
    expect(skills.find((s) => s.dir === "flat")!.name).toBe("flat");
  });

  it("returns [] for a missing dir instead of throwing", () => {
    expect(readSkillsDir(join(root, "nope"))).toEqual([]);
  });

  it("skips a skill directory with no SKILL.md rather than failing the batch", async () => {
    await writeFileIn(join(root, "skills", "good", "SKILL.md"), "---\nname: good\n---\nx");
    await mkdir(join(root, "skills", "empty"), { recursive: true });
    expect(readSkillsDir(join(root, "skills")).map((s) => s.dir)).toEqual(["good"]);
  });
});

describe("readInstructionsDir", () => {
  it("sorts by name and summarizes from the first real line", async () => {
    await writeFileIn(join(root, "instructions", "b.md"), "# Heading\n\nSecond rule here.");
    await writeFileIn(join(root, "instructions", "a.md"), "First rule here.");

    const files = await readInstructionsDir(join(root, "instructions"));
    expect(files.map((f) => f.name)).toEqual(["a", "b"]);
    // The heading is stripped: "# Heading" is a title, and a blurb saying
    // "Heading" tells a reader nothing.
    expect(files[1]!.description).toBe("Heading");
  });

  it("never treats README.md as an instruction", async () => {
    await writeFileIn(join(root, "instructions", "README.md"), "How to author these.");
    await writeFileIn(join(root, "instructions", "real.md"), "A rule.");
    const files = await readInstructionsDir(join(root, "instructions"));
    expect(files.map((f) => f.name)).toEqual(["real"]);
  });

  it("skips an empty file so it can't contribute a blank injection section", async () => {
    await writeFileIn(join(root, "instructions", "blank.md"), "   \n\n");
    expect(await readInstructionsDir(join(root, "instructions"))).toEqual([]);
  });
});

describe("AuthoredConfigService", () => {
  it("puts global skills BEFORE shipped ones, which is what makes global win", () => {
    // Materialization skips a target that already exists, so precedence is
    // nothing but this ordering — assert it directly.
    const skills = service.appSkills();
    const shippedFirst = skills.findIndex((s) => s.dir === "mcp-setup");
    expect(shippedFirst).toBeGreaterThanOrEqual(0);
  });

  it("shadows a shipped skill when a global one shares its name", async () => {
    await writeFileIn(
      join(root, "skills", "mcp-setup", "SKILL.md"),
      "---\nname: mcp-setup\ndescription: mine\n---\nlocal",
    );
    const skills = service.appSkills();
    const first = skills.find((s) => s.dir === "mcp-setup")!;
    expect(first.description).toBe("mine");
    // Both are still listed — materialization drops the loser, not this reader —
    // but the global copy comes first and therefore claims the directory.
    expect(skills.filter((s) => s.dir === "mcp-setup").length).toBe(2);
    expect(skills.indexOf(first)).toBeLessThan(
      skills.findIndex((s, i) => s.dir === "mcp-setup" && i !== skills.indexOf(first)),
    );
  });

  it("injects shipped instructions before global ones", async () => {
    await writeFileIn(join(root, "instructions", "mine.md"), "MY-GLOBAL-RULE");
    const injection = await service.buildInjection();
    expect(injection).toContain("## Global instructions");
    expect(injection).toContain("MY-GLOBAL-RULE");
    // The shipped set ships at least `recording-what-you-learn`; it must precede
    // the operator's own, so theirs is the last word.
    const shippedAt = injection!.indexOf("Recording what you learn");
    expect(shippedAt).toBeGreaterThanOrEqual(0);
    expect(shippedAt).toBeLessThan(injection!.indexOf("MY-GLOBAL-RULE"));
  });

  it("names every injected file for the usage ledger, scope-qualified", async () => {
    await writeFileIn(join(root, "instructions", "mine.md"), "x");
    const ids = await service.listInjected();
    expect(ids).toContain("global:mine");
    expect(ids.some((id) => id.startsWith("shipped:"))).toBe(true);
  });

  it("writes a global skill as a SKILL.md with usable frontmatter", async () => {
    const path = await service.write("skill", "my-skill", "do the thing", "when X happens");
    expect(path.endsWith(join("skills", "my-skill", "SKILL.md"))).toBe(true);
    const read = readSkillsDir(service.globalSkillsDir());
    expect(read).toHaveLength(1);
    expect(read[0]!.name).toBe("my-skill");
    expect(read[0]!.description).toBe("when X happens");
  });

  it("round-trips a global instruction into the injection", async () => {
    await service.write("instruction", "house-style", "Tabs, not spaces.");
    expect(await service.buildInjection()).toContain("Tabs, not spaces.");
  });

  it("removes a global item and reports a miss honestly", async () => {
    await service.write("skill", "gone", "x", "y");
    expect(await service.remove("skill", "gone")).toBe(true);
    expect(existsSync(join(service.globalSkillsDir(), "gone"))).toBe(false);
    expect(await service.remove("skill", "gone")).toBe(false);
  });

  it("removes BOTH layouts when a name has each, so no stale copy keeps serving", async () => {
    // `write()` always creates the directory form, so one config_write over a
    // hand-authored flat file produces the pair. `readSkillsDir` dedupes them
    // (the directory sorts first and wins), so a first-match delete would report
    // success while the flat file kept answering under the same name.
    await writeFileIn(join(root, "skills", "deploy.md"), "---\nname: deploy\n---\nold body");
    await service.write("skill", "deploy", "new body", "the real one");
    expect(existsSync(join(root, "skills", "deploy.md"))).toBe(true);
    expect(existsSync(join(root, "skills", "deploy", "SKILL.md"))).toBe(true);

    expect(await service.remove("skill", "deploy")).toBe(true);
    expect(existsSync(join(root, "skills", "deploy.md"))).toBe(false);
    expect(existsSync(join(root, "skills", "deploy"))).toBe(false);
    expect(readSkillsDir(service.globalSkillsDir())).toEqual([]);
  });

  it("removes a FLAT global skill too, not just a skill directory", async () => {
    await writeFileIn(join(root, "skills", "flat.md"), "---\nname: flat\n---\nbody");
    expect(await service.remove("skill", "flat")).toBe(true);
    expect(existsSync(join(root, "skills", "flat.md"))).toBe(false);
  });

  it("lists shipped items as read-only and global ones as writable", async () => {
    await service.write("skill", "mine", "x", "y");
    const skills = await service.list("skill");
    expect(skills.find((s) => s.name === "mine")).toMatchObject({
      scope: "global",
      writable: true,
    });
    expect(skills.find((s) => s.scope === "shipped")!.writable).toBe(false);
  });
});

describe("assertName", () => {
  it("rejects anything that would escape its directory or be untypable", () => {
    for (const bad of ["../evil", "a/b", "Caps", "-lead", "", "with space", "dot.md"]) {
      expect(() => assertName(bad)).toThrow();
    }
    for (const good of ["a", "my-skill", "release-2", "x".repeat(64)]) {
      expect(() => assertName(good)).not.toThrow();
    }
  });
});

describe("renderSkill", () => {
  it("always emits a description, because a skill without one is never loaded", () => {
    expect(renderSkill("x", undefined, "body")).toContain("description: x");
    expect(renderSkill("x", "  a b  ", "body")).toContain("description: a b");
  });

  it("flattens a multi-line description so the YAML stays parseable", () => {
    expect(renderSkill("x", "one\ntwo", "body")).toContain("description: one two");
  });
});
