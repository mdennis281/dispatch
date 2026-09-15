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
 * Every body is zod-parsed before it reaches the service, so an unknown
 * dimension is a 400 here rather than a column name deeper in. (The service
 * never interpolates a value into SQL regardless — see `MetricsService.where` —
 * but a schema at the door means the error names the field.)
 */
import type { FastifyInstance } from "fastify";
import * as z from "zod";
import {
  type GrowthFrame,
  MetricDimensionSchema,
  MetricFilterSchema,
  MetricQuerySchema,
  MetricSpanDimensionSchema,
  MetricSpanFilterSchema,
  MetricSpanQuerySchema,
} from "@dispatch/shared";

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

export function registerMetricsRoutes(app: FastifyInstance): void {
  const { metrics, growth } = app.services;
  const { store } = app.cm;

  app.post<{ Body: unknown }>("/api/metrics/series", async (req, reply) => {
    const parsed = MetricQuerySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return metrics.series(parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/totals", async (req, reply) => {
    const parsed = TotalsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return metrics.totals(parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/facets", async (req, reply) => {
    const parsed = ScopeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return metrics.facets(parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/recent", async (req, reply) => {
    const parsed = RecentSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return metrics.recent(parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/spans/series", async (req, reply) => {
    const parsed = MetricSpanQuerySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return metrics.spanSeries(parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/spans/totals", async (req, reply) => {
    const parsed = SpanTotalsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return metrics.spanTotals(parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/spans/summary", async (req, reply) => {
    const parsed = SpanScopeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return metrics.spanSummary(parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/spans/facets", async (req, reply) => {
    const parsed = SpanScopeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return metrics.spanFacets(parsed.data);
  });

  app.post<{ Body: unknown }>("/api/metrics/spans/recent", async (req, reply) => {
    const parsed = SpanRecentSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return metrics.recentSpans(parsed.data);
  });

  // GET, unlike every read above: it takes no query at all. The whole ledger,
  // grouped by chat — see `MetricsService.chatRuntime` for why it isn't
  // `spans/totals` with a `groupBy`.
  app.get("/api/metrics/chat-runtime", async () => metrics.chatRuntime());

  app.get("/api/metrics/stats", async () => metrics.stats());

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
