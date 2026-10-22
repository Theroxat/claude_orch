import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { createAgentGateway, registerAgents } from './agents';
import { registerAccess } from './access';
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
import { registerOnboarding } from './onboarding';
import { registerOAuth } from './oauth';
import { LiveLogStore, registerLiveLogs } from './logs';

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

/** Logged URL without the query string: it carries the OAuth code and state. */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const i = url.indexOf('?');
  return i < 0 ? url : `${url.slice(0, i)}?[redacted]`;
}

export function buildApp({ config, prisma, github, logStream }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      serializers: {
        req(req: FastifyRequest) {
          return {
            method: req.method,
            url: redactUrl(req.url),
            host: req.host,
            remoteAddress: req.ip,
            remotePort: req.socket?.remotePort,
          };
        },
      },
      ...(logStream ? { stream: logStream } : {}),
    },
    trustProxy: config.ORCH_TRUST_PROXY,
  });
  installErrorHandling(app);

  const version = config.ORCH_VERSION;
  const health = async () => ({ status: 'ok' as const, version });
  app.get('/healthz', health);
  app.get('/api/healthz', health);

  if (prisma) {
    const deps = { config, prisma, github };
    const liveLogs = new LiveLogStore();
    const gateway = createAgentGateway(app, { ...deps, liveLogs });
    const dispatcher = new Dispatcher({ prisma, config, gateway, log: app.log });
    gateway.setDispatcher(dispatcher);
    app.decorate('dispatcher', dispatcher);
    app.addHook('onReady', async () => dispatcher.start());
    // Runs before the gateway's onClose (hooks run in order): no tick sends on closed sockets.
    app.addHook('preClose', async () => dispatcher.stop());
    const m4 = { ...deps, dispatcher, gateway };
    registerAuth(app, deps);
    registerAccess(app, deps);
    registerProjects(app, m4);
    registerParticipation(app, m4);
    registerTasks(app, m4);
    registerLiveLogs(app, { ...deps, liveLogs });
    registerOffers(app, m4);
    registerWebhooks(app, m4);
    registerTokens(app, deps);
    registerOAuth(app, deps);
    registerMcp(app, m4);
    registerOnboarding(app, m4);
    app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
    app.register(async (scope) => registerAgents(scope, m4, gateway));
  }

  return app;
}
