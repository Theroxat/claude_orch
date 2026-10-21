import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAgentGateway, registerAgents } from './agents';
import { registerAuth } from './auth';
import type { Config } from './config';
import type { PrismaClient } from './db';
import type { GithubClient } from './github';
import { installErrorHandling } from './http/errors';
import { registerParticipation } from './participation';
import { registerProjects } from './projects';

export interface AppDeps {
  config: Config;
  prisma?: PrismaClient;
  github?: GithubClient;
  /** Test hook: where pino writes (with config.LOG_LEVEL). */
  logStream?: { write(msg: string): void };
}

export function buildApp({ config, prisma, github, logStream }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, ...(logStream ? { stream: logStream } : {}) },
    trustProxy: true,
  });
  installErrorHandling(app);

  const health = async () => ({ status: 'ok' as const });
  app.get('/healthz', health);
  app.get('/api/healthz', health);

  if (prisma) {
    const deps = { config, prisma, github };
    registerAuth(app, deps);
    registerProjects(app, deps);
    registerParticipation(app, deps);
    const gateway = createAgentGateway(app, deps);
    app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
    app.register(async (scope) => registerAgents(scope, deps, gateway));
  }

  return app;
}
