/**
 * REST for the usage ledger — everything the Metrics view reads.
 *
 *   POST /api/metrics/series  → MetricSeriesResponse  (the time chart)
 *   POST /api/metrics/totals  → MetricTotalsResponse  (bars / donut / table)
 *   POST /api/metrics/facets  → MetricFacetsResponse  (the filter controls)
 *   POST /api/metrics/recent  → MetricEvent[]         (the activity tail)
 *   GET  /api/metrics/stats   → ledger size + write health
 *   POST /api/metrics/prune   → drop rows older than `before`
 *
 * And the same five reads over the RUNTIME half of the ledger, which answers in
 * milliseconds rather than counts:
 *
 *   POST /api/metrics/spans/series   → MetricSpanSeriesResponse  (time over time)
 *   POST /api/metrics/spans/totals   → MetricSpanTotalsResponse  (the leaderboard)
 *   POST /api/metrics/spans/summary  → MetricSpanSummary         (the hero row)
 *   POST /api/metrics/spans/facets   → MetricSpanFacetsResponse  (filter controls)
 *   POST /api/metrics/spans/recent   → MetricSpan[]              (activity tail)
 *
 * And one read that is not over the ledger at all:
 *
 *   GET  /api/metrics/growth?projectId= → NDJSON of GrowthFrame  (the Growth tab)
 *
 * And the token ledger, in ONE read, since the Tokens tab's chart, table and
 * pick-lists all come from one small table and four round trips would make the
 * page settle four times:
 *
 *   POST /api/metrics/tokens → TokenReport
 *
 * And the limit history — every account's windows over time, the resets and
 * anomalies between readings, and what the sampler is doing right now:
 *
 *   POST /api/metrics/limits → LimitReport
 *
 * That one STREAMS. It walks the project's git history on every call — no
 * cache, by design (see `shared/growth.ts`) — and a long history takes long
 * enough that a bare pending request reads as a hung page. So the response is
 * newline-delimited JSON: progress frames as the walk goes, then exactly one
 * `result` or `error` frame. The reply is hijacked from Fastify's serializer
 * because a serializer wants one body, and this has many.
 *
 * Separate paths rather than a `measure` flag on the existing ones: the two
 * halves have different dimensions (a span has `state`, an event has `category`)
 * and different responses, so one endpoint would have to accept a filter it
 * might reject and return a union the client has to narrow anyway.
 *
 * POST for reads, deliberately. The query carries a FILTER — a map of dimension
 * to a list of allowed values — and encoding that into a query string means
 * inventing a nesting convention, then parsing it back, then discovering the URL
 * length limit the first time someone selects thirty tools. A JSON body is the
 * shape the data already has. Nothing here mutates except `prune`, which says so.
 *
 * Every read runs on the METRICS WORKER THREAD (services/metrics-reader.ts),
 * not here. `node:sqlite` is synchronous: a 7-day Runtime batch held this
 * server's event loop for ~9 s, and every chat, terminal and websocket frame
 * waited behind it. Only `prune` (a write) and `growth` (git, not SQLite)
 * stay on the main thread.
 *
 * Every body is zod-parsed before it reaches the service, so an unknown
 * dimension is a 400 here rather than a column name deeper in. (The service
 * never interpolates a value into SQL regardless — see `MetricsService.where` —
 * but a schema at the door means the error names the field.)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as z from "zod";
import {
  type GrowthFrame,
  MetricDimensionSchema,
  MetricFilterSchema,
  MetricQuerySchema,
  MetricSpanDimensionSchema,
  MetricSpanFilterSchema,
  MetricSpanQuerySchema,
  LimitQuerySchema,
  TokenQuerySchema,
  type LimitReport,
} from "@dispatch/shared";
import type { MetricsReadMethod, MetricsReadMethods } from "../services/metrics-read-api.js";
import { MetricsReadAborted } from "../services/metrics-reader.js";

/** The window + filter every read shares. */
const ScopeSchema = z.object({
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  filter: MetricFilterSchema.optional(),
});

const TotalsSchema = MetricQuerySchema.extend({ groupBy: MetricDimensionSchema });

const RecentSchema = ScopeSchema.extend({
  limit: z.number().int().min(1).max(500).default(100),
});

/**
 * Pruning takes an absolute cut-off rather than "keep N days" so the request
 * says exactly which rows it deletes. A relative window evaluated server-side
 * would delete a different set depending on how long the request sat in a queue.
 */
const PruneSchema = z.object({ before: z.number().int() });

/** The window + filter every runtime read shares. */
const SpanScopeSchema = z.object({
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  filter: MetricSpanFilterSchema.optional(),
});

const SpanTotalsSchema = MetricSpanQuerySchema.extend({ groupBy: MetricSpanDimensionSchema });

const SpanRecentSchema = SpanScopeSchema.extend({
  limit: z.number().int().min(1).max(500).default(100),
});

/**
 * Yield once, then say whether the client that sent this request has gone.
 *
 * WHY. Every read below is synchronous SQLite on the event loop and cannot be
 * interrupted once it starts, so the only saving left is not STARTING one
 * nobody will read. The Metrics page aborts a superseded batch (see the
 * client's `lib/latestLoad.ts`), but the batch's other requests had usually
 * already been parsed and were queued behind the first query, so each still
 * ran to completion: the request log's 71 s stall was batches like that stacked
 * end to end. The yield is what makes the check worth anything — it lets the
 * poll phase deliver the closes that arrived while the previous query held the
 * loop, so a request queued behind it sees its own socket already gone.
 *
 * The SOCKET is checked rather than `req.raw.destroyed`: the request stream
 * has been fully read by the time a handler runs, and whether an ended
 * IncomingMessage reports itself destroyed differs between Node versions. A
 * socket is only closed or half-closed here when the client went away.
 *
 * On true the reply is hijacked: there is nobody to answer, and Fastify writing
 * a response to a dead socket would only log an error per skipped read.
 */
async function clientGone(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const socket = req.raw.socket as { destroyed?: boolean; readableEnded?: boolean } | undefined;
  if (!socket?.destroyed && !socket?.readableEnded) return false;
  reply.hijack();
  return true;
}

/** What {@link registerMetricsRoutes}' `read` returns when there is nobody
 * left to answer. */
const GONE = Symbol("client gone");

export function registerMetricsRoutes(app: FastifyInstance): void {
  const { metrics, growth, metricsReader, limitSampler } = app.services;
  const { store } = app.cm;

  /**
   * Run one read on the metrics worker, abandoning it if the client goes.
   *
   * The response's `close` is the signal: it fires on a disconnect before we
   * have answered (and again, harmlessly, after we have — hence the
   * `writableFinished` test). An abandoned request still queued is dropped
   * without running; one already running stops at its next statement.
   */
  async function read<K extends MetricsReadMethod>(
    req: FastifyRequest,
    reply: FastifyReply,
    method: K,
    arg: MetricsReadMethods[K][0],
  ): Promise<MetricsReadMethods[K][1] | typeof GONE> {
    if (await clientGone(req, reply)) return GONE;
    const abort = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) abort.abort();
    };
    reply.raw.once("close", onClose);
    try {
      return await metricsReader.call(method, arg, abort.signal);
    } catch (err) {
      if (err instanceof MetricsReadAborted || abort.signal.aborted) {
        reply.hijack();
        return GONE;
      }
      throw err;
    } finally {
      reply.raw.off("close", onClose);
    }
  }

  /** {@link read}, for a route whose answer IS the read's result. */
  async function answer<K extends MetricsReadMethod>(
    req: FastifyRequest,
    reply: FastifyReply,
    method: K,
    arg: MetricsReadMethods[K][0],
  ): Promise<MetricsReadMethods[K][1] | FastifyReply> {
    const value = await read(req, reply, method, arg);
    return value === GONE ? reply : value;
  }

  app.post<{ Body: unknown }>("/api/metrics/limits", async (req, reply) => {
    const parsed = LimitQuerySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const settings = await store.getSettings().catch(() => null);
    const part = await read(req, reply, "limits", { query: parsed.data, settings });
    if (part === GONE) return reply;
    const { windows, yields, yieldsTruncatedBefore, events, stats } = part;
    const report: LimitReport = {
      windows,
      yields,
      yieldsTruncatedBefore,
      period: parsed.data.period,
      events,
      // In-memory sampler state: it lives on this thread, not in the database.
      accounts: limitSampler.status(),
      sampleRows: stats.rows,
      oldest: stats.oldest,
    };
    return report;
  });

  app.post<{ Body: unknown }>("/api/metrics/tokens", async (req, reply) => {
    const parsed = TokenQuerySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    // The settings travel with the query: the labeller built from them is a
    // function, and a function can't cross to the worker.
    const settings = await store.getSettings().catch(() => null);
    return answer(req, reply, "tokens", { query: parsed.data, settings });
  });

  app.post<{ Body: unknown }>("/api/metrics/series", async (req, reply) => {
    const parsed = MetricQuerySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return answer(req, reply, "series", parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/totals", async (req, reply) => {
    const parsed = TotalsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return answer(req, reply, "totals", parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/facets", async (req, reply) => {
    const parsed = ScopeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return answer(req, reply, "facets", parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/recent", async (req, reply) => {
    const parsed = RecentSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return answer(req, reply, "recent", parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/spans/series", async (req, reply) => {
    const parsed = MetricSpanQuerySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return answer(req, reply, "spanSeries", parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/spans/totals", async (req, reply) => {
    const parsed = SpanTotalsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return answer(req, reply, "spanTotals", parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/spans/summary", async (req, reply) => {
    const parsed = SpanScopeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return answer(req, reply, "spanSummary", parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/spans/facets", async (req, reply) => {
    const parsed = SpanScopeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return answer(req, reply, "spanFacets", parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/spans/recent", async (req, reply) => {
    const parsed = SpanRecentSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return answer(req, reply, "recentSpans", parsed.data);
  });

  // GET, unlike every read above: it takes no query at all. The whole ledger,
  // grouped by chat — see `MetricsService.chatRuntime` for why it isn't
  // `spans/totals` with a `groupBy`.
  app.get("/api/metrics/chat-runtime", async (req, reply) => answer(req, reply, "chatRuntime", undefined));

  // The two COUNT(*)s run on the worker; the buffer figures are this
  // thread's, since that is where the write buffer lives.
  app.get("/api/metrics/stats", async (req, reply) => {
    const counts = await read(req, reply, "ledgerCounts", undefined);
    if (counts === GONE) return reply;
    return { ...metrics.bufferStats(), ...counts };
  });

  app.post<{ Body: unknown }>("/api/metrics/prune", async (req, reply) => {
    const parsed = PruneSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return { deleted: metrics.prune(parsed.data.before) };
  });

  app.get<{ Querystring: { projectId?: string } }>(
    "/api/metrics/growth",
    async (req, reply) => {
      // The two refusals are ordinary JSON replies — only a walk that actually
      // starts becomes a stream, so a 400/404 stays a 400/404 to the client.
      const projectId = req.query.projectId;
      if (!projectId) return reply.code(400).send({ error: "projectId required" });
      const project = await store.getProject(projectId);
      if (!project) return reply.code(404).send({ error: "project not found" });

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        // Nothing between here and the browser may hold frames back: a proxy
        // that buffers the body turns the progress bar back into a spinner.
        "x-accel-buffering": "no",
      });
      const send = (frame: GrowthFrame): void => {
        if (!raw.writableEnded && !raw.destroyed) raw.write(`${JSON.stringify(frame)}\n`);
      };

      // A closed socket cancels the git walk; nobody is going to read it.
      const abort = new AbortController();
      raw.once("close", () => abort.abort());

      try {
        const report = await growth.walk({
          projectId,
          repoPath: project.repoPath,
          signal: abort.signal,
          onProgress: (progress) => send({ type: "progress", progress }),
        });
        send({ type: "result", report });
      } catch (err) {
        if (!abort.signal.aborted) {
          send({ type: "error", error: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        if (!raw.writableEnded) raw.end();
      }
    },
  );
}
