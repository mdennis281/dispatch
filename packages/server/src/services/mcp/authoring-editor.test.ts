/**
 * Scope resolution for the `config_*` tools.
 *
 * The one rule worth a test: a READ with no scope must find the copy that is
 * actually in effect, which is the most SPECIFIC one — the inverse of the
 * injection order. Getting that backwards means `config_read` shows you a
 * shipped file while a project file of the same name is what's running.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectConfig } from "@dispatch/shared";
import { AuthoredConfigService } from "../authored-config.js";
import { createAuthoringEditor } from "./authoring-editor.js";

let repo: string;
let globalRoot: string;
let authored: AuthoredConfigService;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "cm-editor-repo-"));
  globalRoot = await mkdtemp(join(tmpdir(), "cm-editor-global-"));
  await mkdir(join(repo, ".dispatch"), { recursive: true });
  await writeFile(join(repo, ".dispatch", "project.yaml"), "name: demo\n", "utf8");
  authored = new AuthoredConfigService({ globalRoot });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(globalRoot, { recursive: true, force: true });
});

/** Enough of a ProjectConfig for the listing path. */
const config = (): ProjectConfig =>
  ({
    sourceDir: join(repo, ".dispatch"),
    instructionsDir: join(repo, ".dispatch", "instructions"),
    skillsDir: join(repo, ".dispatch", "skills"),
    instructions: [],
    skills: [],
  }) as never;

const editor = (repoPath: string | null = repo) =>
  createAuthoringEditor({ authored, repoPath, getConfig: () => (repoPath ? config() : null) });

describe("createAuthoringEditor", () => {
  it("reads the most specific copy when no scope is named", async () => {
    await authored.write("skill", "dup", "GLOBAL BODY", "g");
    const ed = editor();
    await ed.write({ kind: "skill", scope: "project", name: "dup", body: "PROJECT BODY", description: "p" });

    const found = await ed.read("skill", "dup");
    expect(found?.scope).toBe("project");
    expect(found?.text).toContain("PROJECT BODY");
  });

  it("reads the scope it was asked for, even when a more specific one exists", async () => {
    await authored.write("skill", "dup", "GLOBAL BODY", "g");
    const ed = editor();
    await ed.write({ kind: "skill", scope: "project", name: "dup", body: "PROJECT BODY", description: "p" });

    const found = await ed.read("skill", "dup", "global");
    expect(found?.scope).toBe("global");
    expect(found?.text).toContain("GLOBAL BODY");
  });

  it("returns null rather than falling back to a different name", async () => {
    expect(await editor().read("skill", "nothing-like-this")).toBeNull();
  });

  it("lists project items ahead of app-level ones", async () => {
    await authored.write("skill", "g", "x", "y");
    const ed = editor();
    await ed.write({ kind: "skill", scope: "project", name: "p", body: "x", description: "y" });

    const scopes = (await ed.list("skill")).map((i) => i.scope);
    expect(scopes[0]).toBe("project");
    expect(scopes).toContain("global");
    expect(scopes).toContain("shipped");
  });

  it("reports a project-scope write as registered only for an instruction", async () => {
    const ed = editor();
    expect(
      (await ed.write({ kind: "instruction", scope: "project", name: "i", body: "x" })).registered,
    ).toBe(true);
    expect(
      (await ed.write({ kind: "skill", scope: "project", name: "s", body: "x", description: "y" }))
        .registered,
    ).toBe(false);
  });

  it("refuses a project write with no project, instead of writing somewhere surprising", async () => {
    const ed = editor(null);
    expect(ed.hasProject).toBe(false);
    await expect(
      ed.write({ kind: "skill", scope: "project", name: "x", body: "b", description: "d" }),
    ).rejects.toThrow(/no project/i);
  });

  it("still authors globally without a project", async () => {
    const ed = editor(null);
    const result = await ed.write({
      kind: "skill",
      scope: "global",
      name: "x",
      body: "b",
      description: "d",
    });
    expect(result.path).toContain("skills");
    expect((await ed.read("skill", "x"))?.scope).toBe("global");
  });

  it("deletes from the scope named, leaving the other copy alone", async () => {
    await authored.write("skill", "dup", "GLOBAL", "g");
    const ed = editor();
    await ed.write({ kind: "skill", scope: "project", name: "dup", body: "PROJECT", description: "p" });

    expect(await ed.remove("skill", "dup", "project")).toBe(true);
    const remaining = await ed.read("skill", "dup");
    expect(remaining?.scope).toBe("global");
  });
});
