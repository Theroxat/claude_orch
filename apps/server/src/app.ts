import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import type { PrismaClient } from './db';

export interface AppDeps {
  config: Config;
  prisma?: PrismaClient;
}

export function buildApp({ config }: AppDeps): FastifyInstance {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });

  const health = async () => ({ status: 'ok' as const });
  app.get('/healthz', health);
  app.get('/api/healthz', health);

  return app;
}
