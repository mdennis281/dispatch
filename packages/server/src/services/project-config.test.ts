import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import type { Project, WsServerEvent } from "@dispatch/shared";
import {
  ProjectConfigService,
  mergeProject,
  mergeById,
  configModeToModeConfig,
  renderInstructionsInjection,
  parseFrontmatter,
  slugifyConfigName,
  type ConfigWatcher,
} from "./project-config.js";

let dataDir: string;
let repoDir: string;
let store: Store;
let bus: EventBus;
let events: WsServerEvent[];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cm-cfg-data-"));
  repoDir = await mkdtemp(join(tmpdir(), "cm-cfg-repo-"));
  store = new Store(dataDir);
  await store.init();
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Seed a Project pointing at the temp repo. */
async function seedProject(over: Partial<Project> = {}): Promise<Project> {
  const project: Project = {
    id: "p1",
    name: "Seed Name",
    repoPath: repoDir,
    worktreeRoot: join(repoDir, "..", "wt"),
    defaultBranch: "main",
    subApps: [],
    createdAt: 1,
    ...over,
  };
  return store.saveProject(project);
}

/** Write a file under the repo's `.dispatch/` dir (creating parents). */
async function writeConfig(rel: string, body: string): Promise<void> {
  const abs = join(repoDir, ".dispatch", rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, body, "utf8");
}

/** A watch factory that captures the change listener for manual triggering. */
function captureWatch(): {
  factory: (dir: string, onChange: () => void) => ConfigWatcher | null;
  trigger: () => void;
  closed: () => boolean;
} {
  let listener: (() => void) | undefined;
  let isClosed = false;
  return {
    factory: (_dir, onChange) => {
      listener = onChange;
      return { close: () => { isClosed = true; } };
    },
    trigger: () => listener?.(),
    closed: () => isClosed,
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `predicate` holds, or fail after `timeoutMs`. Debounced work is
 * "done after at least N ms", not "done at exactly N ms" — a fixed sleep sized to
 * the debounce window turns every slow CI tick into a false failure.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await delay(5);
  }
}

/* ------------------------------------------------------------------ helpers */

describe("project-config helpers", () => {
  it("slugifies a free-text name", () => {
    expect(slugifyConfigName("My Cool Agent!")).toBe("my-cool-agent");
    expect(slugifyConfigName("  ---  ")).toBe("");
  });

  it("parses YAML frontmatter + markdown body", () => {
    const { data, body } = parseFrontmatter(
      "---\nname: Builder\ntools:\n  - Read\n  - Bash\n---\nDo the work.",
    );
    expect(data.name).toBe("Builder");
    expect(data.tools).toEqual(["Read", "Bash"]);
    expect(body).toBe("Do the work.");
  });

  it("frontmatter-less content is all body", () => {
    const { data, body } = parseFrontmatter("just a body\nmore");
    expect(data).toEqual({});
    expect(body).toBe("just a body\nmore");
  });
});

/* -------------------------------------------------------------------- load */

describe("ProjectConfigService — load a valid .dispatch/", () => {
  it("normalizes the manifest + referenced files into a ProjectConfig", async () => {
    const project = await seedProject();
    await writeConfig(
      "project.yaml",
      [
        "name: Hivebreak",
        "worktree: pnpm worktree",
        "ship: pnpm ship",
        "worktreeRoot: C:/wt",
        "defaults:",
        "  mode: plan",
        "  effort: high",
        "  model: claude-opus-4-8",
        "instructions:",
        "  - file: instructions/house.md",
        "  - text: Inline rule.",
        "subApps:",
        "  - id: game",
        "    name: game",
        "    cwd: apps/client",
        "    dev: pnpm dev",
        "    ports: [5173]",
        "    docker: docker-compose.yml",
        "mcpServers:",
        "  - name: chrome",
        "    transport:",
        "      type: stdio",
        "      command: npx",
        "      args: ['-y', 'chrome-mcp']",
        "  - name: remote",
        "    transport:",
        "      type: http",
        "      url: https://example.com/mcp",
        "",
      ].join("\n"),
    );
    await writeConfig("instructions/house.md", "House rules here.");
    await writeConfig(
      "agents/builder.md",
      [
        "---",
        "name: Builder",
        "description: Principal engineer",
        "permissionMode: plan",
        "tools:",
        "  - Read",
        "  - Bash",
        "model: claude-opus-4-8",
        "---",
        "You are a principal engineer.",
      ].join("\n"),
    );
    await writeConfig(
      "modes/careful.yaml",
      ["name: Careful", "description: read-only", "permissionMode: plan", "allowedTools: [Read, Grep]"].join("\n"),
    );

    const svc = new ProjectConfigService({ store, bus });
    const result = await svc.load(project);

    expect(result.errors).toEqual([]);
    expect(result.sourceDir).toContain(".dispatch");
    const cfg = result.config!;
    expect(cfg.name).toBe("Hivebreak");
    expect(cfg.worktreeCmd).toBe("pnpm worktree");
    expect(cfg.shipCmd).toBe("pnpm ship");
    expect(cfg.worktreeRoot).toBe("C:/wt");
    expect(cfg.defaults).toMatchObject({ mode: "plan", effort: "high", model: "claude-opus-4-8" });

    // instructions: file read + inline text, concatenated.
    expect(cfg.instructions).toHaveLength(2);
    expect(cfg.instructions[0]).toMatchObject({ source: "file", file: "instructions/house.md", text: "House rules here." });
    expect(cfg.instructions[1]).toMatchObject({ source: "text", text: "Inline rule." });
    expect(cfg.instructionsText).toBe("House rules here.\n\nInline rule.");

    // subApp cwd → path, docker → dockerCompose.
    expect(cfg.subApps[0]).toMatchObject({
      id: "game",
      path: "apps/client",
      dockerCompose: "docker-compose.yml",
      ports: [5173],
    });

    // mcpServers array → keyed record, transport flattened.
    expect(cfg.mcpServers.chrome).toMatchObject({ type: "stdio", command: "npx", args: ["-y", "chrome-mcp"] });
    expect(cfg.mcpServers.remote).toMatchObject({ type: "http", url: "https://example.com/mcp" });

    // agent frontmatter → AgentConfig (project-scoped).
    expect(cfg.agents).toHaveLength(1);
    expect(cfg.agents[0]).toMatchObject({
      id: "builder",
      name: "Builder",
      permissionMode: "plan",
      allowedTools: ["Read", "Bash"],
      model: "claude-opus-4-8",
      scope: "project",
      projectId: "p1",
      instructions: "You are a principal engineer.",
    });

    // mode yaml → ConfigMode.
    expect(cfg.modes).toHaveLength(1);
    expect(cfg.modes[0]).toMatchObject({
      id: "careful",
      name: "Careful",
      permissionMode: "plan",
      allowedTools: ["Read", "Grep"],
    });

    // resolved dirs.
    expect(cfg.memoryDir).toContain("memory");
    expect(cfg.agentsDir).toContain("agents");
    expect(cfg.modesDir).toContain("modes");
  });

  it("honors dir overrides (memory/agents/modes/skills/instructionsDir)", async () => {
    const project = await seedProject();
    await writeConfig(
      "project.yaml",
      ["name: X", "memory: mem", "agents: bots", "modes: postures", "skills: powers", "instructionsDir: docs"].join("\n"),
    );
    const svc = new ProjectConfigService({ store, bus });
    const cfg = (await svc.load(project)).config!;
    expect(cfg.memoryDir.endsWith("mem")).toBe(true);
    expect(cfg.agentsDir.endsWith("bots")).toBe(true);
    expect(cfg.modesDir.endsWith("postures")).toBe(true);
    expect(cfg.skillsDir.endsWith("powers")).toBe(true);
    expect(cfg.instructionsDir.endsWith("docs")).toBe(true);
  });
});

/* --------------------------------------------------------------- skills */

describe("ProjectConfigService — skills (both layouts + resilience)", () => {
  it("loads a SKILL.md dir skill AND a flat `<name>.md` skill into ProjectConfig", async () => {
    const project = await seedProject();
    await writeConfig("project.yaml", "name: X");
    // Layout A: a skill directory with SKILL.md (+ a supporting file).
    await writeConfig(
      "skills/sprite-gen/SKILL.md",
      ["---", "name: Sprite Gen", "description: Generate a sprite sheet", "---", "Do sprites."].join("\n"),
    );
    await writeConfig("skills/sprite-gen/gen.py", "print('hi')\n");
    // Layout B: a flat single-file skill.
    await writeConfig(
      "skills/add-npc.md",
      ["---", "name: Add NPC", "description: Import a new enemy", "---", "Add the NPC."].join("\n"),
    );

    const svc = new ProjectConfigService({ store, bus });
    const result = await svc.load(project);
    expect(result.errors).toEqual([]);
    const skills = result.config!.skills;
    expect(skills.map((s) => s.id).sort()).toEqual(["add-npc", "sprite-gen"]);

    const dirSkill = skills.find((s) => s.id === "sprite-gen")!;
    expect(dirSkill).toMatchObject({
      name: "Sprite Gen",
      description: "Generate a sprite sheet",
      dir: "sprite-gen",
      layout: "dir",
    });
    expect(dirSkill.path.replace(/\\/g, "/")).toContain("skills/sprite-gen/SKILL.md");

    const flatSkill = skills.find((s) => s.id === "add-npc")!;
    expect(flatSkill).toMatchObject({
      name: "Add NPC",
      description: "Import a new enemy",
      dir: "add-npc",
      layout: "flat",
    });
    expect(flatSkill.path.replace(/\\/g, "/")).toContain("skills/add-npc.md");
  });

  it("names a skill from its dir/file when frontmatter has no name", async () => {
    const project = await seedProject();
    await writeConfig("project.yaml", "name: X");
    await writeConfig("skills/lonely/SKILL.md", "Just a body, no frontmatter.");
    const svc = new ProjectConfigService({ store, bus });
    const skills = (await svc.load(project)).config!.skills;
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ id: "lonely", name: "lonely", dir: "lonely", layout: "dir" });
  });

  it("a skill dir without SKILL.md → structured `skill` error, other skills still load", async () => {
    const project = await seedProject();
    await writeConfig("project.yaml", "name: X");
    await writeConfig("skills/good/SKILL.md", ["---", "name: Good", "---", "ok"].join("\n"));
    // A directory with no SKILL.md is malformed.
    await writeConfig("skills/broken/notes.txt", "not a skill");
    const svc = new ProjectConfigService({ store, bus });
    const result = await svc.load(project);
    expect(result.config!.skills.map((s) => s.id)).toEqual(["good"]);
    expect(
      result.errors.some((e) => e.scope === "skill" && e.file === "broken/SKILL.md"),
    ).toBe(true);
  });

  it("exposes config skills via getSkills after a reload (empty before / for unknown)", async () => {
    await seedProject({ name: "Seed" });
    await writeConfig("project.yaml", "name: X");
    await writeConfig("skills/foo/SKILL.md", ["---", "name: Foo", "---", "b"].join("\n"));
    const svc = new ProjectConfigService({ store, bus });
    expect(svc.getSkills("p1")).toEqual([]); // nothing loaded yet
    await svc.reload("p1");
    expect(svc.getSkills("p1").map((s) => s.id)).toEqual(["foo"]);
    expect(svc.getSkills("nope")).toEqual([]);
  });

  it("no skills/ dir → empty skills array (never an error)", async () => {
    const project = await seedProject();
    await writeConfig("project.yaml", "name: X");
    const svc = new ProjectConfigService({ store, bus });
    const result = await svc.load(project);
    expect(result.config!.skills).toEqual([]);
    expect(result.errors.some((e) => e.scope === "skill")).toBe(false);
  });
});

/* ------------------------------------------------------------ resilience */

describe("ProjectConfigService — resilience (structured errors, never a throw)", () => {
  it("malformed YAML manifest → manifest error, config null (no throw)", async () => {
    const project = await seedProject();
    await writeConfig("project.yaml", "name: X\n  : : bad yaml : :\n\t- broken");
    const svc = new ProjectConfigService({ store, bus });
    const result = await svc.load(project);
    expect(result.config).toBeNull();
    expect(result.sourceDir).toContain(".dispatch");
    expect(result.errors.some((e) => e.scope === "manifest")).toBe(true);
  });

  it("manifest missing required `name` → manifest schema error", async () => {
    const project = await seedProject();
    await writeConfig("project.yaml", "worktree: pnpm worktree");
    const svc = new ProjectConfigService({ store, bus });
    const result = await svc.load(project);
    expect(result.config).toBeNull();
    expect(result.errors[0]?.scope).toBe("manifest");
  });

  it("a referenced instruction file that is missing → per-file error, config still loads", async () => {
    const project = await seedProject();
    await writeConfig("project.yaml", ["name: X", "instructions:", "  - file: instructions/missing.md"].join("\n"));
    const svc = new ProjectConfigService({ store, bus });
    const result = await svc.load(project);
    expect(result.config).not.toBeNull();
    expect(result.errors.some((e) => e.scope === "instruction" && e.file === "instructions/missing.md")).toBe(true);
  });

  it("a bad mode file (no permissionMode) → mode error, other modes load", async () => {
    const project = await seedProject();
    await writeConfig("project.yaml", "name: X");
    await writeConfig("modes/good.yaml", ["name: Good", "permissionMode: default"].join("\n"));
    await writeConfig("modes/bad.yaml", ["name: Bad", "description: no perm mode"].join("\n"));
    const svc = new ProjectConfigService({ store, bus });
    const result = await svc.load(project);
    expect(result.config!.modes.map((m) => m.id)).toEqual(["good"]);
    expect(result.errors.some((e) => e.scope === "mode" && e.file === "bad.yaml")).toBe(true);
  });
});

/* ------------------------------------------------------- no-dir fallback */

describe("ProjectConfigService — back-compat (no .dispatch/)", () => {
  it("no dir → { sourceDir: null, config: null } and the store project is untouched", async () => {
    const project = await seedProject({ name: "Untouched", worktreeCmd: "pnpm worktree" });
    const svc = new ProjectConfigService({ store, bus });

    const result = await svc.reload("p1");
    expect(result).toMatchObject({ sourceDir: null, config: null, errors: [] });

    // No project mutation — the .data record is used as-is.
    const stored = await store.getProject("p1");
    expect(stored).toMatchObject({ name: "Untouched", worktreeCmd: "pnpm worktree" });
    expect(events.some((e) => e.type === "project-update")).toBe(false);

    // A config-update still fires so the UI knows there's no authored config.
    const cfgEvt = events.find((e) => e.type === "project-config-update");
    expect(cfgEvt).toMatchObject({ projectId: "p1", sourceDir: null, config: null });
    void project;
  });
});

/* ----------------------------------------------------------- sync + reload */

describe("ProjectConfigService — reload syncs the store (authored overrides .data)", () => {
  it("merges authored fields onto the stored project + emits project-update", async () => {
    await seedProject({ name: "Seed", worktreeCmd: "old-cmd", mcpServers: { keep: { type: "stdio", command: "keep" } } });
    await writeConfig(
      "project.yaml",
      [
        "name: Authored",
        "worktree: new-cmd",
        "subApps:",
        "  - id: app",
        "    name: app",
        "    cwd: apps/app",
        "mcpServers:",
        "  - name: chrome",
        "    transport: { type: stdio, command: npx }",
      ].join("\n"),
    );

    const svc = new ProjectConfigService({ store, bus });
    const result = await svc.reload("p1");
    expect(result.config?.name).toBe("Authored");

    const stored = (await store.getProject("p1"))!;
    // Authored wins.
    expect(stored.name).toBe("Authored");
    expect(stored.worktreeCmd).toBe("new-cmd");
    expect(stored.subApps[0]).toMatchObject({ id: "app", path: "apps/app" });
    // mcpServers merge: authored `chrome` added, stored `keep` preserved.
    expect(stored.mcpServers?.chrome).toMatchObject({ command: "npx" });
    expect(stored.mcpServers?.keep).toMatchObject({ command: "keep" });
    // Identity preserved.
    expect(stored.id).toBe("p1");
    expect(stored.repoPath).toBe(repoDir);

    expect(events.some((e) => e.type === "project-update")).toBe(true);
    expect(events.some((e) => e.type === "project-config-update")).toBe(true);
    expect(svc.hasConfig("p1")).toBe(true);
    expect(svc.getConfig("p1")?.name).toBe("Authored");
  });

  it("a second identical reload does NOT re-persist / re-emit project-update", async () => {
    await seedProject({ name: "Seed" });
    await writeConfig("project.yaml", "name: Authored");
    const svc = new ProjectConfigService({ store, bus });
    await svc.reload("p1");
    const countAfterFirst = events.filter((e) => e.type === "project-update").length;
    await svc.reload("p1");
    const countAfterSecond = events.filter((e) => e.type === "project-update").length;
    expect(countAfterSecond).toBe(countAfterFirst); // no churn
  });
});

describe("ProjectConfigService — mergeProject precedence", () => {
  it("keeps stored values for fields the manifest omits", async () => {
    const stored = await seedProject({ name: "Seed", worktreeCmd: "keep-cmd", shipCmd: "keep-ship" });
    const svc = new ProjectConfigService({ store, bus });
    await writeConfig("project.yaml", "name: Authored");
    const cfg = (await svc.load(stored)).config!;
    const merged = mergeProject(stored, cfg);
    expect(merged.name).toBe("Authored");
    // Omitted authored fields fall back to the stored record.
    expect(merged.worktreeCmd).toBe("keep-cmd");
    expect(merged.shipCmd).toBe("keep-ship");
  });

  it("MERGES subApps by id: config overrides a colliding id, a .data-only sub-app survives", async () => {
    const stored = await seedProject({
      name: "Seed",
      subApps: [
        { id: "game", name: "Game (data)", path: "apps/old", dev: "old-dev" },
        { id: "metrics", name: "Metrics", path: "services/metrics", dev: "metrics-dev" },
      ],
    });
    const svc = new ProjectConfigService({ store, bus });
    await writeConfig(
      "project.yaml",
      [
        "name: Authored",
        "subApps:",
        "  - id: game",
        "    name: Game (config)",
        "    cwd: apps/new",
        "    dev: new-dev",
        "    ports: [5173]",
        "    docker: docker-compose.yml",
      ].join("\n"),
    );
    const cfg = (await svc.load(stored)).config!;
    const merged = mergeProject(stored, cfg);

    const byId = Object.fromEntries(merged.subApps.map((s) => [s.id, s]));
    // Config wins on the colliding `game` id — its dev/ports/docker are used.
    expect(byId.game).toMatchObject({
      name: "Game (config)",
      path: "apps/new",
      dev: "new-dev",
      ports: [5173],
      dockerCompose: "docker-compose.yml",
    });
    // The .data-only `metrics` sub-app survives (not dropped).
    expect(byId.metrics).toMatchObject({ path: "services/metrics", dev: "metrics-dev" });
    // No duplicate ids.
    expect(merged.subApps.map((s) => s.id).sort()).toEqual(["game", "metrics"]);
  });

  it("getMcpServers / getSubApps expose the config-sourced set (empty for an unconfigured project)", async () => {
    await seedProject({ name: "Seed" });
    await writeConfig(
      "project.yaml",
      [
        "name: Authored",
        "subApps:",
        "  - id: app",
        "    name: App",
        "    cwd: apps/app",
        "    dev: pnpm dev",
        "mcpServers:",
        "  - name: chrome",
        "    transport: { type: stdio, command: npx, args: [ -y, chrome-mcp ] }",
      ].join("\n"),
    );
    const svc = new ProjectConfigService({ store, bus });
    // Before load → nothing (no config cached yet).
    expect(svc.getMcpServers("p1")).toEqual({});
    expect(svc.getSubApps("p1")).toEqual([]);

    await svc.reload("p1");
    expect(svc.getMcpServers("p1").chrome).toMatchObject({ type: "stdio", command: "npx" });
    expect(svc.getSubApps("p1")[0]).toMatchObject({ id: "app", path: "apps/app", dev: "pnpm dev" });
    // An unknown project → empty (never throws).
    expect(svc.getMcpServers("nope")).toEqual({});
    expect(svc.getSubApps("nope")).toEqual([]);
  });
});

/* ------------------------------------------------ agent/mode registry (P3) */

describe("project-config registry helpers", () => {
  it("mergeById lets `preferred` win on id collision, keeping unique fallbacks", () => {
    const preferred = [{ id: "a", v: 1 }, { id: "b", v: 1 }];
    const fallback = [{ id: "b", v: 2 }, { id: "c", v: 2 }];
    const merged = mergeById(preferred, fallback);
    expect(merged.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(merged.find((e) => e.id === "b")?.v).toBe(1); // preferred won
    expect(merged.find((e) => e.id === "c")?.v).toBe(2); // unique fallback kept
  });

  it("configModeToModeConfig maps a ConfigMode onto the store ModeConfig shape", () => {
    const mode = configModeToModeConfig(
      { id: "careful", name: "Careful", permissionMode: "plan", allowedTools: ["Read"] },
      "p1",
    );
    expect(mode).toMatchObject({
      id: "careful",
      name: "Careful",
      permissionMode: "plan",
      scope: "project",
      projectId: "p1",
    });
  });

  it("renderInstructionsInjection delimits non-empty text and returns null for blank", () => {
    const out = renderInstructionsInjection("House rules here.");
    expect(out).toContain("Project instructions");
    expect(out).toContain(".dispatch/");
    expect(out).toContain("House rules here.");
    expect(renderInstructionsInjection("")).toBeNull();
    expect(renderInstructionsInjection("   \n  ")).toBeNull();
    expect(renderInstructionsInjection(undefined)).toBeNull();
  });
});

describe("ProjectConfigService — agent/mode/instruction registry (config-sourced)", () => {
  async function loadedService(): Promise<ProjectConfigService> {
    await seedProject();
    await writeConfig(
      "project.yaml",
      ["name: X", "instructions:", "  - file: instructions/house.md"].join("\n"),
    );
    await writeConfig("instructions/house.md", "Always run pnpm lint before shipping.");
    await writeConfig(
      "agents/builder.md",
      ["---", "name: Builder", "permissionMode: plan", "---", "You are a builder."].join("\n"),
    );
    await writeConfig("modes/careful.yaml", ["name: Careful", "permissionMode: plan"].join("\n"));
    const svc = new ProjectConfigService({ store, bus });
    await svc.reload("p1");
    return svc;
  }

  it("exposes config agents + modes through the registry accessors after a reload", async () => {
    const svc = await loadedService();

    expect(svc.configAgents().map((a) => a.id)).toEqual(["builder"]);
    expect(svc.getAgent("builder")).toMatchObject({
      id: "builder",
      permissionMode: "plan",
      scope: "project",
      projectId: "p1",
      instructions: "You are a builder.",
    });
    expect(svc.getAgent("nope")).toBeNull();

    expect(svc.configModes().map((m) => m.id)).toEqual(["careful"]);
    expect(svc.getMode("careful")).toMatchObject({
      id: "careful",
      permissionMode: "plan",
      scope: "project",
      projectId: "p1",
    });
    expect(svc.getMode("nope")).toBeNull();
  });

  it("builds a bounded, delimited instructions injection (empty project → null)", async () => {
    const svc = await loadedService();
    const injection = svc.buildInstructionsInjection("p1");
    expect(injection).toContain("Project instructions");
    expect(injection).toContain("Always run pnpm lint before shipping.");

    // A project with no loaded config injects nothing.
    expect(svc.buildInstructionsInjection("absent")).toBeNull();
  });

  it("registry is empty before any config is loaded (no cache entry)", () => {
    const svc = new ProjectConfigService({ store, bus });
    expect(svc.configAgents()).toEqual([]);
    expect(svc.configModes()).toEqual([]);
    expect(svc.getAgent("builder")).toBeNull();
    expect(svc.getMode("careful")).toBeNull();
    expect(svc.buildInstructionsInjection("p1")).toBeNull();
  });
});

/* --------------------------------------------------------------- watcher */

describe("ProjectConfigService — watch + debounced reload", () => {
  it("a watch event debounced-reloads and emits project-config-update", async () => {
    const project = await seedProject();
    await writeConfig("project.yaml", "name: V1");
    const watch = captureWatch();
    const svc = new ProjectConfigService({ store, bus, debounceMs: 15, watch: watch.factory });

    await svc.reload("p1");
    expect(svc.getConfig("p1")?.name).toBe("V1");
    svc.watchProject(project);

    // Author a change on disk, then fire the watcher.
    await writeConfig("project.yaml", "name: V2");
    events.length = 0;
    watch.trigger();
    // Not yet — still within the debounce window.
    expect(svc.getConfig("p1")?.name).toBe("V1");
    // Wait on the EVENT, which the service publishes after swapping the config in
    // — waiting on the config alone can win the race and see no event yet.
    await waitFor(() => events.some((e) => e.type === "project-config-update"));

    expect(svc.getConfig("p1")?.name).toBe("V2");

    svc.stop();
    expect(watch.closed()).toBe(true);
  });

  it("watchProject is a no-op when the project has no .dispatch/ dir", async () => {
    const project = await seedProject();
    const watch = captureWatch();
    const svc = new ProjectConfigService({ store, bus, watch: watch.factory });
    svc.watchProject(project);
    // Nothing watched → trigger does nothing, stop closes nothing.
    watch.trigger();
    svc.stop();
    expect(watch.closed()).toBe(false);
  });
});

/* ------------------------------------------------- mcpServers env expansion */

describe("ProjectConfigService — MCP server ${VAR} expansion", () => {
  /** Set env vars for one test and restore them afterwards. */
  function withEnv(vars: Record<string, string | undefined>): () => void {
    const prev = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return () => {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
  }

  it("expands placeholders in headers, env, args and url at load time", async () => {
    const restore = withEnv({ CM_TEST_KEY: "s3cret", CM_TEST_HOST: "mcp.example.com" });
    try {
      const project = await seedProject();
      await writeConfig(
        "project.yaml",
        [
          "name: Configured",
          "mcpServers:",
          "  - name: remote",
          "    transport:",
          "      type: http",
          "      url: https://${CM_TEST_HOST}/mcp",
          "      headers:",
          "        Authorization: Bearer ${CM_TEST_KEY}",
          "  - name: local",
          "    transport:",
          "      type: stdio",
          "      command: npx",
          "      args: ['--region', '${CM_TEST_REGION:-us-east-1}']",
          "      env:",
          "        API_KEY: ${CM_TEST_KEY}",
          "",
        ].join("\n"),
      );

      const svc = new ProjectConfigService({ store, bus });
      const result = await svc.load(project);
      const servers = result.config!.mcpServers;

      expect(servers.remote).toMatchObject({
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer s3cret" },
      });
      expect(servers.local).toMatchObject({
        // The `:-` default fills in for the unset CM_TEST_REGION.
        args: ["--region", "us-east-1"],
        env: { API_KEY: "s3cret" },
      });
      expect(result.errors).toEqual([]);
    } finally {
      restore();
    }
  });

  it("reports an unset variable as a config error without failing the load", async () => {
    const restore = withEnv({ CM_TEST_ABSENT: undefined });
    try {
      const project = await seedProject();
      await writeConfig(
        "project.yaml",
        [
          "name: Configured",
          "mcpServers:",
          "  - name: remote",
          "    transport:",
          "      type: http",
          "      url: https://example.com/mcp",
          "      headers:",
          "        Authorization: Bearer ${CM_TEST_ABSENT}",
          "",
        ].join("\n"),
      );

      const svc = new ProjectConfigService({ store, bus });
      const result = await svc.load(project);

      // The server is still built (one missing key must not break the project)…
      expect(result.config!.mcpServers.remote).toMatchObject({
        headers: { Authorization: "Bearer " },
      });
      // …but the gap is surfaced, naming the variable.
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.message).toContain("CM_TEST_ABSENT");
      expect(result.errors[0]!.message).toContain("remote");
    } finally {
      restore();
    }
  });
});
