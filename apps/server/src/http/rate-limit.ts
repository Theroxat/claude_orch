import { createHash } from 'node:crypto';
import { isIPv6 } from 'node:net';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { HttpError } from './errors';
import { hybridRateLimitStore, type SharedCounter } from './shared-limit';

/**
 * HTTP rate limiting.
 *
 * Where the counters live (several instances behind a load balancer):
 * - `auth` and `agent-connect`: in Postgres, shared by every instance. They stop brute force and
 *   enrollment or sign-in floods, so the limit must hold for the whole deployment; these routes
 *   are rare and already hit the database, so one more upsert costs nothing that matters.
 * - every other tier: in this process. They protect a process from load (a client flooding the
 *   API, a reconnect storm), which is per instance by nature; a client spread over N instances
 *   gets at most N times the limit. The hot path (every API request) stays free of extra queries.
 * Without a database (`counter` absent) everything is in-process.
 *
 * Every route falls in exactly one tier. Counters are per tier and per key:
 * - `api`: everything else, keyed by the signed-in user, else by client IP.
 * - `auth`: sign-in start/callback, access requests, OAuth authorize/token/register/revoke,
 *   agent enrollment, invite links. Keyed by client IP (the caller is not known yet).
 * - `webhook`: GitHub webhook deliveries, by client IP.
 * - `mcp`: the MCP endpoint, by bearer token (hashed), else by IP.
 * - `heavy`: expensive reads (pool view, usage, task history), by user.
 * - `agent-connect`: new agent WebSocket connections, by IP.
 * - `stream`: live-log SSE streams, by user. Counts connection openings, so a reconnect storm
 *   is limited while one long-lived stream costs a single hit.
 * - exempt: health checks and the static files the server hands out (install.sh, compose.yaml).
 *
 * The client IP is `req.ip`, which Fastify derives from X-Forwarded-For only when the peer is in
 * ORCH_TRUST_PROXY (default: private networks, i.e. Caddy). A direct client cannot spoof it.
 */
export type Tier =
  'exempt' | 'api' | 'auth' | 'webhook' | 'mcp' | 'heavy' | 'stream' | 'agent-connect';

const EXEMPT = new Set(['/healthz', '/api/healthz', '/install.sh', '/agent/compose.yaml']);
const AUTH = new Set([
  '/api/auth/github/login',
  '/api/auth/github/callback',
  '/api/auth/access-request',
  '/api/oauth/authorize',
  '/api/oauth/register',
  '/api/oauth/token',
  '/api/oauth/revoke',
  '/api/agents/enroll',
  '/agent/enroll',
  '/invite/:token',
]);

export function tierOf(req: FastifyRequest): Tier {
  const url = req.routeOptions?.url ?? '';
  if (EXEMPT.has(url)) return 'exempt';
  if (AUTH.has(url)) return 'auth';
  if (url === '/api/github/webhook') return 'webhook';
  if (url === '/mcp') return 'mcp';
  if (url === '/agent/ws') return 'agent-connect';
  if (url === '/api/pool') return 'heavy';
  // Routes from PRs that may not be on this branch yet are matched by path pattern (the
  // registered pattern, so query strings, case and trailing slashes cannot change the tier).
  if (/^\/api\/tasks\/:[^/]+\/logs\/stream$/.test(url)) return 'stream';
  if (url === '/api/usage' || url.startsWith('/api/usage/')) return 'heavy';
  if (url === '/api/tasks/history') return 'heavy';
  return 'api';
}

function bearerKey(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return `tok:${createHash('sha256').update(h.slice(7).trim()).digest('hex').slice(0, 32)}`;
}

/** IPv6 clients rotate freely inside their /64: count the whole prefix as one client. */
function clientIp(req: FastifyRequest): string {
  const ip = req.ip;
  if (!isIPv6(ip) || ip.includes('.')) return ip; // IPv4 and IPv4-mapped IPv6
  const groups = ip.includes('::') ? expandV6(ip) : ip.split(':');
  return `${groups.slice(0, 4).join(':')}::/64`;
}

function expandV6(ip: string): string[] {
  const [head = '', tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  return [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
}

/** Counter key for a request: `<tier>:<subject>`. */
export function rateLimitKey(req: FastifyRequest): string {
  const tier = tierOf(req);
  let subject = `ip:${clientIp(req)}`;
  if (tier === 'api' || tier === 'heavy' || tier === 'stream') {
    if (req.user) subject = `user:${req.user.id}`;
  } else if (tier === 'mcp') {
    subject = bearerKey(req) ?? subject;
  }
  return `${tier}:${subject}`;
}

/** Tiers whose counters are shared by every instance (see the header). */
export const SHARED_TIERS: ReadonlySet<Tier> = new Set<Tier>(['auth', 'agent-connect']);

const isSharedKey = (key: string) => SHARED_TIERS.has(key.slice(0, key.indexOf(':')) as Tier);

/**
 * Call right after the session lookup hook is registered (so req.user is known) and before the
 * other plugins/scopes are registered (they inherit the hook).
 */
export function registerRateLimit(
  app: FastifyInstance,
  config: Config,
  counter?: SharedCounter,
): void {
  if (!config.RATE_LIMIT_ENABLED) {
    app.log.warn('RATE_LIMIT_ENABLED=false: HTTP rate limiting is off');
    return;
  }
  const max: Record<Exclude<Tier, 'exempt'>, number> = {
    api: config.RATE_LIMIT_API_MAX,
    auth: config.RATE_LIMIT_AUTH_MAX,
    webhook: config.RATE_LIMIT_WEBHOOK_MAX,
    mcp: config.RATE_LIMIT_MCP_MAX,
    heavy: config.RATE_LIMIT_HEAVY_MAX,
    stream: config.RATE_LIMIT_STREAM_MAX,
    'agent-connect': config.RATE_LIMIT_AGENT_CONNECT_MAX,
  };
  app.register(rateLimit, {
    global: false,
    max: (req: FastifyRequest) => {
      const t = tierOf(req);
      return t === 'exempt' ? Number.MAX_SAFE_INTEGER : max[t];
    },
    timeWindow: config.RATE_LIMIT_WINDOW_SEC * 1000,
    // Bounded in-process store (entries expire with the window, the oldest are evicted past
    // 20 000 keys); shared tiers in Postgres when a database is configured.
    ...(counter ? { store: hybridRateLimitStore(counter, isSharedKey) } : { cache: 20_000 }),
    keyGenerator: rateLimitKey,
    allowList: (req: FastifyRequest) => tierOf(req) === 'exempt',
    // IETF draft headers: RateLimit-Limit / -Remaining / -Reset, plus Retry-After on 429.
    enableDraftSpec: true,
    // Thrown, then rendered by the app error handler in the API's { error: { code, message } } shape.
    errorResponseBuilder: (_req: FastifyRequest, ctx: { ttl: number }) =>
      new HttpError(
        429,
        'rate_limited',
        `Too many requests. Retry in ${Math.max(1, Math.ceil(ctx.ttl / 1000))} s.`,
      ),
  });
  // Once the plugin is loaded (before any later-registered scope is created), add the hook.
  app.after(() => {
    app.addHook('onRequest', app.rateLimit());
    // MCP buckets are per bearer token, so a client spraying random tokens would get a fresh
    // bucket each time. Cap it per IP as well (5x the per-token limit: shared NATs stay fine).
    // (createRateLimit, not a second app.rateLimit hook: the plugin runs once per request.)
    const mcpPerIp = app.createRateLimit({
      max: config.RATE_LIMIT_MCP_MAX * 5,
      keyGenerator: (req: FastifyRequest) => `mcp-ip:${clientIp(req)}`,
    });
    app.addHook('onRequest', async (req, reply) => {
      if (tierOf(req) !== 'mcp') return;
      const r = await mcpPerIp(req);
      if (r.isAllowed || !r.isExceeded) return;
      void reply.header('retry-after', r.ttlInSeconds);
      throw new HttpError(429, 'rate_limited', `Too many requests. Retry in ${r.ttlInSeconds} s.`);
    });
    // A refused WebSocket upgrade must not keep its socket open. @fastify/websocket destroys it
    // in its own onResponse hook, but flags the request in an onRequest hook that runs after the
    // limiter, so a 429 thrown here would otherwise leave the socket dangling. (A successful
    // upgrade is hijacked and never reaches onResponse.)
    app.addHook('onResponse', async (req) => {
      if (req.headers.upgrade?.toLowerCase() === 'websocket') req.raw.socket.destroy();
    });
  });
}
