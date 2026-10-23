import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { PrismaClient } from '../db';
import { HttpError } from '../http/errors';
import { Metrics, statusClass } from './metrics';

export { Metrics, versionLabel } from './metrics';

function tokenMatches(req: FastifyRequest, token: string): boolean {
  const h = req.headers.authorization;
  const given = typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : '';
  // Hash both sides: equal-length buffers, so neither the content nor the token length leaks.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

/**
 * Observability routes and hooks, registered first so every route is measured:
 * - `/metrics` (Prometheus text): 404 unless METRICS_ENABLED=true, bearer METRICS_TOKEN when set.
 *   Never proxied publicly (deploy/server/routes.caddy blocks it).
 * - `/readyz` (the database answers) next to the existing `/healthz` liveness probe.
 */
export function registerObservability(
  app: FastifyInstance,
  { config, prisma, metrics }: { config: Config; prisma?: PrismaClient; metrics: Metrics },
): void {
  app.addHook('onResponse', async (req, reply) => {
    // The route template ("/api/tasks/:id"), never the URL: ids would explode the cardinality.
    const route = req.routeOptions?.url ?? 'unmatched';
    metrics.httpDuration.observe(
      { method: req.method, route, status_class: statusClass(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  const ready = async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      if (prisma) await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready' as const };
    } catch (err) {
      app.log.warn({ err }, 'readiness check failed');
      return reply.status(503).send({ status: 'unavailable' as const });
    }
  };
  app.get('/readyz', ready);
  app.get('/api/readyz', ready);

  app.get('/metrics', async (req, reply) => {
    if (!config.METRICS_ENABLED) throw new HttpError(404, 'not_found', 'Not found');
    if (config.METRICS_TOKEN && !tokenMatches(req, config.METRICS_TOKEN)) {
      reply.header('www-authenticate', 'Bearer');
      throw new HttpError(401, 'unauthorized', 'Invalid metrics token');
    }
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });
}
