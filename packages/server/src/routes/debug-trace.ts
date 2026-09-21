/**
 * REST for interaction traces — the recordings the viewport readout's tracer
 * makes on a phone (`client/src/lib/interactionTrace.ts`).
 *
 *   POST /api/debug/trace         → { name }        save a recording
 *   GET  /api/debug/trace         → TraceFile[]     newest first
 *   GET  /api/debug/trace/:name   → the recording
 *
 * Why the server holds them at all: the device that records is an iPhone in
 * standalone mode, and the person reading is at a desktop — or an agent in a
 * chat — with no path between the two but this one. A clipboard copy works
 * when a human is carrying the phone to the desk; this is the path that works
 * when they are not. Files, not the database: a trace is a few hundred KB of
 * throwaway JSON that nothing queries, and a directory is what an agent can
 * `cat` when asked to "look at the trace".
 *
 * `data/debug-traces/`, capped at the newest {@link KEEP} so a debug session
 * can't fill a disk. Names are minted here, never taken from the request, and
 * the read path validates against the minted shape — the directory is under
 * the data root and a `..` in `:name` is the obvious way out of it.
 */
import type { FastifyInstance } from "fastify";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { payloadSha } from "../health.js";

const KEEP = 20;
const NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;

export interface TraceFile {
  name: string;
  size: number;
  savedAt: string;
}

function traceDir(app: FastifyInstance): string {
  return join(app.cm.config.dataDir, "debug-traces");
}

export function registerDebugTraceRoutes(app: FastifyInstance): void {
  app.post("/api/debug/trace", async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== "object" || !Array.isArray((body as { entries?: unknown }).entries)) {
      reply.code(400);
      return { error: "expected { meta, entries: [] }" };
    }
    const dir = traceDir(app);
    await mkdir(dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const record = {
      ...(body as object),
      // Stamped here rather than sent: the phone has no idea which build it is
      // running, and a trace against the wrong build has misled before.
      sha: payloadSha() ?? null,
      savedAt: new Date().toISOString(),
    };
    await writeFile(join(dir, name), JSON.stringify(record));

    const all = (await readdir(dir)).filter((f) => NAME.test(f)).sort();
    for (const stale of all.slice(0, Math.max(0, all.length - KEEP))) {
      await unlink(join(dir, stale)).catch(() => undefined);
    }
    return { name };
  });

  app.get("/api/debug/trace", async () => {
    const dir = traceDir(app);
    const names = await readdir(dir).catch(() => [] as string[]);
    const files: TraceFile[] = [];
    for (const name of names.filter((f) => NAME.test(f)).sort().reverse()) {
      const s = await stat(join(dir, name)).catch(() => null);
      if (s) files.push({ name, size: s.size, savedAt: s.mtime.toISOString() });
    }
    return files;
  });

  app.get<{ Params: { name: string } }>("/api/debug/trace/:name", async (req, reply) => {
    const { name } = req.params;
    if (!NAME.test(name)) {
      reply.code(400);
      return { error: "not a trace name" };
    }
    const text = await readFile(join(traceDir(app), name), "utf8").catch(() => null);
    if (text === null) {
      reply.code(404);
      return { error: "no such trace" };
    }
    reply.type("application/json");
    return text;
  });
}
