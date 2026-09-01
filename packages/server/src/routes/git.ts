/**
 * REST for the Source Control UI. Every endpoint is scoped to ONE repo
 * directory passed as `repoPath` — the project checkout or any of its worktrees
 * — mirroring how `/api/worktrees/*` already takes `worktreePath`.
 *
 *   GET    /api/git/status?repoPath=                 → GitStatus
 *   GET    /api/git/branches?repoPath=               → GitBranch[]
 *   GET    /api/git/log?repoPath=&limit=&ref=        → GitCommit[]
 *   GET    /api/git/commit-files?repoPath=&rev=      → GitCommitFile[]
 *   GET    /api/git/stashes?repoPath=                → GitStash[]
 *   GET    /api/git/file?repoPath=&relPath=&rev=     → WorktreeFile (Monaco)
 *   POST   /api/git/stage        {repoPath, paths?|all}
 *   POST   /api/git/unstage      {repoPath, paths?|all}
 *   POST   /api/git/discard      {repoPath, paths}        (destructive)
 *   POST   /api/git/commit       {repoPath, message, amend?}
 *   POST   /api/git/commit-message {repoPath, hint?}      → AI-drafted message
 *   POST   /api/git/checkout     {repoPath, branch, create?, from?}
 *   DELETE /api/git/branch       {repoPath, branch, force?}
 *   POST   /api/git/stash        {repoPath, message?, includeUntracked?}
 *   POST   /api/git/stash/apply  {repoPath, index, pop?}
 *   DELETE /api/git/stash        {repoPath, index}
 *   POST   /api/git/sync         {repoPath, op: fetch|pull|push, setUpstream?}
 *
 * Every failure comes back as `{ error }`: 400 for a bad request or a rejected
 * path/ref, 502 for a git command that ran and failed (the message is git's own
 * stderr, which is what the user actually needs to see — "your branch has no
 * upstream", "please commit your changes before switching").
 */
import type { FastifyInstance } from "fastify";
import { identifyMedia } from "../services/media-sniff.js";
import { mediaKind, mediaTypeFromName } from "../services/media-types.js";

/** git ran and refused → 502 with git's own words; guard rejections → 400. */
function fail(err: unknown): { code: number; body: { error: string } } {
  const message = err instanceof Error ? err.message : String(err);
  const isGuard =
    /^invalid (rev|path|relPath|stash index)|escapes the repo|no paths given|commit message is empty/.test(
      message,
    );
  return { code: isGuard ? 400 : 502, body: { error: message } };
}

export function registerGitRoutes(app: FastifyInstance): void {
  const { git, commitMessage } = app.services;

  /** Resolve + validate `repoPath`, replying 400 when it isn't a git repo. */
  async function repo(
    repoPath: string | undefined,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): Promise<string | null> {
    if (!repoPath) {
      reply.code(400).send({ error: "repoPath required" });
      return null;
    }
    try {
      await git.repoRoot(repoPath);
      return repoPath;
    } catch {
      reply.code(400).send({ error: `not a git repository: ${repoPath}` });
      return null;
    }
  }

  /* ------------------------------------------------------------- reading */

  app.get<{ Querystring: { repoPath?: string } }>(
    "/api/git/status",
    async (req, reply) => {
      const cwd = await repo(req.query.repoPath, reply);
      if (!cwd) return reply;
      try {
        return await git.status(cwd);
      } catch (err) {
        const { code, body } = fail(err);
        return reply.code(code).send(body);
      }
    },
  );

  app.get<{ Querystring: { repoPath?: string } }>(
    "/api/git/branches",
    async (req, reply) => {
      const cwd = await repo(req.query.repoPath, reply);
      if (!cwd) return reply;
      try {
        return await git.branches(cwd);
      } catch (err) {
        const { code, body } = fail(err);
        return reply.code(code).send(body);
      }
    },
  );

  app.get<{ Querystring: { repoPath?: string; limit?: string; ref?: string } }>(
    "/api/git/log",
    async (req, reply) => {
      const cwd = await repo(req.query.repoPath, reply);
      if (!cwd) return reply;
      const limit = Number(req.query.limit);
      try {
        return await git.log(cwd, {
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
          ref: req.query.ref || undefined,
        });
      } catch (err) {
        const { code, body } = fail(err);
        return reply.code(code).send(body);
      }
    },
  );

  app.get<{ Querystring: { repoPath?: string; rev?: string } }>(
    "/api/git/commit-files",
    async (req, reply) => {
      const cwd = await repo(req.query.repoPath, reply);
      if (!cwd) return reply;
      if (!req.query.rev) return reply.code(400).send({ error: "rev required" });
      try {
        return await git.commitFiles(cwd, req.query.rev);
      } catch (err) {
        const { code, body } = fail(err);
        return reply.code(code).send(body);
      }
    },
  );

  app.get<{ Querystring: { repoPath?: string } }>(
    "/api/git/stashes",
    async (req, reply) => {
      const cwd = await repo(req.query.repoPath, reply);
      if (!cwd) return reply;
      try {
        return await git.stashes(cwd);
      } catch (err) {
        const { code, body } = fail(err);
        return reply.code(code).send(body);
      }
    },
  );

  app.get<{ Querystring: { repoPath?: string; relPath?: string; rev?: string } }>(
    "/api/git/file/raw",
    async (req, reply) => {
      const cwd = await repo(req.query.repoPath, reply);
      if (!cwd) return reply;
      if (!req.query.relPath) {
        return reply.code(400).send({ error: "relPath required" });
      }
      try {
        const file = await git.readRawFile(cwd, req.query.relPath, req.query.rev);
        if (!file.exists) return reply.code(404).send({ error: "file not found" });
        const media = identifyMedia(file.content, mediaTypeFromName(file.path));
        if (mediaKind(media.mimeType) !== "image") {
          return reply.code(415).send({ error: "file is not a supported image" });
        }
        reply.header("content-type", media.mimeType);
        reply.header("content-length", String(file.content.length));
        reply.header("cache-control", "private, no-store");
        reply.header("x-content-type-options", "nosniff");
        // SVG is safe in an <img>, but pinning its own resource policy closes
        // the door if this endpoint is ever navigated to directly.
        if (media.mimeType === "image/svg+xml") {
          reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
        }
        return reply.send(file.content);
      } catch (err) {
        const { code, body } = fail(err);
        return reply.code(code).send(body);
      }
    },
  );

  app.get<{ Querystring: { repoPath?: string; relPath?: string; rev?: string } }>(
    "/api/git/file",
    async (req, reply) => {
      const cwd = await repo(req.query.repoPath, reply);
      if (!cwd) return reply;
      if (!req.query.relPath) {
        return reply.code(400).send({ error: "relPath required" });
      }
      try {
        return await git.readFile(cwd, req.query.relPath, req.query.rev);
      } catch (err) {
        const { code, body } = fail(err);
        return reply.code(code).send(body);
      }
    },
  );

  /* ------------------------------------------------------------ mutating */

  app.post("/api/git/stage", async (req, reply) => {
    const body = (req.body ?? {}) as {
      repoPath?: string;
      paths?: string[];
      all?: boolean;
    };
    const cwd = await repo(body.repoPath, reply);
    if (!cwd) return reply;
    try {
      if (body.all) await git.stageAll(cwd);
      else await git.stage(cwd, body.paths ?? []);
      return await git.status(cwd);
    } catch (err) {
      const { code, body: b } = fail(err);
      return reply.code(code).send(b);
    }
  });

  app.post("/api/git/unstage", async (req, reply) => {
    const body = (req.body ?? {}) as {
      repoPath?: string;
      paths?: string[];
      all?: boolean;
    };
    const cwd = await repo(body.repoPath, reply);
    if (!cwd) return reply;
    try {
      if (body.all) await git.unstageAll(cwd);
      else await git.unstage(cwd, body.paths ?? []);
      return await git.status(cwd);
    } catch (err) {
      const { code, body: b } = fail(err);
      return reply.code(code).send(b);
    }
  });

  // DESTRUCTIVE: throws away working-tree edits and deletes untracked files.
  // The client confirms before calling; there is no undo on the server side.
  app.post("/api/git/discard", async (req, reply) => {
    const body = (req.body ?? {}) as { repoPath?: string; paths?: string[] };
    const cwd = await repo(body.repoPath, reply);
    if (!cwd) return reply;
    try {
      await git.discard(cwd, body.paths ?? []);
      return await git.status(cwd);
    } catch (err) {
      const { code, body: b } = fail(err);
      return reply.code(code).send(b);
    }
  });

  app.post("/api/git/commit", async (req, reply) => {
    const body = (req.body ?? {}) as {
      repoPath?: string;
      message?: string;
      amend?: boolean;
    };
    const cwd = await repo(body.repoPath, reply);
    if (!cwd) return reply;
    try {
      const commit = await git.commit(cwd, body.message ?? "", {
        amend: body.amend,
      });
      return { commit, status: await git.status(cwd) };
    } catch (err) {
      const { code, body: b } = fail(err);
      return reply.code(code).send(b);
    }
  });

  app.post("/api/git/commit-message", async (req, reply) => {
    const body = (req.body ?? {}) as { repoPath?: string; hint?: string };
    const cwd = await repo(body.repoPath, reply);
    if (!cwd) return reply;
    try {
      return { message: await commitMessage.generate(cwd, { hint: body.hint }) };
    } catch (err) {
      // A generation failure is the user's problem to see (nothing staged, no
      // auth, model timeout) — surface the reason rather than a blank box.
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/git/checkout", async (req, reply) => {
    const body = (req.body ?? {}) as {
      repoPath?: string;
      branch?: string;
      create?: boolean;
      from?: string;
    };
    const cwd = await repo(body.repoPath, reply);
    if (!cwd) return reply;
    if (!body.branch) return reply.code(400).send({ error: "branch required" });
    try {
      await git.checkout(cwd, body.branch, {
        create: body.create,
        from: body.from,
      });
      return await git.status(cwd);
    } catch (err) {
      const { code, body: b } = fail(err);
      return reply.code(code).send(b);
    }
  });

  app.delete("/api/git/branch", async (req, reply) => {
    const body = (req.body ?? {}) as {
      repoPath?: string;
      branch?: string;
      force?: boolean;
    };
    const cwd = await repo(body.repoPath, reply);
    if (!cwd) return reply;
    if (!body.branch) return reply.code(400).send({ error: "branch required" });
    try {
      await git.deleteBranch(cwd, body.branch, { force: body.force });
      return await git.branches(cwd);
    } catch (err) {
      const { code, body: b } = fail(err);
      return reply.code(code).send(b);
    }
  });

  app.post("/api/git/stash", async (req, reply) => {
    const body = (req.body ?? {}) as {
      repoPath?: string;
      message?: string;
      includeUntracked?: boolean;
    };
    const cwd = await repo(body.repoPath, reply);
    if (!cwd) return reply;
    try {
      const message = await git.stashPush(cwd, {
        message: body.message,
        includeUntracked: body.includeUntracked,
      });
      return { message, stashes: await git.stashes(cwd), status: await git.status(cwd) };
    } catch (err) {
      const { code, body: b } = fail(err);
      return reply.code(code).send(b);
    }
  });

  app.post("/api/git/stash/apply", async (req, reply) => {
    const body = (req.body ?? {}) as {
      repoPath?: string;
      index?: number;
      pop?: boolean;
    };
    const cwd = await repo(body.repoPath, reply);
    if (!cwd) return reply;
    if (typeof body.index !== "number") {
      return reply.code(400).send({ error: "index required" });
    }
    try {
      const message = await git.stashApply(cwd, body.index, { pop: body.pop });
      return { message, stashes: await git.stashes(cwd), status: await git.status(cwd) };
    } catch (err) {
      const { code, body: b } = fail(err);
      return reply.code(code).send(b);
    }
  });

  app.delete("/api/git/stash", async (req, reply) => {
    const body = (req.body ?? {}) as { repoPath?: string; index?: number };
    const cwd = await repo(body.repoPath, reply);
    if (!cwd) return reply;
    if (typeof body.index !== "number") {
      return reply.code(400).send({ error: "index required" });
    }
    try {
      const message = await git.stashDrop(cwd, body.index);
      return { message, stashes: await git.stashes(cwd) };
    } catch (err) {
      const { code, body: b } = fail(err);
      return reply.code(code).send(b);
    }
  });

  app.post("/api/git/sync", async (req, reply) => {
    const body = (req.body ?? {}) as {
      repoPath?: string;
      op?: "fetch" | "pull" | "push";
      setUpstream?: boolean;
      branch?: string;
      remote?: string;
    };
    const cwd = await repo(body.repoPath, reply);
    if (!cwd) return reply;
    if (body.op !== "fetch" && body.op !== "pull" && body.op !== "push") {
      return reply.code(400).send({ error: "op must be fetch, pull or push" });
    }
    try {
      const message = await git.sync(cwd, body.op, {
        setUpstream: body.setUpstream,
        branch: body.branch,
        remote: body.remote,
      });
      return { message, status: await git.status(cwd) };
    } catch (err) {
      const { code, body: b } = fail(err);
      return reply.code(code).send(b);
    }
  });
}
