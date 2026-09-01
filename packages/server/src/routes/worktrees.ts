/**
 * REST for git worktrees.
 *   GET    /api/worktrees?scope=&projectId=&chatId=&q= → WorktreeInfo[] (catalog)
 *   GET    /api/branches?projectId=               → BranchInfo[] (launch picker)
 *   POST   /api/worktrees {projectId,branch,chatId?} → create
 *   DELETE /api/worktrees {worktreePath,chatId?,force?} → remove
 *   GET    /api/worktrees/diff?worktreePath=&base= → WorktreeDiff
 *   GET    /api/worktrees/file?worktreePath=&relPath=&ref= → WorktreeFile (Monaco)
 *   GET    /api/worktrees/image?worktreePath=&relPath= → raw image preview (25 MiB cap)
 *   PUT    /api/worktrees/file {worktreePath,relPath,content} → write (Monaco save)
 *   GET    /api/worktrees/refresh?projectId=      → force a detection pass
 *   GET    /api/worktrees/cleanup?projectId=&probe= → ReapPlan (what's stale)
 *   POST   /api/worktrees/cleanup {paths,deleteBranch?} → ReapResult (remove them)
 * Mutations run through the same service the WS `create-worktree`/`remove-worktree`
 * actions use (publishing `worktree-update` / `chat-update` / `notice`).
 */
import type { FastifyInstance } from "fastify";
import { mediaKind, parseRegistryQuery, RegistryQueryError } from "@dispatch/shared";
import { mediaTypeFromName } from "../services/media-types.js";
import { identifyMedia } from "../services/media-sniff.js";

/** Worktree images are served raw up to this limit; code/diffs stay at 2 MiB. */
export const IMAGE_PREVIEW_LIMIT_BYTES = 25 * 1024 * 1024;

export function registerWorktreeRoutes(app: FastifyInstance): void {
  const { store } = app.cm;
  const { worktrees, worktreeDetector, worktreeReaper } = app.services;

  // The catalog read. `?projectId=` keeps its old meaning (one project's trees);
  // with no projectId it sweeps every project, which is the app-wide scope the
  // Workspace view and the `worktree` MCP tool both ask for. `scope`/`chatId`/`q`
  // narrow it through the same predicate the client filters with.
  app.get("/api/worktrees", async (req, reply) => {
    try {
      // Inside the try: a filter we can't parse is a 400, not the 500 an escaped
      // zod error would produce.
      const query = parseRegistryQuery(req.query as Record<string, unknown>);
      if (query.scope === "project" || query.projectId) {
        if (!query.projectId) return [];
        const project = await store.getProject(query.projectId);
        if (!project) return reply.code(404).send({ error: "project not found" });
        return await worktrees.listAll([project], query);
      }
      return await worktrees.listAll(await store.listProjects(), query);
    } catch (err) {
      if (err instanceof RegistryQueryError) {
        return reply.code(400).send({ error: err.message });
      }
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{ Querystring: { projectId?: string } }>(
    "/api/branches",
    async (req, reply) => {
      if (!req.query.projectId) {
        return reply.code(400).send({ error: "projectId required" });
      }
      const project = await store.getProject(req.query.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      try {
        return await worktrees.listBranches(project);
      } catch (err) {
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post("/api/worktrees", async (req, reply) => {
    const body = (req.body ?? {}) as {
      projectId?: string;
      branch?: string;
      chatId?: string;
      base?: string;
    };
    if (!body.projectId || !body.branch) {
      return reply.code(400).send({ error: "projectId and branch required" });
    }
    const project = await store.getProject(body.projectId);
    if (!project) return reply.code(404).send({ error: "project not found" });
    try {
      const info = await worktrees.create(project, body.branch, {
        chatId: body.chatId,
        base: body.base,
      });
      return reply.code(201).send(info);
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/worktrees", async (req, reply) => {
    const body = (req.body ?? {}) as {
      worktreePath?: string;
      chatId?: string;
      force?: boolean;
    };
    if (!body.worktreePath) {
      return reply.code(400).send({ error: "worktreePath required" });
    }
    try {
      await worktrees.remove(body.worktreePath, {
        force: body.force,
        chatId: body.chatId,
      });
      return reply.code(204).send();
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{
    Querystring: {
      worktreePath?: string;
      relPath?: string;
      ref?: string;
      mergeBase?: string;
    };
  }>("/api/worktrees/file", async (req, reply) => {
    const { worktreePath, relPath, ref, mergeBase } = req.query;
    if (!worktreePath || !relPath) {
      return reply
        .code(400)
        .send({ error: "worktreePath and relPath required" });
    }
    try {
      return await worktrees.readFile(worktreePath, relPath, {
        ref: ref || undefined,
        // Opt-in, not the default: this reads the base side of a BRANCH diff,
        // where the merge-base is what the file list already used, but a caller
        // asking for an exact rev must still get that exact rev.
        mergeBase: mergeBase === "1" || mergeBase === "true",
      });
    } catch (err) {
      // relPath/ref guard failures are client errors; surface as 400.
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Serve an image preview without turning 25 MiB of bytes into a ~33 MiB
   * base64 JSON string. The client owns the resulting Blob URL and revokes it
   * when the preview closes.
   */
  app.get<{
    Querystring: { worktreePath?: string; relPath?: string };
  }>("/api/worktrees/image", async (req, reply) => {
    const { worktreePath, relPath } = req.query;
    if (!worktreePath || !relPath) {
      return reply
        .code(400)
        .send({ error: "worktreePath and relPath required" });
    }

    // Never trust the caller to define a filesystem root. Re-read the canonical
    // path from Dispatch's worktree registry before resolving the relative file.
    const record = await store.getWorktreeRecord(worktreePath);
    if (!record) return reply.code(403).send({ error: "unknown-worktree" });

    let file;
    try {
      file = await worktrees.readFile(record.path, relPath, {
        maxBytes: IMAGE_PREVIEW_LIMIT_BYTES,
      });
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
    if (!file.exists) return reply.code(404).send({ error: "not-found" });

    const content = Buffer.from(
      file.content,
      file.encoding === "base64" ? "base64" : "utf8",
    );
    const media = identifyMedia(content, mediaTypeFromName(file.path));
    // SVG and text-shaped image filenames (notably Git-LFS pointers) belong in
    // Monaco so their source/diff remains available. Only actual binary image
    // content takes the larger visual-preview path.
    if (!file.binary || mediaKind(media.mimeType) !== "image") {
      return reply.code(415).send({ error: "not-image" });
    }

    reply.header("content-type", media.mimeType);
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "private, no-store");
    reply.header("content-length", String(content.length));
    reply.header("x-dispatch-file-size", String(file.size));
    reply.header("x-dispatch-preview-limit", String(IMAGE_PREVIEW_LIMIT_BYTES));
    reply.header("x-dispatch-truncated", file.truncated ? "1" : "0");
    if (media.mimeType === "image/svg+xml") {
      reply.header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'",
      );
    }
    return reply.send(content);
  });

  // Save edited file content back to the working tree (editable Monaco config
  // editor). Path-guarded inside the service; the fs watcher on `.dispatch/`
  // picks up a project.yaml edit and re-syncs the project without a manual reload.
  app.put("/api/worktrees/file", async (req, reply) => {
    const body = (req.body ?? {}) as {
      worktreePath?: string;
      relPath?: string;
      content?: string;
    };
    if (!body.worktreePath || !body.relPath || typeof body.content !== "string") {
      return reply
        .code(400)
        .send({ error: "worktreePath, relPath and content required" });
    }
    try {
      return await worktrees.writeFile(
        body.worktreePath,
        body.relPath,
        body.content,
      );
    } catch (err) {
      // relPath guard / size-cap failures are client errors.
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Force a detection pass for a project (client "Refresh" button). Runs the same
  // attribution the poll/turn-complete triggers use, so a just-created worktree
  // shows up on demand without waiting for the ~4s poll or the turn to end.
  app.get<{ Querystring: { projectId?: string } }>(
    "/api/worktrees/refresh",
    async (req, reply) => {
      if (!req.query.projectId) {
        return reply.code(400).send({ error: "projectId required" });
      }
      const project = await store.getProject(req.query.projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      const results = await worktreeDetector.refreshProject(project.id);
      return {
        projectId: project.id,
        attached: results.flatMap((r) => r.attached),
        removed: results.flatMap((r) => r.removed),
      };
    },
  );

  /**
   * What the cleanup panel opens with.
   *
   * `probe=0` (the default) returns the CHEAP verdict for every tree — every
   * gate but "is the working tree dirty", answered from batched git and
   * in-memory state. That comes back in one round trip even for ninety trees.
   * `probe=1` then runs the real cleanliness probe over the survivors, which
   * costs ~35s PER TREE on this repo and is why it is a second, explicit call
   * the client makes behind a progress indicator rather than something baked
   * into the first paint.
   */
  app.get<{
    Querystring: { projectId?: string; probe?: string };
  }>("/api/worktrees/cleanup", async (req, reply) => {
    const probe = req.query.probe === "1" || req.query.probe === "true";
    try {
      return await worktreeReaper.plan({
        projectId: req.query.projectId,
        cheapOnly: !probe,
        // A human is watching this one, so it gets the complete answer rather
        // than the unattended sweep's deliberately small budget.
        probeCap: Infinity,
      });
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Remove the approved trees. Every path is RE-JUDGED at full depth first
   * (`reap` does it unless told not to): minutes pass between a human reading
   * the list and pressing the button, and a tree can go dirty in that window.
   * A path that no longer qualifies comes back as a failed outcome with its
   * blockers, not as a silent skip.
   */
  app.post("/api/worktrees/cleanup", async (req, reply) => {
    const body = (req.body ?? {}) as { paths?: string[]; deleteBranch?: boolean };
    if (!Array.isArray(body.paths) || body.paths.length === 0) {
      return reply.code(400).send({ error: "paths required" });
    }
    try {
      return await worktreeReaper.reap(body.paths, {
        deleteBranch: body.deleteBranch ?? false,
      });
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{ Querystring: { worktreePath?: string; base?: string } }>(
    "/api/worktrees/diff",
    async (req, reply) => {
      if (!req.query.worktreePath) {
        return reply.code(400).send({ error: "worktreePath required" });
      }
      try {
        return await worktrees.diffVsMain(
          req.query.worktreePath,
          req.query.base || "main",
        );
      } catch (err) {
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
