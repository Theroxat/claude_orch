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
import { registerRateLimit } from './http/rate-limit';
import { registerOffers } from './offers';
import { registerParticipation } from './participation';
import { registerProjects } from './projects';
import { registerTasks } from './tasks';
import { registerTemplates } from './templates';
import { registerWebhooks } from './webhooks';
import { registerMcp } from './mcp';
import { registerTokens } from './tokens';
import { registerOnboarding } from './onboarding';
import { registerOAuth } from './oauth';
import { registerUsage } from './usage/dashboard';
import { LiveLogStore, registerLiveLogs } from './logs';
import { Metrics, registerObservability } from './observability';
import { Notifier, registerNotifications } from './notifications';
import { recipientCheck } from './notifications/access';
import type { Mailer } from './notifications/service';
import type { PushSender } from './notifications/push';
import type { WebhookPoster } from './notifications/ssrf';

declare module 'fastify' {
  interface FastifyInstance {
    dispatcher: Dispatcher;
    notifier: Notifier;
  }
}

export interface AppDeps {
  config: Config;
  prisma?: PrismaClient;
  github?: GithubClient;
  /** Test hook: where pino writes (with config.LOG_LEVEL). */
  logStream?: { write(msg: string): void };
  /** Test hooks: webhook HTTP client, e-mail transport and Web Push sender of the notifier. */
  notify?: { post?: WebhookPoster; mailer?: Mailer | null; pusher?: PushSender | null };
}

/** Logged URL without the query string: it carries the OAuth code and state. */
export function redactUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const i = url.indexOf('?');
  return i < 0 ? url : `${url.slice(0, i)}?[redacted]`;
}

export function buildApp({ config, prisma, github, logStream, notify }: AppDeps): FastifyInstance {
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
    // Explicit default (1 MiB); routes that take less set their own lower limit.
    bodyLimit: 1024 * 1024,
  });
  installErrorHandling(app);
  const metrics = new Metrics(config.ORCH_VERSION);
  registerObservability(app, { config, prisma, metrics });

  const version = config.ORCH_VERSION;
  const health = async () => ({ status: 'ok' as const, version });
  app.get('/healthz', health);
  app.get('/api/healthz', health);

  if (prisma) {
    const deps = { config, prisma, github, metrics };
    const liveLogs = new LiveLogStore();
    const gateway = createAgentGateway(app, { ...deps, liveLogs });
    const dispatcher = new Dispatcher({ prisma, config, gateway, log: app.log, metrics });
    gateway.setDispatcher(dispatcher);
    metrics.attach({ prisma, log: app.log, agentVersions: () => gateway.connectedByVersion() });
    app.decorate('dispatcher', dispatcher);
    const notifier = new Notifier({
      prisma,
      config,
      log: app.log,
      // `app.allowlist` is registered later (registerAuth): resolved at call time.
      canReceive: recipientCheck({
        prisma,
        github,
        isAllowed: async (user) => (await app.allowlist.check(user)) === 'allowed',
      }),
      ...notify,
    });
    app.decorate('notifier', notifier);
    app.addHook('onReady', async () => notifier.start());
    app.addHook('onClose', async () => notifier.stop());
    app.addHook('onReady', async () => dispatcher.start());
    // Runs before the gateway's onClose (hooks run in order): no tick sends on closed sockets.
    app.addHook('preClose', async () => dispatcher.stop());
    const m4 = { ...deps, dispatcher, gateway };
    registerAuth(app, deps);
    // After the session lookup hook: requests are keyed by user id when signed in.
    registerRateLimit(app, config);
    registerAccess(app, deps);
    registerProjects(app, m4);
    registerParticipation(app, m4);
    registerTasks(app, m4);
    registerTemplates(app, deps);
    registerLiveLogs(app, { ...deps, liveLogs });
    registerOffers(app, m4);
    registerWebhooks(app, m4);
    registerTokens(app, deps);
    registerOAuth(app, deps);
    registerMcp(app, m4);
    registerOnboarding(app, m4);
    registerUsage(app, deps);
    registerNotifications(app, { ...deps, notifier });
    app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
    app.register(async (scope) => registerAgents(scope, m4, gateway));
  }

  return app;
}
