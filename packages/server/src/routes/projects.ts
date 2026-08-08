/**
 * REST CRUD for projects. A project = one repo with many subApps.
 *   GET    /api/projects            → Project[]
 *   POST   /api/projects            → create (id/createdAt/subApps defaulted)
 *   GET    /api/projects/:id        → Project | 404
 *   PUT    /api/projects/:id        → replace/merge
 *   DELETE /api/projects/:id        → 204
 *   GET    /api/projects/:id/worktrees → WorktreeInfo[] (live `git worktree list`)
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { ProjectSchema, type Project } from "@dispatch/shared";
import { enclosingRepoRoot } from "./fs.js";

/**
 * Make sure `repoPath` is a git repo: create the directory if it's missing, and
 * `git init` it if it isn't inside one yet. The "I'm starting a project, not
 * adopting one" half of project create.
 *
 * Only runs when the caller explicitly asked (`initRepo: true`), and only when
 * the path isn't ALREADY INSIDE a repo — so it can't touch an existing checkout,
 * and the worst case for a mistyped path is one empty repo rather than a damaged
 * one. Deciding here rather than trusting the client's read of the path is what
 * makes that guarantee hold: the form probed the disk a moment ago, and a moment
 * is long enough for the answer to have changed.
 *
 * That check walks UP (`enclosingRepoRoot`), not just one level. `apps/service`
 * inside a monorepo has no `.git` of its own but is thoroughly tracked, and
 * `git init`-ing it there yields a nested repo whose worktrees and diffs
 * describe an empty tree while the real history sits in the outer checkout.
 *
 * `git init` on a directory that already has files is additive — it writes
 * `.git/` and nothing else — which is why an untracked folder with content is
 * offered the same path instead of being refused.
 *
 * Failures are surfaced, not swallowed: a project whose checkout doesn't exist
 * can't run a session, so silently continuing would just move the error to a
 * confusing place later.
 */
async function ensureRepo(
  app: FastifyInstance,
  repoPath: string,
  defaultBranch: string,
): Promise<void> {
  // A relative path resolves against the SERVER's cwd — which would quietly
  // create a repo inside the Dispatch install — and leaves a stored `repoPath`
  // that means something different every time the server's cwd changes.
  if (!isAbsolute(repoPath)) {
    throw new Error("repo path must be absolute");
  }
  if (enclosingRepoRoot(repoPath)) return;
  await mkdir(repoPath, { recursive: true });
  // `-b <trunk>` up front rather than a rename after: the project record already
  // says which branch is the trunk, and an `init` that lands on `master` while
  // the config says `main` breaks every diff-vs-base in the app.
  await app.services.git.init(repoPath, defaultBranch);
}

export function registerProjectRoutes(app: FastifyInstance): void {
  const { store, bus } = app.cm;
  const { worktrees, projectConfigArchive } = app.services;

  app.get("/api/projects", async () => store.listProjects());

  app.post("/api/projects", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const draft = {
      subApps: [],
      ...body,
      id: (body.id as string) || nanoid(),
      createdAt: (body.createdAt as number) ?? Date.now(),
    };
    const parsed = ProjectSchema.safeParse(draft);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }

    // `initRepo` is read off the raw body, not the parsed project: it's an
    // instruction about the create, not a field of the thing being created
    // (ProjectSchema strips it, which is exactly right).
    if (body.initRepo === true) {
      try {
        await ensureRepo(app, parsed.data.repoPath, parsed.data.defaultBranch || "main");
      } catch (err) {
        return reply.code(400).send({
          error: `could not create ${parsed.data.repoPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }

    const saved = await store.saveProject(parsed.data);
    bus.publish({ type: "project-update", project: saved });
    // Auto-scaffold a committable `.dispatch/` for the new project from its
    // `.data` record, so a UI-created project gets its source-of-truth folder
    // without a separate step. Best-effort (never fails the create) and only into
    // a repo that already exists on disk — a mistyped path shouldn't materialize
    // stray directories. Scaffold is a no-op when a `.dispatch/` is present,
    // and its reload re-syncs + emits the merged project-update.
    if (existsSync(saved.repoPath)) {
      await projectConfigArchive.scaffold(saved.id).catch(() => {});
    }
    return reply.code(201).send(saved);
  });

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (req, reply) => {
      const project = await store.getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "not found" });
      return project;
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (req, reply) => {
      const existing = await store.getProject(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = {
        subApps: [],
        createdAt: existing?.createdAt ?? Date.now(),
        ...existing,
        ...body,
        id: req.params.id,
      };
      const parsed = ProjectSchema.safeParse(merged);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      const saved = await store.saveProject(parsed.data);
      bus.publish({ type: "project-update", project: saved });
      return saved;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (req, reply) => {
      await store.deleteProject(req.params.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/worktrees",
    async (req, reply) => {
      const project: Project | null = await store.getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "not found" });
      try {
        return await worktrees.list(project);
      } catch (err) {
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
