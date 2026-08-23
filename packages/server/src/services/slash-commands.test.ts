/**
 * The `/` menu catalog.
 *
 * Two behaviours carry the feature: the menu must be USEFUL with no live
 * session (the disk half), and a name that exists in more than one scope must
 * resolve to the one that actually runs (the precedence half). Everything else
 * here guards a way the list could quietly become wrong.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthoredConfigService } from "./authored-config.js";
import { SlashCommandService } from "./slash-commands.js";

let globalRoot: string;
let projectRoot: string;
let cwd: string;
let service: SlashCommandService;
let authored: AuthoredConfigService;

beforeEach(async () => {
  globalRoot = await mkdtemp(join(tmpdir(), "cm-slash-global-"));
  projectRoot = await mkdtemp(join(tmpdir(), "cm-slash-project-"));
  cwd = await mkdtemp(join(tmpdir(), "cm-slash-cwd-"));
  authored = new AuthoredConfigService({ globalRoot });
  service = new SlashCommandService({ authored });
});
afterEach(async () => {
  await rm(globalRoot, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text, "utf8");
}

describe("SlashCommandService", () => {
  it("lists skills from disk with no live session at all", async () => {
    await write(
      join(globalRoot, "skills", "mine", "SKILL.md"),
      "---\nname: mine\ndescription: my thing\n---\nx",
    );
    const catalog = await service.catalog(cwd, null);

    expect(catalog.commands.find((c) => c.name === "mine")).toMatchObject({
      source: "global",
      description: "my thing",
    });
    // The honest signal: skills are here, built-ins are not — say so rather than
    // let a short list read as a broken one.
    expect(catalog.builtinsKnown).toBe(false);
  });

  it("labels a project skill as project and a shipped one as shipped", async () => {
    await write(
      join(projectRoot, "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: ship\n---\nx",
    );
    const withProject = new SlashCommandService({
      authored,
      projectSkillsDir: () => join(projectRoot, "skills"),
    });
    const catalog = await withProject.catalog(cwd, "p1");

    expect(catalog.commands.find((c) => c.name === "deploy")?.source).toBe("project");
    expect(catalog.commands.find((c) => c.name === "mcp-setup")?.source).toBe("shipped");
  });

  it("resolves a duplicated name to the scope that actually runs", async () => {
    // Same name in all three: materialization gives it to the project, so the
    // menu must say project — anything else points at a file that isn't running.
    await write(join(globalRoot, "skills", "mcp-setup", "SKILL.md"), "---\nname: mcp-setup\n---\nx");
    await write(
      join(projectRoot, "skills", "mcp-setup", "SKILL.md"),
      "---\nname: mcp-setup\ndescription: project copy\n---\nx",
    );
    const withProject = new SlashCommandService({
      authored,
      projectSkillsDir: () => join(projectRoot, "skills"),
    });
    const catalog = await withProject.catalog(cwd, "p1");

    const hits = catalog.commands.filter((c) => c.name === "mcp-setup");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.source).toBe("project");
    expect(hits[0]!.description).toBe("project copy");
  });

  it("finds the repo's own .claude/skills and .claude/commands", async () => {
    await write(join(cwd, ".claude", "skills", "own", "SKILL.md"), "---\nname: own\n---\nx");
    await write(
      join(cwd, ".claude", "commands", "ship.md"),
      "---\ndescription: ship it\nargument-hint: <env>\n---\ngo",
    );
    const catalog = await service.catalog(cwd, null);

    expect(catalog.commands.find((c) => c.name === "own")?.source).toBe("repo");
    expect(catalog.commands.find((c) => c.name === "ship")).toMatchObject({
      source: "repo",
      description: "ship it",
      argumentHint: "<env>",
    });
  });

  it("names a nested command the way it is actually invoked", async () => {
    await write(join(cwd, ".claude", "commands", "gsd", "plan.md"), "---\ndescription: p\n---\nx");
    const catalog = await service.catalog(cwd, null);
    expect(catalog.commands.map((c) => c.name)).toContain("gsd:plan");
  });

  it("adds the runtime's built-ins once a session has reported them", async () => {
    expect((await service.catalog(cwd, null)).builtinsKnown).toBe(false);

    service.recordRuntimeCommands(
      [{ name: "compact", description: "compact the context", source: "builtin", aliases: [] }],
      null,
    );
    const catalog = await service.catalog(cwd, null);

    expect(catalog.builtinsKnown).toBe(true);
    expect(catalog.commands.find((c) => c.name === "compact")?.source).toBe("builtin");
  });

  it("ignores an EMPTY runtime report — that's a failed answer, not 'no commands'", async () => {
    service.recordRuntimeCommands([], null);
    expect((await service.catalog(cwd, null)).builtinsKnown).toBe(false);
  });

  it("keeps the disk label when the runtime reports the same skill", async () => {
    // The runtime reports every skill it discovered, including the ones Dispatch
    // materialized. Presenting one of those as "built-in" would hide the file.
    await write(join(globalRoot, "skills", "mine", "SKILL.md"), "---\nname: mine\n---\nx");
    service.recordRuntimeCommands(
      [{ name: "mine", description: "from the runtime", source: "builtin", aliases: [] }],
      null,
    );
    const catalog = await service.catalog(cwd, null);
    expect(catalog.commands.filter((c) => c.name === "mine")).toHaveLength(1);
    expect(catalog.commands.find((c) => c.name === "mine")?.source).toBe("global");
  });

  it("sees a skill authored a moment ago, with no config reload in between", async () => {
    // The promise `config_write` makes is "the human can now run it as /name".
    // Reading the DIRECTORY rather than the watcher-refreshed config is what
    // makes that true on the very next keystroke.
    const withProject = new SlashCommandService({
      authored,
      projectSkillsDir: () => join(projectRoot, "skills"),
    });
    expect((await withProject.catalog(cwd, "p1")).commands.map((c) => c.name)).not.toContain(
      "brand-new",
    );

    await write(
      join(projectRoot, "skills", "brand-new", "SKILL.md"),
      "---\nname: brand-new\ndescription: just written\n---\nx",
    );
    expect((await withProject.catalog(cwd, "p1")).commands.map((c) => c.name)).toContain(
      "brand-new",
    );
  });

  it("never leaks one project's skill into another project's menu", async () => {
    // `supportedCommands()` reports every skill the runtime DISCOVERED, not just
    // built-ins — including the ones materialized into that chat's cwd. A
    // process-wide snapshot would offer project X's `/deploy` in project Y,
    // labelled "built-in", inserting a command Y's runtime cannot resolve.
    service.recordRuntimeCommands(
      [
        { name: "compact", description: "built in", source: "builtin", aliases: [] },
        { name: "deploy", description: "X's own skill", source: "builtin", aliases: [] },
      ],
      "project-x",
    );

    const x = await service.catalog(cwd, "project-x");
    expect(x.builtinsKnown).toBe(true);
    expect(x.commands.map((c) => c.name)).toEqual(expect.arrayContaining(["compact", "deploy"]));

    const y = await service.catalog(cwd, "project-y");
    expect(y.builtinsKnown).toBe(false);
    expect(y.commands.map((c) => c.name)).not.toContain("deploy");
    expect(y.commands.map((c) => c.name)).not.toContain("compact");
  });

  it("keeps a projectless session's snapshot out of every project", async () => {
    service.recordRuntimeCommands(
      [{ name: "loose", source: "builtin", aliases: [] }],
      null,
    );
    expect((await service.catalog(cwd, "project-x")).commands.map((c) => c.name)).not.toContain(
      "loose",
    );
    expect((await service.catalog(cwd, null)).commands.map((c) => c.name)).toContain("loose");
  });

  it("sorts by name and survives a cwd that doesn't exist", async () => {
    const catalog = await service.catalog(join(cwd, "gone"), null);
    const names = catalog.commands.map((c) => c.name);
    expect(names).toEqual([...names].sort());
  });
});
