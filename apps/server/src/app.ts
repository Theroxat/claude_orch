import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAgentGateway, registerAgents } from './agents';
import { registerAuth } from './auth';
import type { Config } from './config';
import type { PrismaClient } from './db';
import type { GithubClient } from './github';
import { Dispatcher } from './dispatch/dispatcher';
import { installErrorHandling } from './http/errors';
import { registerOffers } from './offers';
import { registerParticipation } from './participation';
import { registerProjects } from './projects';
import { registerTasks } from './tasks';
import { registerWebhooks } from './webhooks';
import { registerMcp } from './mcp';
import { registerTokens } from './tokens';

declare module 'fastify' {
  interface FastifyInstance {
    dispatcher: Dispatcher;
  }
}

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
    const gateway = createAgentGateway(app, deps);
    const dispatcher = new Dispatcher({ prisma, config, gateway, log: app.log });
    gateway.setDispatcher(dispatcher);
    app.decorate('dispatcher', dispatcher);
    app.addHook('onReady', async () => dispatcher.start());
    // Runs before the gateway's onClose (hooks run in order): no tick sends on closed sockets.
    app.addHook('preClose', async () => dispatcher.stop());
    const m4 = { ...deps, dispatcher, gateway };
    registerAuth(app, deps);
    registerProjects(app, deps);
    registerParticipation(app, m4);
    registerTasks(app, m4);
    registerOffers(app, m4);
    registerWebhooks(app, m4);
    registerTokens(app, deps);
    registerMcp(app, m4);
    app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
    app.register(async (scope) => registerAgents(scope, m4, gateway));
  }

  return app;
}
