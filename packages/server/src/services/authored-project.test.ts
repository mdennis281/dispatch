/**
 * Project-scope authoring — and specifically the manifest half.
 *
 * An instruction file that isn't listed in `project.yaml` is never injected and
 * never errors, so "did the write register it" is the single assertion this
 * whole module exists to make true. The rest guards the ways that registration
 * can go wrong: a duplicate entry (injects twice), a stale entry after a delete
 * (a config error on every reload), and a hand-authored manifest losing its
 * comments to the rewrite.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  writeProjectItem,
  deleteProjectItem,
  readProjectItem,
  listProjectItems,
} from "./authored-project.js";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "cm-authored-proj-"));
  await mkdir(join(repo, ".dispatch"), { recursive: true });
  await writeFile(
    join(repo, ".dispatch", "project.yaml"),
    "# a hand-authored manifest\nname: demo\n",
    "utf8",
  );
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const manifest = async (): Promise<Record<string, unknown>> =>
  parseYaml(await readFile(join(repo, ".dispatch", "project.yaml"), "utf8")) as Record<
    string,
    unknown
  >;

describe("writeProjectItem — instructions", () => {
  it("writes the file AND registers it, which is what makes it inject", async () => {
    const result = await writeProjectItem(repo, "instruction", "house-rules", "Be terse.");

    expect(result.registered).toBe(true);
    expect(await readFile(result.path, "utf8")).toBe("Be terse.\n");
    expect((await manifest()).instructions).toEqual([{ file: "instructions/house-rules.md" }]);
  });

  it("keeps the manifest's comments — it's a document edit, not a rewrite", async () => {
    await writeProjectItem(repo, "instruction", "x", "body");
    const raw = await readFile(join(repo, ".dispatch", "project.yaml"), "utf8");
    expect(raw).toContain("# a hand-authored manifest");
  });

  it("does not register a second time when overwriting", async () => {
    await writeProjectItem(repo, "instruction", "x", "one");
    const second = await writeProjectItem(repo, "instruction", "x", "two");

    expect(second.registered).toBe(false);
    expect((await manifest()).instructions).toHaveLength(1);
    expect(await readFile(second.path, "utf8")).toBe("two\n");
  });

  it("recognizes the BARE spelling the loader also accepts, so it can't double-inject", async () => {
    // The loader resolves `file: x.md` against the instructions dir too, so an
    // entry written by hand in that form already covers this file.
    await writeFile(
      join(repo, ".dispatch", "project.yaml"),
      "name: demo\ninstructions:\n  - file: x.md\n",
      "utf8",
    );
    const result = await writeProjectItem(repo, "instruction", "x", "body");
    expect(result.registered).toBe(false);
    expect((await manifest()).instructions).toEqual([{ file: "x.md" }]);
  });

  it("honours an instructionsDir override", async () => {
    await writeFile(
      join(repo, ".dispatch", "project.yaml"),
      "name: demo\ninstructionsDir: rules\n",
      "utf8",
    );
    const result = await writeProjectItem(repo, "instruction", "x", "body");
    expect(result.path).toBe(join(repo, ".dispatch", "rules", "x.md"));
    expect((await manifest()).instructions).toEqual([{ file: "rules/x.md" }]);
  });
});

describe("writeProjectItem — skills", () => {
  it("writes a SKILL.md with frontmatter and touches no manifest entry", async () => {
    const result = await writeProjectItem(repo, "skill", "verify", "run the thing", "when X");

    expect(result.registered).toBe(false);
    expect(result.path).toBe(join(repo, ".dispatch", "skills", "verify", "SKILL.md"));
    const text = await readFile(result.path, "utf8");
    expect(text).toContain("name: verify");
    expect(text).toContain("description: when X");
    expect(text).toContain("run the thing");
    // Skills are discovered by directory listing, so the manifest stays clean.
    expect((await manifest()).instructions).toBeUndefined();
  });

  it("rejects a name that would escape the skills dir", async () => {
    await expect(writeProjectItem(repo, "skill", "../evil", "x", "y")).rejects.toThrow();
  });
});

describe("deleteProjectItem", () => {
  it("removes the file AND the manifest entry, so no reload reports a missing file", async () => {
    await writeProjectItem(repo, "instruction", "x", "body");
    expect(await deleteProjectItem(repo, "instruction", "x")).toBe(true);

    expect(existsSync(join(repo, ".dispatch", "instructions", "x.md"))).toBe(false);
    // The whole key goes when it empties — an empty list is noise in a committed file.
    expect((await manifest()).instructions).toBeUndefined();
  });

  it("keeps the other entries when several are registered", async () => {
    await writeProjectItem(repo, "instruction", "a", "one");
    await writeProjectItem(repo, "instruction", "b", "two");
    await deleteProjectItem(repo, "instruction", "a");
    expect((await manifest()).instructions).toEqual([{ file: "instructions/b.md" }]);
  });

  it("still unregisters when the FILE is already gone — the stale entry is the bug", async () => {
    await writeProjectItem(repo, "instruction", "x", "body");
    await rm(join(repo, ".dispatch", "instructions", "x.md"));
    expect(await deleteProjectItem(repo, "instruction", "x")).toBe(true);
    expect((await manifest()).instructions).toBeUndefined();
  });

  it("reports false for something that was never there", async () => {
    expect(await deleteProjectItem(repo, "skill", "nope")).toBe(false);
  });

  it("removes a skill directory whole", async () => {
    await writeProjectItem(repo, "skill", "s", "x", "y");
    expect(await deleteProjectItem(repo, "skill", "s")).toBe(true);
    expect(existsSync(join(repo, ".dispatch", "skills", "s"))).toBe(false);
  });
});

describe("readProjectItem", () => {
  it("reads back both kinds, and null for a miss", async () => {
    await writeProjectItem(repo, "instruction", "i", "prose");
    await writeProjectItem(repo, "skill", "s", "steps", "when");

    expect((await readProjectItem(repo, "instruction", "i"))?.text).toBe("prose\n");
    expect((await readProjectItem(repo, "skill", "s"))?.text).toContain("steps");
    expect(await readProjectItem(repo, "skill", "missing")).toBeNull();
  });
});

describe("listProjectItems", () => {
  it("flags an instruction file the manifest doesn't list as INACTIVE", async () => {
    await writeProjectItem(repo, "instruction", "live", "on");
    // A hand-placed file: on disk, but inert.
    await writeFile(join(repo, ".dispatch", "instructions", "orphan.md"), "off", "utf8");

    const items = await listProjectItems("instruction", {
      sourceDir: join(repo, ".dispatch"),
      instructionsDir: join(repo, ".dispatch", "instructions"),
      skillsDir: join(repo, ".dispatch", "skills"),
      instructions: [
        { source: "file", file: "instructions/live.md", rel: "instructions/live.md", text: "on" },
      ],
      skills: [],
      // The rest of ProjectConfig is irrelevant to this listing.
    } as never);

    expect(items.find((i) => i.name === "live")!.active).toBe(true);
    expect(items.find((i) => i.name === "orphan")!.active).toBe(false);
  });
});
