/**
 * migrate-config — end-to-end against real temp git repos.
 *
 * The shapes here are the ones that actually exist on the machine this was
 * written for, because those are the cases that decide whether it is safe:
 *   - config fully COMMITTED, memories and all (anoxia, Fumigators, YesWeb),
 *   - config committed but memory gitignored (Dispatch, lanscape),
 *   - repo memories AND stale external memories (Hivebreak),
 *   - external memories with NO repo memories (cloudflare-dns-sync),
 *   - a repo that is not a git checkout at all.
 *
 * The load-bearing assertion is not "files arrived" — it is that the repo dir is
 * gone AND every byte is readable at the destination, verified separately from
 * the copy that produced it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "./migrate-config.mjs";

const git = (cwd, ...args) =>
  spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

async function seedRepo(root, name, { commit = true, gitignoreMemory = false } = {}) {
  const repo = join(root, name);
  await mkdir(join(repo, ".dispatch", "memory"), { recursive: true });
  await mkdir(join(repo, ".dispatch", "instructions"), { recursive: true });
  await writeFile(join(repo, ".dispatch", "project.yaml"), `name: ${name}\n`, "utf8");
  await writeFile(join(repo, ".dispatch", "instructions", "house.md"), "House rules.", "utf8");
  await writeFile(join(repo, ".dispatch", "memory", "a.md"), "memory a", "utf8");
  await writeFile(join(repo, ".dispatch", "memory", "b.md"), "memory b", "utf8");
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  if (gitignoreMemory) {
    await writeFile(join(repo, ".gitignore"), ".dispatch/memory/\n", "utf8");
  }
  if (commit) {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "seed");
  }
  return repo;
}

async function seedConfig(root, projects) {
  const configDir = join(root, "config");
  await mkdir(join(configDir, "projects"), { recursive: true });
  for (const p of projects) {
    await writeFile(
      join(configDir, "projects", `${p.id}.json`),
      JSON.stringify(p, null, 2),
      "utf8",
    );
  }
  return configDir;
}

test("dry run changes nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "mig-dry-"));
  try {
    const repo = await seedRepo(root, "alpha");
    const configDir = await seedConfig(root, [
      { id: "p1", name: "Alpha", repoPath: repo, worktreeRoot: "", subApps: [], createdAt: 1 },
    ]);
    const res = await main(["--config-dir", configDir], { DISPATCH_HOME: join(root, "none") });
    assert.equal(res.planned, 1);
    assert.ok(existsSync(join(repo, ".dispatch", "project.yaml")), "repo dir untouched");
    assert.ok(!existsSync(join(configDir, "projects", "p1", "project.yaml")), "nothing copied");
    const rec = JSON.parse(readFileSync(join(configDir, "projects", "p1.json"), "utf8"));
    assert.equal(rec.configLocation, undefined, "not pinned");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("fully committed config: copies, pins, and stages the deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "mig-committed-"));
  try {
    const repo = await seedRepo(root, "beta");
    const configDir = await seedConfig(root, [
      { id: "p1", name: "Beta", repoPath: repo, worktreeRoot: "", subApps: [], createdAt: 1 },
    ]);
    await main(["--config-dir", configDir, "--apply"], { DISPATCH_HOME: join(root, "none") });

    const ext = join(configDir, "projects", "p1");
    assert.equal(await readFile(join(ext, "project.yaml"), "utf8"), "name: beta\n");
    assert.equal(await readFile(join(ext, "memory", "a.md"), "utf8"), "memory a");
    assert.equal(await readFile(join(ext, "instructions", "house.md"), "utf8"), "House rules.");

    const rec = JSON.parse(readFileSync(join(configDir, "projects", "p1.json"), "utf8"));
    assert.equal(rec.configLocation, "external");

    assert.ok(!existsSync(join(repo, ".dispatch")), "repo config dir removed");
    // Staged, not committed: the deletions are in the index and HEAD still has them.
    const staged = git(repo, "diff", "--cached", "--name-only").stdout.trim().split("\n");
    assert.ok(staged.includes(".dispatch/project.yaml"), "deletion staged");
    assert.ok(staged.includes(".dispatch/memory/a.md"), "memory deletion staged");
    const head = git(repo, "log", "--oneline").stdout.trim().split("\n");
    assert.equal(head.length, 1, "nothing was committed for us");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("gitignored memory: untracked files are removed too", async () => {
  const root = await mkdtemp(join(tmpdir(), "mig-ignored-"));
  try {
    const repo = await seedRepo(root, "gamma", { gitignoreMemory: true });
    const configDir = await seedConfig(root, [
      { id: "p1", name: "Gamma", repoPath: repo, worktreeRoot: "", subApps: [], createdAt: 1 },
    ]);
    await main(["--config-dir", configDir, "--apply"], { DISPATCH_HOME: join(root, "none") });

    const ext = join(configDir, "projects", "p1");
    // The memories were never tracked, so only the copy protects them.
    assert.equal(await readFile(join(ext, "memory", "a.md"), "utf8"), "memory a");
    assert.equal(await readFile(join(ext, "memory", "b.md"), "utf8"), "memory b");
    assert.ok(!existsSync(join(repo, ".dispatch")), "repo config dir removed");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("repo memories overwrite stale external ones, and external-only survive", async () => {
  const root = await mkdtemp(join(tmpdir(), "mig-collide-"));
  try {
    const repo = await seedRepo(root, "delta");
    const configDir = await seedConfig(root, [
      { id: "p1", name: "Delta", repoPath: repo, worktreeRoot: "", subApps: [], createdAt: 1 },
    ]);
    // A stale copy of `a.md` plus one the repo has never heard of.
    const extMem = join(configDir, "projects", "p1", "memory");
    await mkdir(extMem, { recursive: true });
    await writeFile(join(extMem, "a.md"), "STALE", "utf8");
    await writeFile(join(extMem, "orphan.md"), "external only", "utf8");

    await main(["--config-dir", configDir, "--apply"], { DISPATCH_HOME: join(root, "none") });

    assert.equal(await readFile(join(extMem, "a.md"), "utf8"), "memory a", "repo copy wins");
    assert.equal(
      await readFile(join(extMem, "orphan.md"), "utf8"),
      "external only",
      "overlay, not replace — an external-only memory is not collateral",
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("uncommitted changes are carried across, not lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "mig-dirty-"));
  try {
    const repo = await seedRepo(root, "epsilon");
    // Modify a tracked file and add an untracked one — both must survive.
    await writeFile(join(repo, ".dispatch", "project.yaml"), "name: EDITED\n", "utf8");
    await writeFile(join(repo, ".dispatch", "memory", "new.md"), "brand new", "utf8");

    const configDir = await seedConfig(root, [
      { id: "p1", name: "Eps", repoPath: repo, worktreeRoot: "", subApps: [], createdAt: 1 },
    ]);
    await main(["--config-dir", configDir, "--apply"], { DISPATCH_HOME: join(root, "none") });

    const ext = join(configDir, "projects", "p1");
    assert.equal(await readFile(join(ext, "project.yaml"), "utf8"), "name: EDITED\n");
    assert.equal(await readFile(join(ext, "memory", "new.md"), "utf8"), "brand new");
    assert.ok(!existsSync(join(repo, ".dispatch")));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a non-git repo still migrates", async () => {
  const root = await mkdtemp(join(tmpdir(), "mig-nogit-"));
  try {
    const repo = join(root, "plain");
    await mkdir(join(repo, ".dispatch", "memory"), { recursive: true });
    await writeFile(join(repo, ".dispatch", "project.yaml"), "name: plain\n", "utf8");
    await writeFile(join(repo, ".dispatch", "memory", "a.md"), "memory a", "utf8");
    const configDir = await seedConfig(root, [
      { id: "p1", name: "Plain", repoPath: repo, worktreeRoot: "", subApps: [], createdAt: 1 },
    ]);
    await main(["--config-dir", configDir, "--apply"], { DISPATCH_HOME: join(root, "none") });
    assert.equal(
      await readFile(join(configDir, "projects", "p1", "memory", "a.md"), "utf8"),
      "memory a",
    );
    assert.ok(!existsSync(join(repo, ".dispatch")));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("--keep-repo copies and pins without deleting", async () => {
  const root = await mkdtemp(join(tmpdir(), "mig-keep-"));
  try {
    const repo = await seedRepo(root, "zeta");
    const configDir = await seedConfig(root, [
      { id: "p1", name: "Zeta", repoPath: repo, worktreeRoot: "", subApps: [], createdAt: 1 },
    ]);
    await main(["--config-dir", configDir, "--apply", "--keep-repo"], {
      DISPATCH_HOME: join(root, "none"),
    });
    assert.ok(existsSync(join(repo, ".dispatch", "project.yaml")), "repo dir kept");
    assert.ok(existsSync(join(configDir, "projects", "p1", "project.yaml")), "copied anyway");
    const rec = JSON.parse(readFileSync(join(configDir, "projects", "p1.json"), "utf8"));
    assert.equal(rec.configLocation, "external");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("skips a project already pinned external, and one with no repo config", async () => {
  const root = await mkdtemp(join(tmpdir(), "mig-skip-"));
  try {
    const repo = await seedRepo(root, "eta");
    const bare = join(root, "bare");
    await mkdir(bare, { recursive: true });
    const configDir = await seedConfig(root, [
      {
        id: "pinned", name: "Pinned", repoPath: repo, configLocation: "external",
        worktreeRoot: "", subApps: [], createdAt: 1,
      },
      { id: "bare", name: "Bare", repoPath: bare, worktreeRoot: "", subApps: [], createdAt: 1 },
    ]);
    const res = await main(["--config-dir", configDir, "--apply"], {
      DISPATCH_HOME: join(root, "none"),
    });
    assert.deepEqual(res.migrated, [], "nothing migrated");
    assert.ok(existsSync(join(repo, ".dispatch")), "a pinned project is left alone");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("--project limits the run to one", async () => {
  const root = await mkdtemp(join(tmpdir(), "mig-one-"));
  try {
    const a = await seedRepo(root, "theta");
    const b = await seedRepo(root, "iota");
    const configDir = await seedConfig(root, [
      { id: "pa", name: "Theta", repoPath: a, worktreeRoot: "", subApps: [], createdAt: 1 },
      { id: "pb", name: "Iota", repoPath: b, worktreeRoot: "", subApps: [], createdAt: 1 },
    ]);
    await main(["--config-dir", configDir, "--apply", "--project", "pa"], {
      DISPATCH_HOME: join(root, "none"),
    });
    assert.ok(!existsSync(join(a, ".dispatch")), "named project migrated");
    assert.ok(existsSync(join(b, ".dispatch")), "the other is untouched");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a relative repoPath is refused, not resolved against this process", async () => {
  const root = await mkdtemp(join(tmpdir(), "mig-rel-"));
  try {
    const configDir = await seedConfig(root, [
      { id: "p1", name: "Rel", repoPath: ".", worktreeRoot: "", subApps: [], createdAt: 1 },
    ]);
    const res = await main(["--config-dir", configDir, "--apply"], {
      DISPATCH_HOME: join(root, "none"),
    });
    // `.` resolves to a checkout of Dispatch when run from the repo — which has a
    // real `.dispatch/`. Migrating that would move THIS repo's config under some
    // unrelated project id.
    assert.deepEqual(res.migrated, []);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("running the CLI directly actually does something", async () => {
  // Every other test imports `main`, which cannot see the entrypoint guard at
  // the bottom of the module. That guard was wrong on Windows — `import.meta.url`
  // is `file:///C:/...` and the hand-built `file://` + path never matched — so
  // `node tools/app/migrate-config.mjs` printed NOTHING and exited 0. A tool
  // whose delivery seam is untested is a tool that can be a silent no-op.
  const root = await mkdtemp(join(tmpdir(), "mig-cli-"));
  try {
    const repo = await seedRepo(root, "kappa");
    const configDir = await seedConfig(root, [
      { id: "p1", name: "Kappa", repoPath: repo, worktreeRoot: "", subApps: [], createdAt: 1 },
    ]);
    const script = fileURLToPath(new URL("./migrate-config.mjs", import.meta.url));
    const r = spawnSync(process.execPath, [script, "--config-dir", configDir], {
      encoding: "utf8",
      env: { ...process.env, DISPATCH_HOME: join(root, "none") },
      windowsHide: true,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRY RUN/, "the CLI produced its plan");
    assert.match(r.stdout, /Kappa/, "and named the project");
    assert.ok(existsSync(join(repo, ".dispatch")), "a dry run still changed nothing");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a flag with no value is refused, not silently widened", async () => {
  const root = await mkdtemp(join(tmpdir(), "mig-argv-"));
  try {
    const repo = await seedRepo(root, "lambda");
    const configDir = await seedConfig(root, [
      { id: "p1", name: "Lambda", repoPath: repo, worktreeRoot: "", subApps: [], createdAt: 1 },
    ]);
    const env = { DISPATCH_HOME: join(root, "none") };
    // The dangerous shape: `--project` last means "every project", and
    // `--config-dir` last means "the real install".
    await assert.rejects(
      () => main(["--config-dir", configDir, "--apply", "--project"], env),
      /--project needs a value/,
    );
    await assert.rejects(
      () => main(["--apply", "--config-dir"], env),
      /--config-dir needs a value/,
    );
    // A flag swallowing the NEXT flag is the same bug wearing a value.
    await assert.rejects(
      () => main(["--config-dir", configDir, "--project", "--apply"], env),
      /--project needs a value/,
    );
    assert.ok(existsSync(join(repo, ".dispatch")), "nothing ran");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a record whose id is not a path segment is skipped, not followed", async () => {
  const root = await mkdtemp(join(tmpdir(), "mig-badid-"));
  try {
    const repo = await seedRepo(root, "mu");
    const configDir = await seedConfig(root, [
      { id: "good", name: "Good", repoPath: repo, worktreeRoot: "", subApps: [], createdAt: 1 },
    ]);
    // A record whose `id` would escape `config/projects/` if joined verbatim.
    // The filename cannot hold a separator, so the mismatch is the tell.
    const evilRepo = await seedRepo(root, "nu");
    await writeFile(
      join(configDir, "projects", "evil.json"),
      JSON.stringify({
        id: "../../../escaped", name: "Evil", repoPath: evilRepo,
        worktreeRoot: "", subApps: [], createdAt: 1,
      }, null, 2),
      "utf8",
    );
    // …and a stray file that is not a project record at all.
    await writeFile(join(configDir, "projects", "not.an.id.json"), "{}", "utf8");

    const res = await main(["--config-dir", configDir, "--apply"], {
      DISPATCH_HOME: join(root, "none"),
    });

    assert.deepEqual(res.migrated, ["good"], "only the valid record ran");
    assert.ok(existsSync(join(evilRepo, ".dispatch")), "the bad record touched nothing");
    assert.ok(!existsSync(join(configDir, "projects", "..", "..", "..", "escaped")));
    assert.ok(!existsSync(join(root, "escaped")), "nothing was written outside the config dir");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
