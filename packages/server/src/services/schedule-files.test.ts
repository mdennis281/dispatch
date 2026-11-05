import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@dispatch/shared";
import { Store } from "../store/index.js";
import { EventBus } from "../bus.js";
import { ProjectConfigService } from "./project-config.js";
import { configPathsFor } from "./config-location.js";
import { deleteScheduleFile, renderScheduleFile, writeScheduleFile } from "./schedule-files.js";

let dataDir: string;
let repoDir: string;
let store: Store;
let project: Project;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cm-sched-data-"));
  repoDir = await mkdtemp(join(tmpdir(), "cm-sched-repo-"));
  store = new Store(dataDir);
  await store.init();
  project = await store.saveProject({
    id: "p1",
    name: "Repo",
    repoPath: repoDir,
    worktreeRoot: join(repoDir, "..", "wt"),
    defaultBranch: "main",
    subApps: [],
    createdAt: 1,
  });
});
afterEach(async () => {
  store.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const load = () => new ProjectConfigService({ store, bus: new EventBus() }).load(project);
const paths = () => configPathsFor(project, store.projectConfigDir(project.id))!;

async function writeRaw(file: string, body: string): Promise<void> {
  const dir = join(repoDir, ".dispatch", "schedules");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), body, "utf8");
}

describe("schedule files", () => {
  it("round-trips through the loader, scaffolding a config dir the project didn't have", async () => {
    await writeScheduleFile(paths(), {
      id: "nightly-audit",
      name: "Nightly audit",
      cron: "30 2 * * *",
      timezone: "America/Chicago",
      prompt: "Audit the lockfile.\n\nReport anything new.",
      personaId: "reviewer",
      model: "claude-opus-5-5",
      effort: "high",
      catchUp: false,
    });
    const result = await load();
    expect(result.errors).toEqual([]);
    expect(result.config!.schedules).toEqual([
      {
        id: "nightly-audit",
        name: "Nightly audit",
        cron: "30 2 * * *",
        timezone: "America/Chicago",
        prompt: "Audit the lockfile.\n\nReport anything new.",
        personaId: "reviewer",
        model: "claude-opus-5-5",
        effort: "high",
        enabled: true,
        catchUp: false,
        file: "nightly-audit.md",
      },
    ]);
  });

  it("writes only what differs from the defaults", () => {
    const text = renderScheduleFile({ id: "x", name: "x", cron: "0 9 * * *", prompt: "Go." });
    expect(text).toBe("---\ncron: 0 9 * * *\n---\n\nGo.\n");
  });

  it("reports a bad schedule as a load error instead of dropping it silently", async () => {
    await writeRaw("too-often.md", "---\ncron: '* * * * *'\n---\nHi");
    await writeRaw("no-cron.md", "---\nname: x\n---\nHi");
    await writeRaw("empty.md", "---\ncron: '0 9 * * *'\n---\n");
    await writeRaw("Bad Name.md", "---\ncron: '0 9 * * *'\n---\nHi");
    await writeRaw("ok.md", "---\ncron: '0 9 * * *'\n---\nHi");
    // The manifest must exist for the loader to treat `.dispatch/` as a config dir.
    await writeFile(join(repoDir, ".dispatch", "project.yaml"), "name: Repo\n", "utf8");

    const result = await load();
    expect(result.config!.schedules!.map((s) => s.id)).toEqual(["ok"]);
    const errs = result.errors.filter((e) => e.scope === "schedule");
    expect(errs.map((e) => e.file).sort()).toEqual(["Bad Name.md", "empty.md", "no-cron.md", "too-often.md"]);
    expect(errs.find((e) => e.file === "too-often.md")!.message).toMatch(/every 5 minutes/);
  });

  it("refuses an id that could leave the schedules dir", async () => {
    await expect(deleteScheduleFile(paths(), "../project")).rejects.toThrow(/invalid schedule id/);
    await expect(
      writeScheduleFile(paths(), { id: "..\evil", name: "x", cron: "0 9 * * *", prompt: "Go." }),
    ).rejects.toThrow(/invalid schedule id/);
  });

  it("deletes a schedule's file and reports a missing one", async () => {
    const path = await writeScheduleFile(paths(), { id: "x", name: "x", cron: "0 9 * * *", prompt: "Go." });
    expect(await readFile(path, "utf8")).toContain("Go.");
    expect(await deleteScheduleFile(paths(), "x")).toBe(true);
    expect(await deleteScheduleFile(paths(), "x")).toBe(false);
  });
});
