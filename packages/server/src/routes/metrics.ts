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
  MetricDimensionSchema,
  MetricFilterSchema,
  MetricQuerySchema,
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

export function registerMetricsRoutes(app: FastifyInstance): void {
  const { metrics } = app.services;

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

  app.get("/api/metrics/stats", async () => metrics.stats());

  app.post<{ Body: unknown }>("/api/metrics/prune", async (req, reply) => {
    const parsed = PruneSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return { deleted: metrics.prune(parsed.data.before) };
  });
}
